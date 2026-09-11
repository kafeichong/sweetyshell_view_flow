/**
 * Production 准入策略。
 *
 * 默认关闭：只有显式列在 `VIDEO_FLOW_PRODUCTION_ACTORS` 里的 actor 才能创建
 * 真实付费任务。这实现了架构基线里的"灰度"要求——Production 不是靠客户端
 * 自律关闭，而是服务端按身份白名单开放，且可以随时通过改环境变量收回。
 *
 * 未配置该变量时，Production 对所有人关闭（安全默认值）。
 */
export const PRODUCTION_ACTORS_ENV = 'VIDEO_FLOW_PRODUCTION_ACTORS';

export function parseProductionActors(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isProductionAllowed(
  actorId: string,
  raw: string | undefined = process.env[PRODUCTION_ACTORS_ENV],
): boolean {
  if (!actorId) {
    return false;
  }

  return parseProductionActors(raw).includes(actorId);
}
