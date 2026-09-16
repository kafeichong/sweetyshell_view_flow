import { MEDIA_INSPECTOR_VERSION } from '../assets/media-inspector.service';
import type { MediaMetadata } from '../assets/assets.service';

/**
 * 资产重检：把"按旧版检查器算出来的" media_metadata 刷成当前口径。
 *
 * 为什么需要：资产是内容寻址复用的，同一个文件不会因为检查器升级而重新检查，于是库里会
 * 留下与客户端新口径对不上的旧值，正式提交按摘要逐字段比对就会莫名失败（2026-09-16 踩到）。
 * 所以检查器版本号一变，就该跑一次本工具；`apply=false`（默认）只报告、不写库，先看清楚
 * 要动哪些行。
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
