export type MediaRole = 'reference_image' | 'first_frame' | 'last_frame' | 'reference_video' | 'reference_audio';
export type MediaKind = 'image' | 'video' | 'audio';

export type MediaDescriptor = {
  slotId: string;
  role: MediaRole;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  metadata: {
    kind: MediaKind;
    width?: number;
    height?: number;
    durationSeconds?: number;
    frameRate?: number;
    videoCodec?: string;
    audioCodec?: string;
  };
  /**
   * 方舟私域素材库里那份素材的 ID（形如 `asset-20260917115246-cgmtw`）。
   *
   * 带这个键表示该素材走 `asset://<id>` 送进方舟，而不是我方 OSS 的签名 URL——
   * 含真人人脸的参考素材**只能**这样送，直传会被方舟输入审核拦下，所以这不是优化项。
   *
   * 其余六个键照旧填真值（那份文件在入库时由我方检查器看过），所以服务端
   * `production-submission` 的逐字段比对不用为它开特例。
   */
  arkAssetId?: string;
};

export type WorkflowIntent = {
  contractVersion: 2;
  workflowKey: string;
  prompt: { positive: string };
  generation: {
    duration: number;
    ratio: string;
    resolution: string;
    generateAudio: boolean;
    watermark: boolean;
    outputFormat: 'mp4' | 'mov';
  };
  media: MediaDescriptor[];
};

export type CheckItem = {
  code: string;
  path: string;
  status: 'passed' | 'failed' | 'unverified';
  message: string;
};

export type Quote = {
  status: 'estimated' | 'bounded' | 'unavailable';
  currency: 'CNY';
  estimatedCny: string | null;
  reserveCny: string | null;
  pricingVersion: string | null;
  quoteDigest: string;
  expiresAt: string;
  basis: Record<string, unknown>;
  missing: string[];
};

export type PreflightReport = {
  preflightId: string;
  expiresAt: string;
  requestCheck: { status: 'passed' | 'failed' | 'incomplete'; items: CheckItem[] };
  productionAdmission: { canSubmit: boolean; blockers: CheckItem[] };
  effectiveRequest: WorkflowIntent;
  model: string;
  workflowVersion: string;
  contractDigest: string;
  intentDigest: string;
  quote: Quote;
  willUploadMedia: false;
  willCallProvider: false;
};

export type WorkflowState = {
  capability: 'confirmed' | 'unconfirmed' | 'unsupported';
  implementation: 'incomplete' | 'ready';
  admission: { enabled: boolean; reason: string | null };
  validation: { status: 'not_run' | 'passed' | 'failed'; records: unknown[] };
};

export type WorkflowContractDefinition = {
  key: string;
  label: string;
  state: WorkflowState;
  media: {
    roles: { role: MediaRole; minimum: number; maximum: number; minimumDurationSeconds?: number }[];
    minimumTotal: number;
    maximumTotal: number;
    orderedRoles?: MediaRole[];
  };
  generation: {
    productDuration: { kind: 'integer_range'; minimum: number; maximum: number } | { kind: 'fixed'; value: number };
    ratios: string[];
    resolutions: string[];
    outputFormats: ('mp4' | 'mov')[];
  };
  providerFields: Record<string, unknown>;
  evidence: string[];
};

export type WorkflowContractCatalog = {
  schemaVersion: number;
  contractId: string;
  contractRevision: string;
  provider: string;
  model: { id: string };
  /**
   * 合同 `media` 一节里**被代码读取**的部分。只声明这一块：其余字段（各类素材的
   * 上限与格式）另有 `assets/media-policy.ts` 的常量把守，声明进来反而会出现两个口径。
   */
  media: {
    assetLibrary: {
      uriScheme: string;
      roles: MediaRole[];
      projectName: string;
      assetIdPattern: string;
      unverifiedRoles: MediaRole[];
    };
  };
  workflows: WorkflowContractDefinition[];
  evidence: Record<string, unknown>;
};
