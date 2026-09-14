import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  HttpException,
  HttpStatus,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { AssetPresignService } from '../../assets/asset-presign.service';
import { PREFLIGHT_TTL_MS, preflightSnapshot, verifyPreflightRecord } from './workflow-preflight';
import { Prisma } from '@prisma/client';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { TasksService } from '../../tasks/tasks.service';
import { TaskBudgetService } from '../../tasks/task-budget.service';
import { AssetsService } from '../../assets/assets.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { isProductionAllowed } from './production-policy';
import { ProductionExecutionPlan, loadProductionSpec } from '../../tasks/production-spec';
import { listWorkflows, normalizeWorkflowTaskRequest, validateWorkflowInputAssets } from '../../tasks/workflow-registry';

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function workflowHash(key: string, version: string): string {
  return createHash('sha256').update(`${key}@${version}`).digest('hex');
}

@ApiTags('tasks')
@ApiBearerAuth('actor-token')
@Controller('v1/tasks')
@UseGuards(ApiCredentialGuard)
export class V1TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly budget?: TaskBudgetService,
    private readonly assets?: AssetsService,
    private readonly presign?: AssetPresignService,
  ) {}

  @Get('/workflows')
  workflows() {
    return { workflows: listWorkflows() };
  }

  @Post('preflight')
  async preflight(@CurrentActor() actor: { actorId: string }, @Body() body: unknown) {
    const spec = loadProductionSpec();
    if (!spec) throw new ServiceUnavailableException('PRODUCTION_SPEC_UNAVAILABLE');
    if (!isProductionAllowed(actor.actorId)) throw new ForbiddenException('Production mode is not enabled for this actor');
    if (!this.budget) throw new ServiceUnavailableException('PREFLIGHT_BUDGET_UNAVAILABLE');
    const availability = await this.budget.preflightAvailability(actor.actorId, spec.reserveCny);
    if (!availability.canProceed) throw new BadRequestException(availability.reason);
    let snapshot;
    try { snapshot = preflightSnapshot(body, spec); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'PREFLIGHT_INVALID'); }
    const task = await this.tasks.createPreview({
      actorId: actor.actorId, clientRequestId: `preflight:${randomUUID()}`,
      capability: 'IMAGE_TO_VIDEO', workflowName: snapshot.intent.workflowKey,
      workflowVersion: 'v1', requestSnapshot: snapshot, prompt: snapshot.intent.prompt.positive,
    });
    return { preflightId: task.id, expiresAt: new Date(new Date(task.createdAt).getTime() + PREFLIGHT_TTL_MS).toISOString(),
      status: 'preview', willCallProvider: false, willUploadMedia: false,
      intent: snapshot.intent, effectiveSpec: spec,
      checks: { parameters: 'passed', mediaMetadata: 'client_report_validated', actualFile: 'pending_upload',
        budget: 'available_now_rechecked_at_submission' } };
  }

  @Get('preflight/:id/check')
  async checkPreflight(@CurrentActor() actor: { actorId: string }, @Param('id') id: string) {
    const record = await this.tasks.findOneForActor(id, actor.actorId);
    const spec = loadProductionSpec();
    if (!spec || !this.budget) throw new ServiceUnavailableException('PRODUCTION_SPEC_UNAVAILABLE');
    if (!isProductionAllowed(actor.actorId)) throw new ForbiddenException('Production mode is not enabled for this actor');
    try { verifyPreflightRecord(record, actor.actorId, (record?.requestSnapshot as any)?.intent, spec); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'PREFLIGHT_INVALID'); }
    const availability = await this.budget.preflightAvailability(actor.actorId, spec.reserveCny);
    if (!availability.canProceed) throw new BadRequestException(availability.reason);
    return { valid: true, preflightId: id, willCallProvider: false };
  }

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', description: '同一 actor + 相同请求体只创建一次任务；同 key 不同请求体返回 409', required: true })
  async create(
    @CurrentActor() actor: { actorId: string },
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CreateTaskDto,
  ) {
    if (!idempotencyKey?.trim()) throw new ConflictException('Idempotency-Key is required');
    const mode = body?.mode ?? 'preview';
    if (mode !== 'preview' && mode !== 'production') throw new BadRequestException('mode must be "preview" or "production"');

    if (Object.keys(body ?? {}).some(k => !['workflowKey', 'prompt', 'generation', 'media', 'mode', 'preflightId', 'confirmLiveSubmission'].includes(k)) && body?.workflowKey) throw new BadRequestException('WORKFLOW_FIELDS_INVALID');
    const requestSnapshot = stableStringify(body);
    const existing = await this.tasks.findByActorRequest(actor.actorId, idempotencyKey);
    if (existing) {
      if (stableStringify(existing.requestSnapshot) !== requestSnapshot) throw new ConflictException('Idempotency-Key payload mismatch');
      return existing;
    }
    if (mode === 'production' && !isProductionAllowed(actor.actorId)) {
      throw new ForbiddenException('Production mode is not enabled for this actor');
    }

    const isWorkflowRequest = typeof (body as Record<string, unknown>)?.workflowKey === 'string';
    let capability: string;
    let profile: string;
    let prompt: string;
    let workflowName: string;
    let workflowVersion: string | undefined;
    let workflowDigest: string | undefined;
    let preview: object | null = null;
    let executionPlan: ProductionExecutionPlan | null = null;

    if (isWorkflowRequest || mode === 'production') {
      const spec = loadProductionSpec();
      if (mode === 'production' && (!spec || !this.assets)) throw new ServiceUnavailableException('PRODUCTION_SPEC_UNAVAILABLE');
      let normalized;
      try {
        normalized = normalizeWorkflowTaskRequest(body, spec);
      } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : 'INVALID_WORKFLOW_REQUEST');
      }
      capability = normalized.capability;
      profile = normalized.profile;
      prompt = normalized.prompt;
      workflowName = normalized.workflowKey;
      workflowVersion = normalized.workflowVersion;
      workflowDigest = workflowHash(workflowName, workflowVersion);
      if (normalized.status === 'disabled') {
        throw new BadRequestException('WORKFLOW_DISABLED');
      }
      if (mode === 'production' && normalized.status !== 'production_verified') {
        throw new BadRequestException('WORKFLOW_NOT_PRODUCTION_VERIFIED');
      }
      if (mode === 'preview') {
        preview = {
          mode: 'preview', workflowKey: workflowName, workflowVersion,
          capability, prompt, media: normalized.media,
          estimatedCostCny: null, costStatus: 'unavailable', willCallProvider: false,
        };
      } else {
        if (!spec || !this.assets) throw new ServiceUnavailableException('PRODUCTION_SPEC_UNAVAILABLE');
        const media = [] as { assetId: string; role: string; fileHash?: string | null }[];
        const inputAssets = [] as { id: string; mimeType: string | null; mediaMetadata: unknown }[];
        for (const item of normalized.media) {
          const inputAsset = await this.assets.findOwnedUploadedInput(item.assetId, actor.actorId);
          if (!inputAsset) throw new ForbiddenException('PRODUCTION_INPUT_NOT_OWNED');
          media.push({ ...item, fileHash: inputAsset.fileHash ?? null });
          inputAssets.push({ id: inputAsset.id, mimeType: inputAsset.mimeType ?? null, mediaMetadata: inputAsset.mediaMetadata });
        }
        try {
          validateWorkflowInputAssets(normalized.media, inputAssets);
        } catch (error) {
          throw new BadRequestException(error instanceof Error ? error.message : 'WORKFLOW_ASSET_INVALID');
        }
        // A historical preview or a client boolean is not a server preflight receipt.
        if (body.confirmLiveSubmission !== true || !body.preflightId) throw new BadRequestException('PREFLIGHT_CONFIRMATION_REQUIRED');
        const record = await this.tasks.findOneForActor(body.preflightId, actor.actorId);
        const descriptors = [];
        for (const item of normalized.media) {
          const asset = await this.assets.findOwnedUploadedInput(item.assetId, actor.actorId);
          if (!asset) throw new ForbiddenException('PRODUCTION_INPUT_NOT_OWNED');
          descriptors.push({ role: item.role, sha256: asset.fileHash, mimeType: asset.mimeType,
            sizeBytes: Number(asset.sizeBytes), metadata: asset.mediaMetadata });
        }
        const intent = { workflowKey: body.workflowKey, prompt: body.prompt, generation: body.generation, media: descriptors };
        try { verifyPreflightRecord(record, actor.actorId, intent, spec); }
        catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'PREFLIGHT_INVALID'); }
        if (!this.presign) throw new ServiceUnavailableException('PREFLIGHT_CONTENT_CHECK_UNAVAILABLE');
        for (let index = 0; index < normalized.media.length; index++) {
          const asset = await this.assets.findOwnedUploadedInput(normalized.media[index].assetId, actor.actorId);
          try { await this.presign.verifyObjectContent(asset!.objectKey, descriptors[index].sha256!, descriptors[index].sizeBytes); }
          catch { throw new BadRequestException('PREFLIGHT_ACTUAL_CONTENT_MISMATCH'); }
        }
        // Content verification may take time; do not accept a receipt that expired meanwhile.
        try { verifyPreflightRecord(record, actor.actorId, intent, spec); }
        catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'PREFLIGHT_INVALID'); }
        executionPlan = {
          specVersion: spec.version,
          pricingVersion: spec.pricingVersion,
          reserveCny: spec.reserveCny,
          model: spec.model,
          prompt,
          workflowKey: workflowName,
          workflowVersion,
          media,
          // 兼容尚未升级的 Worker；新 Worker 只读取 media。
          imageAssetId: media[0]?.assetId,
          inputFileHash: media[0]?.fileHash ?? null,
          duration: spec.duration,
          ratio: spec.ratio,
          resolution: spec.resolution,
          generateAudio: spec.generateAudio,
          watermark: spec.watermark,
          ...normalized.providerFields,
        };
      }
    } else {
      throw new BadRequestException('WORKFLOW_KEY_REQUIRED');
    }


    try {
      if (mode === 'production') {
        try {
          if (!this.budget || !executionPlan) throw new Error('Budget service is not configured');
          return await this.budget.createTaskWithReservation({
            actorId: actor.actorId,
            clientRequestId: idempotencyKey,
            estimatedCny: executionPlan.reserveCny,
            executionPlan,
            task: {
              createdBy: actor.actorId,
              capability,
              workflowName,
              workflowVersion,
              workflowHash: workflowDigest,
              requestSnapshot: body,
              prompt,
              status: 'pending',
            },
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : '';
          const reasonMap: Record<string, string> = {
            NO_CREDENTIAL: 'Credential not found', CREDENTIAL_INACTIVE: 'Credential is inactive',
            NO_LIMITS_CONFIGURED: 'Budget limits not configured', DAILY_LIMIT_EXCEEDED: 'Daily budget limit exceeded',
            MONTHLY_LIMIT_EXCEEDED: 'Monthly budget limit exceeded', DAILY_TASK_COUNT_EXCEEDED: 'Daily task count limit exceeded',
            GLOBAL_PENDING_LIMIT_EXCEEDED: 'Global pending task limit exceeded', PRODUCTION_PAUSED: 'Production is paused',
          };
          if (reasonMap[reason]) {
            throw new HttpException(reasonMap[reason], reason === 'PRODUCTION_PAUSED' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.TOO_MANY_REQUESTS);
          }
          throw error;
        }
      }
      const task = await this.tasks.createPreview({
        actorId: actor.actorId, clientRequestId: idempotencyKey, capability, workflowName,
        workflowVersion, workflowHash: workflowDigest, requestSnapshot: body, prompt,
      });
      return { ...task, preview };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.tasks.findByActorRequest(actor.actorId, idempotencyKey);
        if (raced && stableStringify(raced.requestSnapshot) === requestSnapshot) return raced;
        if (raced) throw new ConflictException('Idempotency-Key payload mismatch');
      }
      throw error;
    }
  }

  @Get(':id')
  async findOne(@CurrentActor() actor: { actorId: string }, @Param('id') id: string) {
    const task = await this.tasks.findSummaryForActor(id, actor.actorId);
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }
}
