import { Prisma, PrismaClient } from '@prisma/client';
import {
  MEDIA_INSPECTOR_VERSION,
  MediaInspectorService,
  defaultMediaProbeRunner,
} from '../assets/media-inspector.service';
import type { MediaMetadata } from '../assets/assets.service';
import type { AssetPresignService as PresignService } from '../assets/asset-presign.service';

/**
 * 资产重检：把"按旧版检查器算出来的" media_metadata 刷成当前口径。
 *
 * 为什么需要：资产是内容寻址复用的，同一个文件不会因为检查器升级而重新检查，于是库里会
 * 留下与客户端新口径对不上的旧值，正式提交按摘要逐字段比对就会莫名失败（2026-09-16 踩到）。
 * 所以检查器版本号一变，就该跑一次本工具；`apply=false`（默认）只报告、不写库，先看清楚
 * 要动哪些行。
 *
 * 用法：`npm run build && npm run assets:reinspect -- [--apply]`（要 OSS_* 环境变量）。
 */

export type ReinspectableAsset = {
  id: string;
  objectKey: string;
  inspectorVersion: string | null;
};

export type ReinspectionPlan = {
  version: string;
  stale: ReinspectableAsset[];
  upToDate: number;
};

export type ReinspectionResult = {
  id: string;
  status: 'reinspected' | 'skipped' | 'failed';
  reason?: string;
};

export type ReinspectionSummary = {
  version: string;
  scanned: number;
  stale: number;
  applied: boolean;
  results: ReinspectionResult[];
};

export function planReinspection(
  assets: ReinspectableAsset[],
  version: string = MEDIA_INSPECTOR_VERSION,
): ReinspectionPlan {
  // 版本对不上就重检，**包括**没记版本的老资产（null）——它们同样是旧口径的产物。
  const stale = assets.filter((asset) => asset.inspectorVersion !== version);
  return { version, stale, upToDate: assets.length - stale.length };
}

export async function reinspectAssets(
  assets: ReinspectableAsset[],
  options: {
    inspect: (objectKey: string) => Promise<MediaMetadata>;
    save?: (id: string, update: { mediaMetadata: MediaMetadata; inspectorVersion: string }) => Promise<void>;
    version?: string;
    apply?: boolean;
  },
): Promise<ReinspectionSummary> {
  const version = options.version ?? MEDIA_INSPECTOR_VERSION;
  const apply = options.apply === true;
  const plan = planReinspection(assets, version);
  const results: ReinspectionResult[] = [];

  for (const asset of plan.stale) {
    try {
      const mediaMetadata = await options.inspect(asset.objectKey);
      if (apply) {
        if (!options.save) throw new Error('SAVE_UNAVAILABLE');
        await options.save(asset.id, { mediaMetadata, inspectorVersion: version });
      }
      results.push({ id: asset.id, status: 'reinspected' });
    } catch (error) {
      // 单个资产失败不能中断整轮：剩下的多半没问题，失败的列出来人工看。
      results.push({ id: asset.id, status: 'failed', reason: (error as Error)?.message ?? 'REINSPECTION_FAILED' });
    }
  }

  return { version, scanned: assets.length, stale: plan.stale.length, applied: apply, results };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(
      'Usage: npm run build && npm run assets:reinspect -- [--apply]\n' +
      'Requires OSS_BUCKET, OSS_REGION, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET.\n' +
      'Default is read-only dry-run: it still probes every stale asset (that is where the time\n' +
      'goes) but writes nothing. --apply writes the fresh mediaMetadata and inspectorVersion.\n' +
      'In scope: assets that already carry media_metadata. One that was never inspected has\n' +
      'nothing to refresh, and inventing metadata for it is not this tool\'s job.\n',
    );
    return;
  }
  const apply = process.argv.includes('--apply');

  // 复用应用自己那条路：给资产签一个 GET URL，再让 ffprobe 去拉。这样重检算出来的口径与
  // 线上正式提交时**同源**——这里要是另写一套取文件的方式，就又多了一个可能对不上的地方，
  // 而"对不上"正是这个工具要消灭的东西。
  //
  // 按需 require：AssetPresignService 会 require('ali-oss')，而 ali-oss 发的是 Jest 解析不了
  // 的 ESM 形状。放到这里，本文件才能被 spec 引入而不必 mock 掉它——与 asset-hash-backfill
  // 里 `require('ali-oss')` 同一个理由。
  const { AssetPresignService } = require('../assets/asset-presign.service') as {
    AssetPresignService: new () => PresignService;
  };
  const presign = new AssetPresignService();
  if (!presign.isConfigured()) {
    throw new Error(
      'OSS_BUCKET, OSS_REGION, OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET are required',
    );
  }
  const inspector = new MediaInspectorService(defaultMediaProbeRunner);

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.asset.findMany({
      where: { mediaMetadata: { not: Prisma.DbNull } },
      select: { id: true, objectKey: true, inspectorVersion: true },
      orderBy: { createdAt: 'asc' },
    });

    const summary = await reinspectAssets(rows, {
      inspect: (objectKey) => inspector.inspect(presign.createDownloadUrl(objectKey).downloadUrl),
      save: async (id, update) => {
        await prisma.asset.update({ where: { id }, data: update });
      },
      apply,
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
