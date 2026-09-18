import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ArkAssetLibraryService, ArkAssetSummary } from './ark-asset-library.service';
import { ASSET_LIBRARY } from './asset-library-contract';
import { AssetPresignService } from './asset-presign.service';
import { MediaMetadata } from './assets.service';
import { SEEDANCE_INPUT_MEDIA_POLICIES, seedanceMediaSizeAllowed, validateSeedanceMediaMetadata } from './media-policy';
import { MediaInspectorService, MEDIA_INSPECTOR_VERSION } from './media-inspector.service';

const MEDIA_KIND_BY_ASSET_TYPE: Record<string, MediaMetadata['kind']> = {
  Image: 'image',
  Video: 'video',
  Audio: 'audio',
};
const ARK_ASSET_TYPE_BY_MEDIA_TYPE: Record<string, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
};

/** 取回来的那份字节的 sha256。与 `Asset.fileHash` 同一口径（内容寻址全靠它）。 */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 对象键 `inputs/<actor>/<uuid>-名字.png` → 给人看的「名字」。 */
function displayName(objectKey: string): string {
  const base = objectKey.split('/').pop() ?? objectKey;
  return base.replace(/^[0-9a-f-]{36}-/i, '').replace(/\.[^.]+$/, '') || base;
}

// 取字节的上限：与合同里各模态的上限同量级，防的是"素材库里那条记录指向一个想撑爆内存的地址"。
// 一次性读进 Buffer 而不是流式：素材库目前的主用途是人像图（几百 KB），代价可接受。
// 真要用它接大视频时再换流式——那时这个上限就是第一个该动的地方。
const MAX_MATERIALIZE_BYTES = 200 * 1024 * 1024;

/** 登记失败。`code` 会原样交给客户端，`message` 只在用户需要知道下一步做什么时才写。 */
export class ArkIngestError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'ArkIngestError';
  }
}

/**
 * 把方舟素材库里的一份素材登记成我方 Asset。
 *
 * 为什么要在我方也留一行、还要把字节取回来：`assets.object_key` 是非空列，"这一行有字节"
 * 是整条链路（内容寻址复用、逐字段比对、重检工具）依赖的不变量。而且 **GetAsset 不返回
 * 尺寸与时长**——视频时长直接进计费公式，拿不到就是预占系统性低估。
 *
 * 生成时送的仍然是 `asset://<asset ID>`，不是我方 OSS 地址：含真人人脸的素材直传会被方舟
 * 输入审核拦下。我方的副本只用于检查与登记，从不外发。
 */
@Injectable()
export class ArkAssetIngestService {
  private readonly logger = new Logger(ArkAssetIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ark: ArkAssetLibraryService,
    private readonly inspector: MediaInspectorService,
    private readonly presign: AssetPresignService,
  ) {}

