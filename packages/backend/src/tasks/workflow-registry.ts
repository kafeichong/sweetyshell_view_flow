import { ProductionSpec } from './production-spec';

export type WorkflowStatus = 'production_verified' | 'preview_only' | 'disabled';
export type WorkflowMediaRole = 'reference_image' | 'first_frame' | 'last_frame' | 'reference_video' | 'reference_audio';
type WorkflowGeneration = { duration: readonly number[] | 'production_spec'; ratio: readonly string[] | 'production_spec'; resolution: readonly string[] | 'production_spec' };
export type SeedanceProviderFields = { omniReferenceTaskType?: 'reference' | 'edit' | 'extend'; outputFormat?: 'mov' };

export type WorkflowDefinition = {
  key: string;
  version: string;
  label: string;
  status: WorkflowStatus;
  capability: 'TEXT_TO_VIDEO' | 'IMAGE_TO_VIDEO' | 'VIDEO_TO_VIDEO' | 'AUDIO_TO_VIDEO';
  profile: 'seedance';
  media: { role: WorkflowMediaRole; min: number; max: number }[];
  requiresAnyMedia?: boolean;
  generation: WorkflowGeneration;
  providerFields?: SeedanceProviderFields;
};

const STANDARD_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
const STANDARD_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] as const;
const VERIFIED_REFERENCE_DURATIONS = STANDARD_DURATIONS;
const STANDARD_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;

const WORKFLOWS: readonly WorkflowDefinition[] = [
  {
    key: 'seedance.reference-image-to-video.v1',
    version: 'v1',
    label: 'Seedance Reference Image to Video',
    status: 'production_verified',
    capability: 'IMAGE_TO_VIDEO',
    profile: 'seedance',
    media: [{ role: 'reference_image', min: 1, max: 1 }],
    generation: { duration: VERIFIED_REFERENCE_DURATIONS, ratio: STANDARD_RATIOS, resolution: STANDARD_RESOLUTIONS },
  },
  {
    key: 'seedance.text-to-video.v1',
    version: 'v1',
    label: 'Seedance Text to Video',
    status: 'preview_only',
    capability: 'TEXT_TO_VIDEO',
    profile: 'seedance',
    media: [],
    generation: { duration: STANDARD_DURATIONS, ratio: STANDARD_RATIOS, resolution: STANDARD_RESOLUTIONS },
  },
  {
    key: 'seedance.first-frame-to-video.v1', version: 'v1', label: 'Seedance First Frame to Video', status: 'disabled', capability: 'IMAGE_TO_VIDEO', profile: 'seedance', media: [{ role: 'first_frame', min: 1, max: 1 }],
    generation: { duration: STANDARD_DURATIONS, ratio: ['adaptive'], resolution: STANDARD_RESOLUTIONS },
  },
  {
    key: 'seedance.first-last-frame-to-video.v1', version: 'v1', label: 'Seedance First and Last Frame to Video', status: 'disabled', capability: 'IMAGE_TO_VIDEO', profile: 'seedance', media: [{ role: 'first_frame', min: 1, max: 1 }, { role: 'last_frame', min: 1, max: 1 }],
    generation: { duration: STANDARD_DURATIONS, ratio: ['adaptive'], resolution: STANDARD_RESOLUTIONS },
  },
  {
    key: 'seedance.omni-reference.v1', version: 'v1', label: 'Seedance Omni Reference', status: 'disabled', capability: 'IMAGE_TO_VIDEO', profile: 'seedance', media: [{ role: 'reference_image', min: 0, max: 30 }, { role: 'reference_video', min: 0, max: 10 }, { role: 'reference_audio', min: 0, max: 10 }], requiresAnyMedia: true,
    generation: { duration: STANDARD_DURATIONS, ratio: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], resolution: STANDARD_RESOLUTIONS },
    providerFields: { omniReferenceTaskType: 'reference', outputFormat: 'mov' },
  },
  {
    key: 'seedance.video-edit.v1', version: 'v1', label: 'Seedance Video Edit', status: 'disabled', capability: 'VIDEO_TO_VIDEO', profile: 'seedance', media: [{ role: 'reference_video', min: 1, max: 10 }],
    generation: { duration: [-1], ratio: ['adaptive'], resolution: STANDARD_RESOLUTIONS },
    providerFields: { omniReferenceTaskType: 'edit', outputFormat: 'mov' },
  },
  {
    key: 'seedance.video-extend.v1', version: 'v1', label: 'Seedance Video Extend', status: 'disabled', capability: 'VIDEO_TO_VIDEO', profile: 'seedance', media: [{ role: 'reference_video', min: 1, max: 10 }],
    generation: { duration: [...STANDARD_DURATIONS, -1], ratio: ['adaptive'], resolution: STANDARD_RESOLUTIONS },
    providerFields: { omniReferenceTaskType: 'extend', outputFormat: 'mov' },
  },
  {
    key: 'seedance.audio-reference-to-video.v1', version: 'v1', label: 'Seedance Audio Reference to Video', status: 'disabled', capability: 'AUDIO_TO_VIDEO', profile: 'seedance', media: [{ role: 'reference_audio', min: 1, max: 10 }],
    generation: { duration: STANDARD_DURATIONS, ratio: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], resolution: STANDARD_RESOLUTIONS },
  },
] as const;

