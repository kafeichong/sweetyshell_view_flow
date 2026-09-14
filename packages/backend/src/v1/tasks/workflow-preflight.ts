import { createHash } from 'crypto';
import { ProductionSpec } from '../../tasks/production-spec';
import { normalizeWorkflowTaskRequest } from '../../tasks/workflow-registry';
import { validateSeedanceMediaMetadata } from '../../assets/media-policy';

export const PREFLIGHT_VERSION = 'product-image-preflight-v1';
export const PREFLIGHT_TTL_MS = 30 * 60 * 1000;
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function keys(value: any, allowed: string[], path: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`PREFLIGHT_FIELDS_INVALID:${path}`);
}
export function preflightIntent(body: any, spec: ProductionSpec) {
  keys(body, ['workflowKey', 'prompt', 'generation', 'media'], 'request');
  if (body.workflowKey !== 'seedance.reference-image-to-video.v1') throw new Error('PREFLIGHT_WORKFLOW_NOT_SUPPORTED');
  keys(body.prompt, ['positive'], 'prompt');
  keys(body.generation, ['duration', 'ratio', 'resolution'], 'generation');
  if (!Array.isArray(body.media) || body.media.length !== 1) throw new Error('WORKFLOW_MEDIA_COUNT_INVALID');
  const media = body.media.map((item: any) => {
    keys(item, ['sha256', 'role', 'mimeType', 'sizeBytes', 'metadata'], 'media');
    keys(item.metadata, ['kind', 'width', 'height'], 'metadata');
    if (!/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new Error('PREFLIGHT_HASH_INVALID');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType)) throw new Error('PREFLIGHT_MIME_INVALID');
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0 || item.sizeBytes >= 30 * 1024 * 1024) throw new Error('PREFLIGHT_SIZE_INVALID');
    if (!Number.isInteger(item.metadata.width) || !Number.isInteger(item.metadata.height)) throw new Error('IMAGE_DIMENSIONS_INVALID');
    validateSeedanceMediaMetadata(item.mimeType, item.metadata);
    return item;
  });
  const normalized = normalizeWorkflowTaskRequest({ ...body, media: media.map((m: any) => ({ assetId: m.sha256, role: m.role })) }, spec);
  if (normalized.status !== 'production_verified') throw new Error('WORKFLOW_NOT_PRODUCTION_VERIFIED');
  return { workflowKey: normalized.workflowKey, prompt: { positive: normalized.prompt }, generation: normalized.generation, media };
}
export function preflightSnapshot(body: unknown, spec: ProductionSpec) {
  return { preflightVersion: PREFLIGHT_VERSION, specDigest: digest(spec), intent: preflightIntent(body, spec) };
}
export function verifyPreflightRecord(record: any, actorId: string, body: unknown, spec: ProductionSpec, now = Date.now()) {
  if (!record || record.actorId !== actorId || record.status !== 'preview') throw new Error('PREFLIGHT_REQUIRED');
  const age = now - new Date(record.createdAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age >= PREFLIGHT_TTL_MS) throw new Error('PREFLIGHT_EXPIRED');
  if (canonical(record.requestSnapshot) !== canonical(preflightSnapshot(body, spec))) throw new Error('PREFLIGHT_CONTENT_CHANGED');
}