  async materialize(ownerId: string, arkAssetId: string) {
    const projectName = ASSET_LIBRARY.projectName;

    const existing = await this.findExisting(ownerId, arkAssetId);
    if (existing) return existing;

    const remote = await this.requireUsableAsset(arkAssetId, projectName);
    const declaredKind = MEDIA_KIND_BY_ASSET_TYPE[remote.assetType];
    if (!declaredKind) {
      throw new ArkIngestError(
        'ARK_ASSET_TYPE_UNSUPPORTED',
        `素材库里这份素材的类型是 ${remote.assetType}，目前只支持图像、视频、音频。`,
      );
    }

    const bytes = await this.fetchBytes(remote.url!);
    // 检查走方舟给的地址：GetAsset 不返回尺寸与时长，这些只能自己探。
    const { metadata, mimeType } = await this.inspector.inspectWithMime(remote.url!);
    if (metadata.kind !== declaredKind) {
      throw new ArkIngestError(
        'ARK_ASSET_TYPE_MISMATCH',
        `素材库里标的是 ${remote.assetType}，实际探出来是 ${metadata.kind}，两边对不上，不登记。`,
      );
    }
    this.assertWithinPolicy(mimeType, metadata, bytes.length);

    // 对象的 sha256 已经算出来了，先看**同一份内容是不是已经有一行**。
    //
    // 内容寻址让「先当本机文件传上来、之后又入库」的两条路径落在同一行上
    // （`@@unique([ownerId, role, fileHash])`）。这种情况下不能再建一行（会撞唯一约束），
    // 而要**把方舟那份的关联认领到这行上**。2026-09-17 真实踩到：用户先前把图作为本机文件
    // 传过、又入库了，但那次入库没写回关联，于是登记时既找不到关联、又撞约束，彻底卡死。
    const sameContent = await this.prisma.asset.findFirst({
      where: { ownerId, role: 'input', fileHash: sha256Of(bytes) },
    });
    if (sameContent) {
      const link = { arkAssetId, arkGroupId: remote.groupId || null, arkAssetStatus: remote.status };
      await this.recordArkLink(sameContent.id, link);
      return { ...sameContent, ...link };
    }

    // 对象键由 arkAssetId 决定，不用随机值：两个并发的重复登记会写同一个键（内容相同，
    // 后写覆盖先写，结果一致），失败方不会在桶里留下垃圾对象。
    const objectKey = `inputs/${ownerId}/ark-${arkAssetId}`;
    const { sizeBytes, fileHash } = await this.presign.putObject(objectKey, bytes, mimeType);

    try {
      return await this.prisma.asset.create({
        data: {
          ownerId,
          role: 'input',
          mediaType: metadata.kind,
          bucket: this.presign.getBucketName(),
          objectKey,
          mimeType,
          sizeBytes: BigInt(sizeBytes),
          fileHash,
          mediaMetadata: metadata as Prisma.InputJsonValue,
          inspectionStatus: 'verified',
          inspectorVersion: MEDIA_INSPECTOR_VERSION,
          arkAssetId,
          arkGroupId: remote.groupId || null,
          arkAssetStatus: remote.status,
          arkAssetStatusCheckedAt: new Date(),
        },
      });
    } catch (error) {
      // 并发竞争由数据库的唯一约束裁决，失败方回读胜者——这是既有上传路径的同一条规矩：
      // 正常的幂等竞争不该暴露成 500。用唯一约束而不是事务级 advisory lock，是因为登记
      // 全程有网络调用，把锁跨网络持有等于让数据库事务陪着等几个网络往返。
      //
      // **两个唯一约束都要认**：arkAssetId（并发的重复登记）与本行的
      // (ownerId, role, fileHash)（同一份内容的行刚好在上面的检查之后被建出来）。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findExisting(ownerId, arkAssetId)
          ?? await this.prisma.asset.findFirst({ where: { ownerId, role: 'input', fileHash: sha256Of(bytes) } });
        if (winner) {
          const link = { arkAssetId, arkGroupId: remote.groupId || null, arkAssetStatus: remote.status };
          await this.recordArkLink(winner.id, link);
          return { ...winner, ...link };
        }
      }
      throw error;
    }
  }

  /**
   * 把**我方已经收下的一份素材**推给方舟入库，返回它在那边的素材 ID。
   *
   * 这是「从客户端上传素材到素材库」的那条路：字节已经在我们的对象存储里（客户端走
   * 既有的上传票据放的），这里只需要给方舟一个取得到的地址。实测方舟在 CreateAsset
   * 那一刻就拉取，所以签名用默认的短有效期即可。
   *
   * 幂等：已经入过库的直接返回，不会重复建素材、白占配额。
   */
  async publish(ownerId: string, assetId: string, options: { groupId?: string } = {}) {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, ownerId, role: 'input', inspectionStatus: 'verified' },
    });
    if (!asset) {
      throw new ArkIngestError(
        'ARK_PUBLISH_ASSET_NOT_FOUND',
        '这份素材不在你名下、或还没通过检查，不能入库。',
      );
    }
    if (asset.arkAssetId) return asset; // 已经入过库
    const assetType = ARK_ASSET_TYPE_BY_MEDIA_TYPE[String(asset.mediaType)];
    if (!assetType || !asset.objectKey) {
      throw new ArkIngestError('ARK_PUBLISH_ASSET_UNSUPPORTED', '这份素材的类型不支持入库。');
    }

    // 一个素材组代表一个形象（真人人像库更是强制：一个组唯一绑定一个人），所以默认
    // **一次上传建一个组**，让同一个人后续加的妆造有地方放。
    const groupId = options.groupId?.trim()
      || await this.ark.createAssetGroup(displayName(asset.objectKey), '由 Video Flow 上传');

    const arkAssetId = await this.ark.createAsset({
      groupId,
      url: this.presign.createDownloadUrl(asset.objectKey).downloadUrl,
      assetType,
      name: displayName(asset.objectKey),
    });

    // **CreateAsset 一返回就落库，不要等轮询结束。** 那一刻方舟那边已经有这份素材了，
    // 而轮询是网络操作、随时可能抖。等到最后才写的话，中间任何一次失败都会留下
    // 「方舟有、我方没有」的孤儿：用户再选它去登记时找不到这条关联，又因为内容寻址
    // 撞上唯一约束，彻底卡死（2026-09-17 真实踩到）。
    await this.recordArkLink(asset.id, { arkAssetId, arkGroupId: groupId, arkAssetStatus: 'Processing' });

    const active = await this.ark.waitForAssetActive(arkAssetId);
    const linked = { arkAssetId, arkGroupId: active.groupId || groupId, arkAssetStatus: active.status };
    await this.recordArkLink(asset.id, linked);
    return { ...asset, ...linked };
  }

  /** 记下「我方这一行 ↔ 方舟那一份」的关联。方舟侧一有 ID 就该写，不等后续步骤。 */
  private recordArkLink(
    assetId: string,
    link: { arkAssetId: string; arkGroupId: string; arkAssetStatus: string },
  ) {
    return this.prisma.asset.updateMany({
      where: { id: assetId },
      data: { ...link, arkAssetStatusCheckedAt: new Date() },
    });
  }

  private async findExisting(ownerId: string, arkAssetId: string) {
    return this.prisma.asset.findFirst({ where: { ownerId, role: 'input', arkAssetId } });
  }

  private async requireUsableAsset(arkAssetId: string, projectName: string): Promise<ArkAssetSummary> {
    let remote: ArkAssetSummary;
    try {
      remote = await this.ark.getAsset(arkAssetId, projectName);
    } catch (error) {
      throw new ArkIngestError(
        'ARK_ASSET_UNREACHABLE',
        `查不到素材 ${arkAssetId}：它可能不属于这个账号，或者素材库暂时不可用。`,
      );
    }
    if (remote.status !== 'Active') {
      throw new ArkIngestError(
        'ARK_ASSET_NOT_ACTIVE',
        `素材 ${arkAssetId} 当前状态是 ${remote.status || '未知'}，只有 Active 才能用于生成`
        + `（刚上传的素材要等预处理完成）。`,
      );
    }
    if (remote.projectName !== projectName) {
      // 提前挡在这里：跨项目用素材在方舟侧要等到生成任务才失败，最难查。
      throw new ArkIngestError(
        'ARK_ASSET_PROJECT_MISMATCH',
        `素材 ${arkAssetId} 属于项目 ${remote.projectName}，而本系统用的是 ${projectName}。`
        + `方舟按项目隔离素材，跨项目用不了。`,
      );
    }
    if (!remote.url) {
      throw new ArkIngestError('ARK_ASSET_URL_MISSING', `方舟没有给出素材 ${arkAssetId} 的地址，无法取回检查。`);
    }
    return remote;
  }

  private async fetchBytes(url: string): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      throw new ArkIngestError('ARK_ASSET_FETCH_FAILED', '取素材字节失败，请稍后重试。');
    }
    if (!response.ok) {
      throw new ArkIngestError('ARK_ASSET_FETCH_FAILED', `取素材字节失败（HTTP ${response.status}）。`);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MATERIALIZE_BYTES) {
      throw new ArkIngestError('ARK_ASSET_TOO_LARGE', `素材有 ${declaredLength} 字节，超过本系统能处理的上限。`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new ArkIngestError('ARK_ASSET_EMPTY', '取回来的素材是空的。');
    if (bytes.length > MAX_MATERIALIZE_BYTES) {
      throw new ArkIngestError('ARK_ASSET_TOO_LARGE', '素材超过本系统能处理的上限。');
    }
    return bytes;
  }

  /** 与常规上传走同一套限制：官方对素材的尺寸/时长/编码要求不因来源而不同。 */
  private assertWithinPolicy(mimeType: string, metadata: MediaMetadata, sizeBytes: number) {
    const policy = SEEDANCE_INPUT_MEDIA_POLICIES[mimeType.split(';')[0].trim().toLowerCase()];
    if (!policy) throw new ArkIngestError('ARK_ASSET_FORMAT_INVALID', `素材库这份素材的格式不受支持（${mimeType}）。`);
    if (!seedanceMediaSizeAllowed(policy, sizeBytes)) {
      throw new ArkIngestError('ARK_ASSET_SIZE_INVALID', '素材库这份素材的体积超出官方允许的上限。');
    }
    try {
      validateSeedanceMediaMetadata(mimeType, metadata, sizeBytes);
    } catch (error) {
      throw new ArkIngestError('ARK_ASSET_METADATA_INVALID', `素材库这份素材不符合官方限制：${(error as Error).message}`);
    }
  }
}
