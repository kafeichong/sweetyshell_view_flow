import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ASSET_LIBRARY } from './asset-library-contract';
import { buildVolcengineSignedRequest, VolcengineCredentials } from '../integrations/volcengine-signer';

// 火山方舟「私域素材库」的 Access Key 通道。与视频生成用的 API Key 是**两套鉴权**：
// 生成走 bearer token，素材库走 AK/SK 签名（服务名 ark、动作走 2024-01-01 版本）。
// 详见 docs/runbooks/ark-asset-library-credentials.md。
const HOST = 'ark.cn-beijing.volcengineapi.com';
const REGION = 'cn-beijing';
const SERVICE = 'ark';
const API_VERSION = '2024-01-01';
const DEFAULT_CREDENTIALS_FILE = join(homedir(), '.video-flow', 'ark-asset-credentials');

/** 素材库里一条素材的最小事实集。字段名对应 GetAsset/ListAssets 的返回体。 */
export type ArkAssetSummary = {
  id: string;
  name: string;
  assetType: string;
  status: string;
  groupId: string;
  projectName: string;
  /** 方舟自己的签名地址。**只用来取字节做检查，绝不写进日志或错误信息。** */
  url: string | null;
};

type ArkCredentials = VolcengineCredentials;

@Injectable()
export class ArkAssetLibraryService {
  private readonly logger = new Logger(ArkAssetLibraryService.name);

  /** 有没有配凭证（**不代表**当前环境允许用——见 requireCredentials）。 */
  hasCredentials(): boolean {
    return this.readCredentials() !== null;
  }

  isConfigured(): boolean {
    return process.env.VIDEO_FLOW_TEST_MODE !== '1' && this.hasCredentials();
  }

  async getAsset(assetId: string, projectName: string): Promise<ArkAssetSummary> {
    const result = await this.call<Record<string, unknown>>('GetAsset', { Id: assetId, ProjectName: projectName });
    return toSummary(result);
  }

  async listAssets(options: { groupType: string; groupId?: string; maxResults?: number }): Promise<ArkAssetSummary[]> {
    const filter: Record<string, unknown> = { GroupType: options.groupType };
    if (options.groupId) filter.GroupIds = [options.groupId];
    const result = await this.call<{ Items?: Record<string, unknown>[] }>('ListAssets', {
      Filter: filter,
      MaxResults: options.maxResults ?? 20,
    });
    return (result.Items ?? []).map(toSummary);
  }

  async createAssetGroup(name: string, description: string): Promise<string> {
    const result = await this.call<{ Id?: string }>('CreateAssetGroup', {
      Name: name,
      Description: description,
      ProjectName: ASSET_LIBRARY.projectName,
    });
    if (!result.Id) throw new ServiceUnavailableException('ARK_ASSET_LIBRARY_ERROR:CreateAssetGroupNoId');
    return result.Id;
  }

  /**
   * 把一份可访问的对象交给方舟入库。
   *
   * `url` 用**默认的短有效期**即可：2026-09-17 真实账号实测表明方舟在创建那一刻就拉取
   * 对象（Processing → Active 用了 6.1 秒）。**不要**因为"这是异步接口"就去签一个长期
   * 地址——那等于给一张人脸图开一个长期可读的口子，而实测根本没有这个必要。
   */
  async createAsset(input: { groupId: string; url: string; assetType: string; name: string }): Promise<string> {
    const result = await this.call<{ Id?: string }>('CreateAsset', {
      GroupId: input.groupId,
      URL: input.url,
      AssetType: input.assetType,
      Name: input.name,
      ProjectName: ASSET_LIBRARY.projectName,
    });
    if (!result.Id) throw new ServiceUnavailableException('ARK_ASSET_LIBRARY_ERROR:CreateAssetNoId');
    return result.Id;
  }

