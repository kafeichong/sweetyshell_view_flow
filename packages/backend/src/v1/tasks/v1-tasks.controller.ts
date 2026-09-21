import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
  SetMetadata,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { ApiCredentialGuard } from '../../auth/api-credential.guard';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { PreflightRecordError, PreflightService } from '../../tasks/preflight.service';
import { ProductionSubmissionError, ProductionSubmissionService } from '../../tasks/production-submission.service';
import { TasksService } from '../../tasks/tasks.service';
import { WorkflowCatalogService, WorkflowContractError } from '../../tasks/workflow-catalog.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { TaskListService } from './task-list.service';
import { TaskShowcaseService } from './task-showcase.service';

@ApiTags('tasks')
@ApiBearerAuth('actor-token')
@Controller('v1/tasks')
@UseGuards(ApiCredentialGuard)
export class V1TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly preflightService: PreflightService,
    private readonly workflowCatalog: WorkflowCatalogService,
    private readonly productionSubmission: ProductionSubmissionService,
    private readonly taskListService: TaskListService,
    private readonly showcaseService: TaskShowcaseService,
  ) {}

  @Get('/workflows')
  workflows() {
    return this.workflowCatalog.directory();
  }

  @Get('/showcase/tasks')
  @SetMetadata('isPublic', true)
  async getShowcaseTasks(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.showcaseService.getShowcaseTasks(pageNum, limitNum);
  }

  @Get('/showcase/tasks/:id')
  @SetMetadata('isPublic', true)
  async getShowcaseTaskDetail(@Param('id') id: string) {
    return this.showcaseService.getTaskDetail(id);
  }

  @Get('/showcase/videos/:assetId')
  @SetMetadata('isPublic', true)
  async getShowcaseVideoUrl(@Param('assetId') assetId: string) {
    return this.showcaseService.getVideoPreviewUrl(assetId);
  }

  @Get()
  async listTasks(
    @CurrentActor() actor: { actorId: string },
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('status') status?: string,
    @Query('workflowKey') workflowKey?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    return this.taskListService.listTasks(actor.actorId, {
      page: pageNum,
      limit: limitNum,
      status,
      workflowKey,
      startDate,
      endDate,
    });
  }

  @Post('preflight')
  async preview(@CurrentActor() actor: { actorId: string }, @Body() body: unknown) {
    try {
      return await this.preflightService.preview(actor.actorId, body);
    } catch (error) {
      this.rethrowPreflightError(error);
    }
  }

  @Get('preflight/:id/check')
  async checkPreflight(@CurrentActor() actor: { actorId: string }, @Param('id') id: string) {
    try {
      return await this.preflightService.check(actor.actorId, id);
    } catch (error) {
      this.rethrowPreflightError(error);
    }
  }

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', description: '确保同一执行槽的同一次提交只创建一个正式任务', required: true })
  async create(
    @CurrentActor() actor: { actorId: string },
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CreateTaskDto,
  ) {
    if (!idempotencyKey?.trim()) throw new ConflictException('Idempotency-Key is required');
    const mode = body?.mode ?? 'preview';
    if (mode === 'preview') {
      throw new BadRequestException({
        code: 'PREVIEW_TASK_CREATION_RETIRED',
        path: 'mode',
        message: 'Use POST /api/v1/tasks/preflight for Preview',
      });
    }
    if (mode !== 'production') throw new BadRequestException({ code: 'WORKFLOW_MODE_INVALID', path: 'mode' });
    const { mode: _mode, ...submission } = body;
    try {
      return await this.productionSubmission.submit(actor.actorId, idempotencyKey.trim(), submission);
    } catch (error) {
      if (error instanceof ProductionSubmissionError) {
        if (error.code === 'IDEMPOTENCY_KEY_REUSED') throw new ConflictException({ code: error.code, path: error.path });
        if (error.code === 'PRODUCTION_NOT_ALLOWED') throw new ForbiddenException({ code: error.code, path: error.path });
        throw new BadRequestException({ code: error.code, path: error.path, message: error.message });
      }
      if (error instanceof Error && error.message === 'PRODUCTION_PAUSED') {
        throw new ServiceUnavailableException('PRODUCTION_PAUSED');
      }
      if (error instanceof Error && [
        'NO_CREDENTIAL', 'CREDENTIAL_INACTIVE', 'NO_LIMITS_CONFIGURED',
        'DAILY_LIMIT_EXCEEDED', 'MONTHLY_LIMIT_EXCEEDED',
        'DAILY_TASK_COUNT_EXCEEDED', 'GLOBAL_PENDING_LIMIT_EXCEEDED',
      ].includes(error.message)) {
        throw new HttpException(error.message, HttpStatus.TOO_MANY_REQUESTS);
      }
      throw error;
    }
  }

  @Get('slots/:slotId/current')
  async findCurrentSlot(
    @CurrentActor() actor: { actorId: string },
    @Param('slotId') executionSlotId: string,
  ) {
    const currentTask = await this.tasks.findCurrentForSlot(actor.actorId, executionSlotId);
    return { executionSlotId, currentTask };
  }

  @Post(':id/client-delivery')
  async confirmClientDelivery(
    @CurrentActor() actor: { actorId: string },
    @Param('id') id: string,
  ) {
    return this.tasks.confirmClientDelivery(id, actor.actorId);
  }

  @Get(':id/detail')
  async getTaskDetail(@CurrentActor() actor: { actorId: string }, @Param('id') id: string) {
    return this.taskListService.getTaskDetail(actor.actorId, id);
  }

  @Get(':id')
  async findOne(@CurrentActor() actor: { actorId: string }, @Param('id') id: string) {
    const task = await this.tasks.findSummaryForActor(id, actor.actorId);
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  private rethrowPreflightError(error: unknown): never {
    if (error instanceof WorkflowContractError) {
      throw new BadRequestException({ code: error.code, path: error.path, message: error.message });
    }
    if (error instanceof PreflightRecordError) {
      throw new BadRequestException({ code: error.code, path: 'preflightId', message: error.message });
    }
    throw error;
  }
}
