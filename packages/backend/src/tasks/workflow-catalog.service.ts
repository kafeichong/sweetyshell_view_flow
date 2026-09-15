import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  CheckItem,
  MediaDescriptor,
  MediaKind,
  MediaRole,
  WorkflowContractCatalog,
  WorkflowContractDefinition,
  WorkflowIntent,
} from './workflow-contract';
import { validateSeedanceMediaMetadata, validateSeedanceMediaTotals } from '../assets/media-policy';

const contract = require('./resources/seedance-workflows.v2.json') as WorkflowContractCatalog;

const ROLE_KIND: Record<MediaRole, MediaKind> = {
  reference_image: 'image',
  first_frame: 'image',
  last_frame: 'image',
  reference_video: 'video',
  reference_audio: 'audio',
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function workflowDigest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function workflowExecutionDigest(value: WorkflowContractCatalog): string {
  return workflowDigest({
    schemaVersion: value.schemaVersion,
    provider: value.provider,
    model: { id: value.model.id },
    workflows: value.workflows.map((workflow) => ({
      key: workflow.key,
      capability: workflow.state.capability,
      media: workflow.media,
      generation: workflow.generation,
      providerFields: workflow.providerFields,
    })),
  });
}

export class WorkflowContractError extends Error {
  constructor(public readonly code: string, public readonly path: string, message = code) {
    super(message);
    this.name = 'WorkflowContractError';
  }
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowContractError('WORKFLOW_FIELD_TYPE_INVALID', path);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path = ''): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new WorkflowContractError('WORKFLOW_FIELDS_INVALID', path ? `${path}.${unknown}` : unknown);
}