  /**
   * 轮询到 Active 或 Failed，或者超时。
   *
   * 官方**没有给全状态枚举**，所以"不认识的状态"一律当作"还没好"继续等——绝不能把未知
   * 当成 Active 放行：那样用户会拿一份尚未入库的素材去生成，方舟拦下，钱白花。
   */
  async waitForAssetActive(assetId: string, timeoutMs = 120_000): Promise<ArkAssetSummary> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const asset = await this.getAsset(assetId, ASSET_LIBRARY.projectName);
      if (asset.status === 'Active') return asset;
      if (asset.status === 'Failed') {
        throw new ServiceUnavailableException('ARK_ASSET_LIBRARY_ERROR:AssetProcessingFailed');
      }
      if (Date.now() >= deadline) {
        throw new ServiceUnavailableException(`ARK_ASSET_LIBRARY_ERROR:AssetStillProcessing:${asset.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  private readCredentials(): ArkCredentials | null {
    const inlineId = process.env.ARK_ASSET_ACCESS_KEY_ID?.trim();
    const inlineSecret = process.env.ARK_ASSET_ACCESS_KEY_SECRET?.trim();
    if (inlineId && inlineSecret) return { accessKeyId: inlineId, secretAccessKey: inlineSecret };

    const file = process.env.ARK_ASSET_CREDENTIALS_FILE?.trim() || DEFAULT_CREDENTIALS_FILE;
    try {
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length >= 2) return { accessKeyId: lines[0], secretAccessKey: lines[1] };
    } catch {
      // 文件不存在/读不到就是"没配"，由调用方 fail-closed，不在这里抛。
    }
    return null;
  }

  private requireCredentials(): ArkCredentials {
    // 与 Worker 的 REAL_PROVIDER_CREDENTIAL_FORBIDDEN 同一条规矩：合同/验收环境里出现
    // 真实凭证就直接失败，而不是"碰巧没用到"。素材库的 AK 是**全账号级**的（能建删素材组），
    // 比生成用的 API Key 危险得多，更不能让它跟着测试环境跑起来。
    if (process.env.VIDEO_FLOW_TEST_MODE === '1' && this.hasCredentials()) {
      throw new ServiceUnavailableException('REAL_PROVIDER_CREDENTIAL_FORBIDDEN');
    }
    const credentials = this.readCredentials();
    if (!credentials) throw new ServiceUnavailableException('ARK_ASSET_LIBRARY_NOT_CONFIGURED');
    return credentials;
  }

  private async call<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const credentials = this.requireCredentials();
    const request = buildSignedRequest(credentials, action, body, formatXDate(new Date()));
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.payload,
    });

    const text = await response.text();
    let parsed: Record<string, any> | null = null;
    try {
      parsed = JSON.parse(text) as Record<string, any>;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const code = parsed?.ResponseMetadata?.Error?.Code ?? `HTTP_${response.status}`;
      // 只带方舟给的原因码。**这条 message 会原样回到客户端**，所以既不塞请求体也不塞
      // 任何带签名的地址——历史上已经踩过反方向的坑（错误信息丢原因），别再踩这一侧。
      this.logger.warn(`Ark asset library ${action} failed: ${code}`);
      throw new ServiceUnavailableException(`ARK_ASSET_LIBRARY_ERROR:${code}`);
    }

    return (parsed?.Result ?? parsed ?? {}) as T;
  }
}

/**
 * Ark 素材库服务的签名包装器。
 *
 * 内部调用通用 volcengine-signer，固定 Ark 服务的 host、region、service 和 version。
 * 保持原有函数签名以兼容现有调用方。
 */
export function buildSignedRequest(
  credentials: ArkCredentials,
  action: string,
  body: Record<string, unknown>,
  xDate: string,
): { url: string; headers: Record<string, string>; payload: string } {
  return buildVolcengineSignedRequest({
    credentials,
    host: HOST,
    region: REGION,
    service: SERVICE,
    action,
    version: API_VERSION,
    body,
    xDate,
  });
}

function toSummary(raw: Record<string, unknown>): ArkAssetSummary {
  return {
    id: String(raw.Id ?? ''),
    name: String(raw.Name ?? ''),
    assetType: String(raw.AssetType ?? ''),
    status: String(raw.Status ?? ''),
    groupId: String(raw.GroupId ?? ''),
    projectName: String(raw.ProjectName ?? ''),
    url: typeof raw.URL === 'string' && raw.URL ? raw.URL : null,
  };
}

function formatXDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}
