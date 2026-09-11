import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TaskClaimService } from './task-claim.service';
import { WorkerServiceGuard } from '../auth/worker-service.guard';
import { AdminTokenGuard } from '../auth/admin-token.guard';

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly taskClaimService: TaskClaimService,
  ) {}

  /**
   * 创建任务
   * POST /api/tasks
   */
  @Post()
  @UseGuards(AdminTokenGuard)
  async create(
    @Body()
    body: {
      createdBy: string;
      prompt: string;
      imageUrl?: string;
    },
  ) {
    return this.tasksService.create(body);
  }

  /**
   * 查询所有任务
   * GET /api/tasks?status=pending&createdBy=张三
   */
  @Get()
  @UseGuards(AdminTokenGuard)
  async findAll(
    @Query('status') status?: string,
    @Query('createdBy') createdBy?: string,
  ) {
    return this.tasksService.findAll({ status, createdBy });
  }

  /**
   * 查询待处理任务（Worker 轮询用）
   * GET /api/tasks/pending
   */
  @Get('pending')
  @UseGuards(AdminTokenGuard)
  async findPending() {
    return this.tasksService.findPending();
  }

  /**
   * Worker 安全 claim：一次返回 1 个待执行任务，避免并发重复拿取。
   * Worker 私有接口，必须携带 X-Worker-Token。
   */
  @Post('claim')
  @UseGuards(WorkerServiceGuard)
  async claim(
    @Body()
    body?: { mode?: 'preview' | 'production' | 'comfyui'; workerId?: string },
  ) {
    const mode = body?.mode ?? 'production';
    const workerId = body?.workerId;

    return this.taskClaimService.claimNext(workerId, mode);
  }

  /**
   * Worker 恢复队列：返回 in_progress 的任务用于重连 provider 轮询。
   */
  @Get('recover')
  @UseGuards(WorkerServiceGuard)
  async recover() {
    return this.taskClaimService.findRecoverable();
  }

  /**
   * 查询单个任务
   * GET /api/tasks/:id
   */
  @Get(':id')
  @UseGuards(AdminTokenGuard)
  async findOne(@Param('id') id: string) {
    return this.tasksService.findOne(id);
  }

  /**
   * 更新任务状态（Worker 用）
   * PATCH /api/tasks/:id
   */
  @Patch(':id')
  @UseGuards(WorkerServiceGuard)
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      status?: string;
      cost?: number;
      taskStatus?: string;
      videoUrl?: string;
      attemptId?: string;
      attemptStatus?: string;
      attemptModel?: string;
      providerTaskId?: string;
      failureType?: string;
      failureCode?: string;
      failureMessage?: string;
      providerUsage?: Record<string, unknown> | null;
      costStatus?: string;
      actualCostCny?: number;
      pricingVersion?: string;
      estimatedCostCny?: number;
      usageCalculatedCostCny?: number;
      billedCostCny?: number;
      startedAt?: string;
      submittedAt?: string;
      finishedAt?: string;
    },
  ) {
    const updateData: any = { ...body };

    // 如果任务完成或失败，设置完成时间
    if (body.status === 'completed' || body.status === 'failed') {
      updateData.completedAt = new Date();
    }

    return this.tasksService.update(id, updateData);
  }

}