export type WorkflowMediaInput = { assetId: string; role: WorkflowMediaRole };
export type WorkflowInputAsset = { id: string; mimeType: string | null; mediaMetadata: unknown };
export type NormalizedWorkflowTaskRequest = {
  workflowKey: string;
  workflowVersion: string;
  status: WorkflowStatus;
  capability: WorkflowDefinition['capability'];
  profile: WorkflowDefinition['profile'];
  prompt: string;
  media: WorkflowMediaInput[];
  generation: Pick<ProductionSpec, 'duration' | 'ratio' | 'resolution'>;
  providerFields: SeedanceProviderFields;
  legacy: boolean;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function invalid(code: string): never {
  throw new Error(code);
}

function resolveWorkflow(key: unknown): WorkflowDefinition {
  const workflow = WORKFLOWS.find((item) => item.key === key);
  return workflow ?? invalid('WORKFLOW_NOT_FOUND');
}

function validateGeneration(value: unknown, workflow: WorkflowDefinition, spec?: ProductionSpec) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('WORKFLOW_GENERATION_REQUIRED');
  const generation = value as Record<string, unknown>;
  const policy = workflow.generation;
  if ((policy.duration === 'production_spec' || policy.ratio === 'production_spec' || policy.resolution === 'production_spec') && !spec) invalid('WORKFLOW_SPEC_UNAVAILABLE');
  const duration = policy.duration === 'production_spec' ? spec!.duration : generation.duration;
  const ratio = policy.ratio === 'production_spec' ? spec!.ratio : generation.ratio;
  const resolution = policy.resolution === 'production_spec' ? spec!.resolution : generation.resolution;
  if (
    generation.duration !== duration ||
    generation.ratio !== ratio ||
    generation.resolution !== resolution ||
    (policy.duration !== 'production_spec' && !policy.duration.includes(duration as number)) ||
    (policy.ratio !== 'production_spec' && !policy.ratio.includes(ratio as string)) ||
    (policy.resolution !== 'production_spec' && !policy.resolution.includes(resolution as string))
  ) invalid('WORKFLOW_GENERATION_MISMATCH');
  return { duration: duration as number, ratio: ratio as string, resolution: resolution as string };
}