function failed(code: string, path: string, message = code): CheckItem {
  return { code, path, status: 'failed', message };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

@Injectable()
export class WorkflowCatalogService {
  private readonly catalogDigest = workflowDigest(contract);
  private readonly contractDigest = workflowExecutionDigest(contract);

  list(): WorkflowContractDefinition[] {
    return clone(contract.workflows);
  }

  directory() {
    return {
      contractVersion: contract.schemaVersion,
      contractRevision: contract.contractRevision,
      contractDigest: this.contractDigest,
      catalogDigest: this.catalogDigest,
      model: contract.model.id,
      workflows: this.list(),
    };
  }

  getContractDigest(): string {
    return this.contractDigest;
  }

  evaluate(input: unknown): {
    effectiveRequest: WorkflowIntent;
    requestCheck: { status: 'passed' | 'failed'; items: CheckItem[] };
    workflow: WorkflowContractDefinition;
    workflowVersion: string;
    contractDigest: string;
    intentDigest: string;
    model: string;
  } {
    const raw = objectAt(input, 'request');
    exactKeys(raw, ['contractVersion', 'workflowKey', 'prompt', 'generation', 'media']);
    if (raw.contractVersion !== 2) throw new WorkflowContractError('WORKFLOW_CONTRACT_VERSION_INVALID', 'contractVersion');
    if (typeof raw.workflowKey !== 'string') throw new WorkflowContractError('WORKFLOW_KEY_REQUIRED', 'workflowKey');
    const workflow = contract.workflows.find((item) => item.key === raw.workflowKey);
    if (!workflow) throw new WorkflowContractError('WORKFLOW_NOT_FOUND', 'workflowKey');

    const prompt = objectAt(raw.prompt, 'prompt');
    exactKeys(prompt, ['positive'], 'prompt');
    if (typeof prompt.positive !== 'string' || !prompt.positive.trim() || prompt.positive.length > 4000) {
      throw new WorkflowContractError('WORKFLOW_PROMPT_INVALID', 'prompt.positive');
    }

    const generation = objectAt(raw.generation, 'generation');
    exactKeys(generation, ['duration', 'ratio', 'resolution', 'generateAudio', 'watermark', 'outputFormat'], 'generation');
    if (typeof generation.duration !== 'number' || !Number.isInteger(generation.duration)) {
      throw new WorkflowContractError('WORKFLOW_DURATION_TYPE_INVALID', 'generation.duration');
    }
    for (const key of ['ratio', 'resolution', 'outputFormat'] as const) {
      if (typeof generation[key] !== 'string') throw new WorkflowContractError('WORKFLOW_GENERATION_TYPE_INVALID', `generation.${key}`);
    }
    for (const key of ['generateAudio', 'watermark'] as const) {
      if (typeof generation[key] !== 'boolean') throw new WorkflowContractError('WORKFLOW_GENERATION_TYPE_INVALID', `generation.${key}`);
    }
    if (!Array.isArray(raw.media)) throw new WorkflowContractError('WORKFLOW_MEDIA_REQUIRED', 'media');

    const items: CheckItem[] = [];
    const media = raw.media.map((entry, index) => this.mediaDescriptor(entry, index, items));
    this.validateWorkflowMedia(workflow, media, items);
    this.validateMediaMetadata(media, items);
    this.validateGeneration(workflow, generation, items);

    const effectiveRequest = clone({
      contractVersion: 2,
      workflowKey: workflow.key,
      prompt: { positive: prompt.positive.trim() },
      generation: {
        duration: generation.duration,
        ratio: generation.ratio,
        resolution: generation.resolution,
        generateAudio: generation.generateAudio,
        watermark: generation.watermark,
        outputFormat: generation.outputFormat,
      },
      media,
    }) as WorkflowIntent;

    if (!items.length) items.push({ code: 'REQUEST_VALID', path: 'request', status: 'passed', message: 'Request matches the workflow contract' });
    return {
      effectiveRequest,
      requestCheck: { status: items.some((item) => item.status === 'failed') ? 'failed' : 'passed', items },
      workflow: clone(workflow),
      workflowVersion: contract.contractRevision,
      contractDigest: this.contractDigest,
      intentDigest: workflowDigest(effectiveRequest),
      model: contract.model.id,
    };
  }

  private mediaDescriptor(entry: unknown, index: number, items: CheckItem[]): MediaDescriptor {
    const path = `media[${index}]`;
    const raw = objectAt(entry, path);
    exactKeys(raw, ['slotId', 'role', 'sha256', 'mimeType', 'sizeBytes', 'metadata'], path);
    const metadata = objectAt(raw.metadata, `${path}.metadata`);
    exactKeys(metadata, ['kind', 'width', 'height', 'durationSeconds', 'frameRate', 'videoCodec', 'audioCodec'], `${path}.metadata`);
    const role = raw.role as MediaRole;
    const kind = metadata.kind as MediaKind;
    if (!Object.prototype.hasOwnProperty.call(ROLE_KIND, role)) throw new WorkflowContractError('WORKFLOW_MEDIA_ROLE_INVALID', `${path}.role`);
    if (!['image', 'video', 'audio'].includes(kind)) throw new WorkflowContractError('WORKFLOW_MEDIA_KIND_INVALID', `${path}.metadata.kind`);
    if (typeof raw.slotId !== 'string' || !raw.slotId.trim()) throw new WorkflowContractError('WORKFLOW_MEDIA_SLOT_INVALID', `${path}.slotId`);
    if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.sha256)) throw new WorkflowContractError('WORKFLOW_MEDIA_HASH_INVALID', `${path}.sha256`);
    if (typeof raw.mimeType !== 'string' || !raw.mimeType.includes('/')) throw new WorkflowContractError('WORKFLOW_MEDIA_MIME_INVALID', `${path}.mimeType`);
    if (!Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) <= 0) throw new WorkflowContractError('WORKFLOW_MEDIA_SIZE_INVALID', `${path}.sizeBytes`);
    if (ROLE_KIND[role] !== kind) items.push(failed('MEDIA_ROLE_KIND_MISMATCH', `${path}.metadata.kind`));
    if (!(raw.mimeType as string).toLowerCase().startsWith(`${ROLE_KIND[role]}/`)) items.push(failed('MEDIA_MIME_KIND_MISMATCH', `${path}.mimeType`));

    return clone({
      slotId: raw.slotId.trim(), role, sha256: raw.sha256.toLowerCase(), mimeType: raw.mimeType.toLowerCase(), sizeBytes: raw.sizeBytes,
      metadata,
    }) as MediaDescriptor;
  }

  private validateWorkflowMedia(workflow: WorkflowContractDefinition, media: MediaDescriptor[], items: CheckItem[]): void {
    if (media.length < workflow.media.minimumTotal || media.length > workflow.media.maximumTotal) {
      items.push(failed('WORKFLOW_MEDIA_COUNT_INVALID', 'media'));
    }
    const policies = new Map(workflow.media.roles.map((role) => [role.role, role]));
    for (let index = 0; index < media.length; index += 1) {
      if (!policies.has(media[index].role)) items.push(failed('WORKFLOW_MEDIA_ROLE_INVALID', `media[${index}].role`));
    }
    for (const policy of workflow.media.roles) {
      const matching = media.filter((item) => item.role === policy.role);
      if (matching.length < policy.minimum || matching.length > policy.maximum) {
        items.push(failed('WORKFLOW_MEDIA_ROLE_COUNT_INVALID', 'media'));
      }
      if (policy.minimumDurationSeconds !== undefined) {
        matching.forEach((item, index) => {
          if (typeof item.metadata.durationSeconds !== 'number' || item.metadata.durationSeconds < policy.minimumDurationSeconds!) {
            items.push(failed('WORKFLOW_MEDIA_DURATION_INVALID', `media[${media.indexOf(item)}].metadata.durationSeconds`));
          }
        });
      }
    }
    if (workflow.media.orderedRoles) {
      const expected = workflow.media.orderedRoles;
      media.forEach((item, index) => {
        if (expected[index] !== item.role) items.push(failed('WORKFLOW_MEDIA_ORDER_INVALID', `media[${index}].role`));
      });
    }
    const slots = media.map((item) => item.slotId);
    if (new Set(slots).size !== slots.length) items.push(failed('WORKFLOW_MEDIA_SLOT_DUPLICATE', 'media'));
  }

  private validateMediaMetadata(media: MediaDescriptor[], items: CheckItem[]): void {
    media.forEach((item, index) => {
      if (ROLE_KIND[item.role] !== item.metadata.kind || !item.mimeType.startsWith(`${ROLE_KIND[item.role]}/`)) return;
      try {
        validateSeedanceMediaMetadata(item.mimeType, item.metadata, item.sizeBytes);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'MEDIA_METADATA_INVALID';
        const path = code.endsWith('_SIZE_INVALID') ? `media[${index}].sizeBytes` : `media[${index}].metadata`;
        items.push(failed(code, path));
      }
    });
    for (const role of ['reference_video', 'reference_audio']) {
      try {
        validateSeedanceMediaTotals(media.filter((item) => item.role === role));
      } catch (error) {
        items.push(failed(error instanceof Error ? error.message : 'MEDIA_TOTAL_DURATION_INVALID', 'media'));
      }
    }
  }

  private validateGeneration(workflow: WorkflowContractDefinition, generation: Record<string, unknown>, items: CheckItem[]): void {
    const duration = workflow.generation.productDuration;
    const actualDuration = generation.duration as number;
    const validDuration = duration.kind === 'fixed'
      ? actualDuration === duration.value
      : actualDuration >= duration.minimum && actualDuration <= duration.maximum;
    if (!validDuration) items.push(failed('WORKFLOW_DURATION_INVALID', 'generation.duration'));
    if (!workflow.generation.ratios.includes(generation.ratio as string)) items.push(failed('WORKFLOW_RATIO_INVALID', 'generation.ratio'));
    if (!workflow.generation.resolutions.includes(generation.resolution as string)) items.push(failed('WORKFLOW_RESOLUTION_INVALID', 'generation.resolution'));
    if (!workflow.generation.outputFormats.includes(generation.outputFormat as 'mp4' | 'mov')) items.push(failed('WORKFLOW_OUTPUT_FORMAT_INVALID', 'generation.outputFormat'));
  }
}
