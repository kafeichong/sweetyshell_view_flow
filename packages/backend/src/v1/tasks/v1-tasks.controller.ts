import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { TasksService } from '../../tasks/tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';

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
  constructor(private readonly tasks: TasksService) {}

  @Post()
  async create(
    @CurrentActor() actor: { actorId: string },
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CreateTaskDto,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new ConflictException('Idempotency-Key is required');
    }

    if (body?.mode === 'production') {
      // README 已声明 Production 入口尚未开放，这里做服务端强制，而不是只靠客户端自律。
      throw new BadRequestException('Production mode is not open yet');
    }

    if (!body?.capability || !body?.profile || !body?.params || typeof body.params !== 'object') {
      throw new BadRequestException('capability, profile and params are required');
    }

    const requestSnapshot = stableStringify(body);
    const existing = await this.tasks.findByActorRequest(
      actor.actorId,
      idempotencyKey,
    );
    if (existing) {
      if (stableStringify(existing.requestSnapshot) !== requestSnapshot) {
        throw new ConflictException('Idempotency-Key payload mismatch');
      }
      return existing;
    }

    try {
      return await this.tasks.createV1({
        actorId: actor.actorId,
        clientRequestId: idempotencyKey,
        capability: body.capability,
        workflowName: body.profile,
        requestSnapshot: body,
        prompt: String(body.params?.prompt ?? ''),
        imageUrl:
          typeof body.params?.image_url === 'string' ? body.params.image_url : undefined,
      });
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
          return raced;
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
