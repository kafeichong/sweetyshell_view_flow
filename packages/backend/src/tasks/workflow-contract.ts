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
  workflows: WorkflowContractDefinition[];
  evidence: Record<string, unknown>;
};