function validateMedia(value: unknown, workflow: WorkflowDefinition): WorkflowMediaInput[] {
  if (!Array.isArray(value)) invalid('WORKFLOW_MEDIA_REQUIRED');
  const media = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('WORKFLOW_MEDIA_INVALID');
    const raw = entry as Record<string, unknown>;
    const assetId = nonEmptyString(raw.assetId);
    const role = nonEmptyString(raw.role);
    if (!assetId || !['reference_image', 'first_frame', 'last_frame', 'reference_video', 'reference_audio'].includes(role ?? '')) invalid('WORKFLOW_MEDIA_INVALID');
    return { assetId, role: role as WorkflowMediaRole } as WorkflowMediaInput;
  });
  if (!workflow.media.length) {
    if (media.length) invalid('WORKFLOW_MEDIA_NOT_ALLOWED');
    return media;
  }
  const policies = new Map(workflow.media.map((item, index) => [item.role, { ...item, index }]));
  if (media.some((entry) => !policies.has(entry.role))) invalid('WORKFLOW_MEDIA_ROLE_INVALID');
  for (const policy of workflow.media) {
    const count = media.filter((entry) => entry.role === policy.role).length;
    if (count < policy.min || count > policy.max) invalid('WORKFLOW_MEDIA_COUNT_INVALID');
  }
  if (workflow.requiresAnyMedia && !media.length) invalid('WORKFLOW_MEDIA_REQUIRED');
  let previousIndex = -1;
  for (const entry of media) {
    const index = policies.get(entry.role)!.index;
    if (index < previousIndex) invalid('WORKFLOW_MEDIA_ORDER_INVALID');
    previousIndex = index;
  }
  return media;
}

const ROLE_MEDIA_KIND: Record<WorkflowMediaRole, 'image' | 'video' | 'audio'> = {
  reference_image: 'image', first_frame: 'image', last_frame: 'image', reference_video: 'video', reference_audio: 'audio',
};

/**
 * Registry validates the request shape; this second step binds every declared
 * role to inspected Asset metadata before a paid execution plan is persisted.
 */
export function validateWorkflowInputAssets(media: WorkflowMediaInput[], assets: WorkflowInputAsset[]): void {
  if (media.length !== assets.length) invalid('WORKFLOW_ASSET_NOT_FOUND');
  for (let index = 0; index < media.length; index += 1) {
    const input = media[index];
    const asset = assets[index];
    if (!asset || asset.id !== input.assetId) invalid('WORKFLOW_ASSET_NOT_FOUND');
    const metadata = asset.mediaMetadata;
    const kind = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).kind : null;
    if (kind !== ROLE_MEDIA_KIND[input.role]) invalid('WORKFLOW_ASSET_KIND_MISMATCH');
    if (!asset.mimeType?.startsWith(`${kind}/`)) invalid('WORKFLOW_ASSET_MIME_MISMATCH');
  }
}

export function normalizeWorkflowTaskRequest(body: unknown, spec?: ProductionSpec): NormalizedWorkflowTaskRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('WORKFLOW_REQUEST_INVALID');
  const raw = body as Record<string, unknown>;
  if (!raw.workflowKey) invalid('WORKFLOW_KEY_REQUIRED');

  const workflow = resolveWorkflow(raw.workflowKey);
  const promptData = raw.prompt;
  if (!promptData || typeof promptData !== 'object' || Array.isArray(promptData)) invalid('WORKFLOW_PROMPT_REQUIRED');
  const prompt = nonEmptyString((promptData as Record<string, unknown>).positive);
  if (!prompt || prompt.length > 4000) invalid('WORKFLOW_PROMPT_INVALID');

  return {
    workflowKey: workflow.key,
    workflowVersion: workflow.version,
    status: workflow.status,
    capability: workflow.capability,
    profile: workflow.profile,
    prompt,
    media: validateMedia(raw.media, workflow),
    generation: validateGeneration(raw.generation, workflow, spec),
    providerFields: workflow.providerFields ?? {},
    legacy: false,
  };
}

export function listWorkflows() {
  return WORKFLOWS.map(({ key, version, label, status, capability, media }) => ({
    key,
    version,
    label,
    status,
    capability,
    media,
  }));
}
