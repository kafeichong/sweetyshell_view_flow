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
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { TasksService } from '../../tasks/tasks.service';
import { TaskBudgetService } from '../../tasks/task-budget.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { buildPreviewPlan, validateTaskRequest } from './preview-plan';
import { isProductionAllowed } from './production-policy';

/**
 * 稳定序列化：递归按键名排序。
 * PostgreSQL 的 jsonb 会规范化键顺序，直接 JSON.stringify 比较会让同一份
 * payload 因键序不同被误判成"不同请求"并返回 409。
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value ?? null);
}

@Controller('v1/tasks')
@UseGuards(ApiCredentialGuard)
export class V1TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly budget?: TaskBudgetService,
  ) {}

  @Post()
  async create(
    @CurrentActor() actor: { actorId: string },
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CreateTaskDto,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new ConflictException('Idempotency-Key is required');
    }

    // 缺省 mode 必须走 Preview。历史行为是"不写 mode 就等于生产提交"，
    // 那会让任何一次误调用直接产生付费任务；安全默认值必须是 preview。
    const mode = body?.mode ?? 'preview';
    if (mode !== 'preview' && mode !== 'production') {
      throw new BadRequestException('mode must be "preview" or "production"');
    }

    // Production 按身份白名单开放，默认对所有人关闭。
    if (mode === 'production' && !isProductionAllowed(actor.actorId)) {
      throw new ForbiddenException(
        'Production mode is not enabled for this actor',
      );
    }

    // Preview 和 Production 共用同一套请求校验：校验失败必须在这里抛错，
    // 而不是变成一条等待 Worker 执行的付费任务。
    const validated = validateTaskRequest(body ?? {});
    const previewPlan = mode === 'preview' ? buildPreviewPlan(body ?? {}) : null;

    const requestSnapshot = stableStringify(body);
    const existing = await this.tasks.findByActorRequest(
      actor.actorId,
      idempotencyKey,
    );
    if (existing) {
      if (stableStringify(existing.requestSnapshot) !== requestSnapshot) {
        throw new ConflictException('Idempotency-Key payload mismatch');
      }
      return previewPlan ? { ...existing, preview: previewPlan } : existing;
    }

    try {
      if (!previewPlan) {
        // Production：创建可被 Worker 领取的真实任务（status='pending'）。
        // T02: 预算检查和预占
        const estimatedCny = '60.000000'; // MVP: 固定预估值，后续增强

        const executionPlan = {
          version: 'mvp-v1',
          model: 'doubao-seedance-2-5-260628',
          duration: 5,
          ratio: '16:9',
          resolution: '720p',
          generate_audio: false,
          watermark: true,
          pricingVersion: 'mvp-fixed-60-cny',
          reserveCny: estimatedCny,
        };

        try {
          if (!this.budget) {
            throw new Error('Budget service is not configured');
          }
          return await this.budget.createTaskWithReservation({
            actorId: actor.actorId,
            clientRequestId: idempotencyKey,
            estimatedCny,
            executionPlan,
            task: {
              createdBy: actor.actorId,
              capability: validated.capability,
              workflowName: validated.profile,
              requestSnapshot: body,
              prompt: validated.prompt,
              imageUrl:
                typeof validated.params.image_url === 'string'
                  ? validated.params.image_url
                  : undefined,
              status: 'pending',
            },
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : '';
          const reasonMap: Record<string, string> = {
            NO_CREDENTIAL: 'Credential not found',
            CREDENTIAL_INACTIVE: 'Credential is inactive',
            NO_LIMITS_CONFIGURED: 'Budget limits not configured',
            DAILY_LIMIT_EXCEEDED: 'Daily budget limit exceeded',
            MONTHLY_LIMIT_EXCEEDED: 'Monthly budget limit exceeded',
            PRODUCTION_PAUSED: 'Production is paused',
          };
          if (reasonMap[reason]) {
            const status = reason === 'PRODUCTION_PAUSED'
              ? HttpStatus.SERVICE_UNAVAILABLE
              : HttpStatus.TOO_MANY_REQUESTS;
            throw new HttpException(reasonMap[reason], status);
          }
          throw error;
        }
      }

      const task = await this.tasks.createPreview({
        actorId: actor.actorId,
        clientRequestId: idempotencyKey,
        capability: validated.capability,
        workflowName: validated.profile,
        requestSnapshot: body,
        prompt: validated.prompt,
        imageUrl:
          typeof validated.params.image_url === 'string'
            ? validated.params.image_url
            : undefined,
      });

      return { ...task, preview: previewPlan };
    } catch (error) {
      // 并发提交同一 Idempotency-Key 时唯一约束会抛 P2002，回读既有任务而不是返回 500。
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.tasks.findByActorRequest(
          actor.actorId,
          idempotencyKey,
        );
        if (raced && stableStringify(raced.requestSnapshot) === requestSnapshot) {
          return previewPlan ? { ...raced, preview: previewPlan } : raced;
        }
        if (raced) {
          throw new ConflictException('Idempotency-Key payload mismatch');
        }
      }
      throw error;
    }
  }

  @Get(':id')
  async findOne(@CurrentActor() actor: { actorId: string }, @Param('id') id: string) {
    const task = await this.tasks.findOneForActor(id, actor.actorId);
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }
}
