import { BadRequestException } from '@nestjs/common';

/**
 * Preview 的执行契约。
 *
 * Preview 只做服务端请求校验并返回请求摘要，永远不创建 ExecutionAttempt、
 * 永远不调用 Provider。对应任务以 `status='preview'` 落库，而 Worker 的
 * claim 只领取 `status='pending'`，因此 Preview 任务在结构上不可被领取。
 */
export const PREVIEW_ALLOWED_CAPABILITIES = ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO'] as const;

// 第一版只支持 Seedance；profile 允许 `seedance` 或 `seedance-xxx` 形态。
const PREVIEW_PROFILE_PREFIX = 'seedance';

const MAX_PROMPT_LENGTH = 4000;
const MAX_PARAMS_BYTES = 64 * 1024;

export type PreviewPlan = {
  mode: 'preview';
  capability: string;
  profile: string;
  provider: string;
  prompt: string;
  model: string | null;
  duration: number | null;
  ratio: string | null;
  inputAssetId: string | null;
  inputImageUrl: string | null;
  estimatedCostCny: null;
  costStatus: 'unavailable';
  willCallProvider: false;
};

export type PreviewRequest = {
  capability?: unknown;
  profile?: unknown;
  params?: unknown;
};

function readPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed > 0 ? parsed : null;
  }
  return null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 校验创建任务的请求。Preview 和 Production 共用同一套校验，
 * 避免"只校验预览、生产却不校验"的缺口。
 */
export function validateTaskRequest(body: PreviewRequest): {
  capability: string;
  profile: string;
  prompt: string;
  params: Record<string, unknown>;
} {
  const capability = readNonEmptyString(body?.capability);
  if (!capability) {
    throw new BadRequestException('capability is required');
  }
  if (!(PREVIEW_ALLOWED_CAPABILITIES as readonly string[]).includes(capability)) {
    throw new BadRequestException(
      `capability must be one of ${PREVIEW_ALLOWED_CAPABILITIES.join(', ')}`,
    );
  }

  const profile = readNonEmptyString(body?.profile);
  if (!profile) {
    throw new BadRequestException('profile is required');
  }
  if (profile.split('-')[0] !== PREVIEW_PROFILE_PREFIX) {
    throw new BadRequestException(`profile must start with "${PREVIEW_PROFILE_PREFIX}"`);
  }

  if (!body?.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
    throw new BadRequestException('params must be an object');
  }

  const params = body.params as Record<string, unknown>;
  if (JSON.stringify(params).length > MAX_PARAMS_BYTES) {
    throw new BadRequestException('params is too large');
  }

  const prompt = readNonEmptyString(params.prompt);
  if (!prompt) {
    throw new BadRequestException('params.prompt is required');
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new BadRequestException(`params.prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
  }

  if (capability === 'IMAGE_TO_VIDEO') {
    const hasAsset = Boolean(readNonEmptyString(params.image_asset_id));
    const hasUrl = Boolean(readNonEmptyString(params.image_url));
    if (!hasAsset && !hasUrl) {
      throw new BadRequestException(
        'IMAGE_TO_VIDEO requires params.image_asset_id or params.image_url',
      );
    }
  }

  return { capability, profile, prompt, params };
}

/**
 * 构造返回给客户端的请求摘要。Preview 阶段无法给出可靠报价，
 * 因此费用必须显式表达为 unavailable，而不是 0。
 */
export function buildPreviewPlan(body: PreviewRequest): PreviewPlan {
  const { capability, profile, prompt, params } = validateTaskRequest(body);

  return {
    mode: 'preview',
    capability,
    profile,
    provider: profile.split('-')[0],
    prompt,
    model: readNonEmptyString(params.model),
    duration: readPositiveInt(params.duration),
    ratio: readNonEmptyString(params.ratio),
    inputAssetId: readNonEmptyString(params.image_asset_id),
    inputImageUrl: readNonEmptyString(params.image_url),
    estimatedCostCny: null,
    costStatus: 'unavailable',
    willCallProvider: false,
  };
}
