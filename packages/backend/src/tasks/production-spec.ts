export type ProductionSpec = {
  version: string;
  model: string;
  duration: number;
  ratio: string;
  resolution: string;
  generateAudio: boolean;
  watermark: boolean;
  pricingVersion: string;
  reserveCny: string;
  estimatedTokens?: number;
  pricingRatePerMillion?: string;
  pricingBasis?: string;
};

export type ProductionExecutionPlan = {
  specVersion: string;
  pricingVersion: string;
  reserveCny: string;
  model: string;
  prompt: string;
  imageAssetId?: string;
  inputFileHash?: string | null;
  workflowKey?: string;
  workflowVersion?: string;
  media?: { assetId: string; role: string; fileHash?: string | null }[];
  duration: number;
  ratio: string;
  resolution: string;
  generateAudio: boolean;
  watermark: boolean;
  omniReferenceTaskType?: 'reference' | 'edit' | 'extend';
  outputFormat?: 'mov';
};

const ALLOWED_PARAMS = new Set([
  'prompt',
  'image_asset_id',
  'duration',
  'ratio',
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMoney(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value) &&
    Number(value) > 0
  );
}

export function loadProductionSpec(
  raw: string | undefined = process.env.VIDEO_FLOW_PRODUCTION_SPEC_JSON,
): ProductionSpec | null {
  if (!raw?.trim()) return null;

  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      !nonEmptyString(value.version) ||
      !nonEmptyString(value.model) ||
      !Number.isInteger(value.duration) ||
      Number(value.duration) <= 0 ||
      !nonEmptyString(value.ratio) ||
      !nonEmptyString(value.resolution) ||
      typeof value.generateAudio !== 'boolean' ||
      typeof value.watermark !== 'boolean' ||
      !nonEmptyString(value.pricingVersion) ||
      !isMoney(value.reserveCny)
    ) {
      return null;
    }
    return value as ProductionSpec;
  } catch {
    return null;
  }
}

export function normalizeProductionParams(
  params: Record<string, unknown>,
  spec: ProductionSpec,
): ProductionExecutionPlan {
  const unknown = Object.keys(params).filter((key) => !ALLOWED_PARAMS.has(key));
  if (unknown.length) {
    throw new Error('PRODUCTION_PARAM_NOT_ALLOWED');
  }

  const prompt = nonEmptyString(params.prompt) ? params.prompt.trim() : null;
  const imageAssetId = nonEmptyString(params.image_asset_id)
    ? params.image_asset_id.trim()
    : null;
  if (!prompt || !imageAssetId) {
    throw new Error('PRODUCTION_INPUT_REQUIRED');
  }
  if (params.duration !== spec.duration || params.ratio !== spec.ratio) {
    throw new Error('PRODUCTION_SPEC_MISMATCH');
  }

  return {
    specVersion: spec.version,
    pricingVersion: spec.pricingVersion,
    reserveCny: spec.reserveCny,
    model: spec.model,
    prompt,
    imageAssetId,
    duration: spec.duration,
    ratio: spec.ratio,
    resolution: spec.resolution,
    generateAudio: spec.generateAudio,
    watermark: spec.watermark,
  };
}
