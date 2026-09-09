import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  /**
   * 创建任务
   * POST /api/tasks
   */
  @Post()
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
  async findPending() {
    return this.tasksService.findPending();
  }

  /**
   * 查询单个任务
   * GET /api/tasks/:id
   */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.tasksService.findOne(id);
  }

  /**
   * 更新任务状态（Worker 用）
   * PATCH /api/tasks/:id
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      status?: string;
      videoUrl?: string;
      errorMsg?: string;
      cost?: number;
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
