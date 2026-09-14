import { ProductionSpec } from './production-spec';

export type WorkflowStatus = 'production_verified' | 'preview_only' | 'disabled';
export type WorkflowMediaRole = 'reference_image' | 'first_frame' | 'last_frame' | 'reference_video' | 'reference_audio';

export type WorkflowDefinition = {
  key: string;
  version: string;
  label: string;
  status: WorkflowStatus;
  capability: 'TEXT_TO_VIDEO' | 'IMAGE_TO_VIDEO' | 'VIDEO_TO_VIDEO' | 'AUDIO_TO_VIDEO';
  profile: 'seedance';
  media: { role: WorkflowMediaRole; min: number; max: number }[];
};

const WORKFLOWS: readonly WorkflowDefinition[] = [
  {
    key: 'seedance.reference-image-to-video.v1',
    version: 'v1',
    label: 'Seedance Reference Image to Video',
    status: 'production_verified',
    capability: 'IMAGE_TO_VIDEO',
    profile: 'seedance',
    media: [{ role: 'reference_image', min: 1, max: 1 }],
  },
  {
    key: 'seedance.text-to-video.v1',
    version: 'v1',
    label: 'Seedance Text to Video',
    status: 'preview_only',
    capability: 'TEXT_TO_VIDEO',
    profile: 'seedance',
    media: [],
  },
  {
    key: 'seedance.first-frame-to-video.v1', version: 'v1', label: 'Seedance First Frame to Video', status: 'disabled', capability: 'IMAGE_TO_VIDEO', profile: 'seedance', media: [{ role: 'first_frame', min: 1, max: 1 }],
  },
  {
    key: 'seedance.first-last-frame-to-video.v1', version: 'v1', label: 'Seedance First and Last Frame to Video', status: 'disabled', capability: 'IMAGE_TO_VIDEO', profile: 'seedance', media: [{ role: 'first_frame', min: 1, max: 1 }, { role: 'last_frame', min: 1, max: 1 }],
  },
  {
    key: 'seedance.omni-reference.v1', version: 'v1', label: 'Seedance Omni Reference', status: 'disabled', capability: 'IMAGE_TO_VIDEO', profile: 'seedance', media: [{ role: 'reference_image', min: 0, max: 30 }, { role: 'reference_video', min: 0, max: 10 }, { role: 'reference_audio', min: 0, max: 10 }],
  },
  {
    key: 'seedance.video-edit.v1', version: 'v1', label: 'Seedance Video Edit', status: 'disabled', capability: 'VIDEO_TO_VIDEO', profile: 'seedance', media: [{ role: 'reference_video', min: 1, max: 10 }],
  },
  {
    key: 'seedance.video-extend.v1', version: 'v1', label: 'Seedance Video Extend', status: 'disabled', capability: 'VIDEO_TO_VIDEO', profile: 'seedance', media: [{ role: 'reference_video', min: 1, max: 10 }],
  },
  {
    key: 'seedance.audio-reference-to-video.v1', version: 'v1', label: 'Seedance Audio Reference to Video', status: 'disabled', capability: 'AUDIO_TO_VIDEO', profile: 'seedance', media: [{ role: 'reference_audio', min: 1, max: 10 }],
  },
] as const;

export type WorkflowMediaInput = { assetId: string; role: WorkflowMediaRole };
export type NormalizedWorkflowTaskRequest = {
  workflowKey: string;
  workflowVersion: string;
  status: WorkflowStatus;
  capability: WorkflowDefinition['capability'];
  profile: WorkflowDefinition['profile'];
  prompt: string;
  media: WorkflowMediaInput[];
  generation: Pick<ProductionSpec, 'duration' | 'ratio' | 'resolution'>;
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

function validateGeneration(value: unknown, spec: ProductionSpec) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('WORKFLOW_GENERATION_REQUIRED');
  const generation = value as Record<string, unknown>;
  if (
    generation.duration !== spec.duration ||
    generation.ratio !== spec.ratio ||
    generation.resolution !== spec.resolution
  ) invalid('WORKFLOW_GENERATION_MISMATCH');
  return { duration: spec.duration, ratio: spec.ratio, resolution: spec.resolution };
}

function validateMedia(value: unknown, workflow: WorkflowDefinition): WorkflowMediaInput[] {
  if (!Array.isArray(value)) invalid('WORKFLOW_MEDIA_REQUIRED');
  const media = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('WORKFLOW_MEDIA_INVALID');
    const raw = entry as Record<string, unknown>;
    const assetId = nonEmptyString(raw.assetId);
    const role = nonEmptyString(raw.role);
    if (!assetId || role !== 'reference_image') invalid('WORKFLOW_MEDIA_INVALID');
    return { assetId, role } as WorkflowMediaInput;
  });
  const expected = workflow.media[0];
  if (!expected) {
    if (media.length) invalid('WORKFLOW_MEDIA_NOT_ALLOWED');
    return media;
  }
  if (media.length < expected.min || media.length > expected.max) invalid('WORKFLOW_MEDIA_COUNT_INVALID');
  if (media.some((entry) => entry.role !== expected.role)) invalid('WORKFLOW_MEDIA_ROLE_INVALID');
  return media;
}

export function normalizeWorkflowTaskRequest(body: unknown, spec: ProductionSpec): NormalizedWorkflowTaskRequest {
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
    generation: validateGeneration(raw.generation, spec),
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
