import { Controller, Get, Query } from '@nestjs/common';
import { TaskShowcaseService } from './task-showcase.service';

@Controller('v1/showcase')
export class TaskShowcaseController {
  constructor(private readonly showcaseService: TaskShowcaseService) {}

  @Get('tasks')
  async getShowcaseTasks(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    return this.showcaseService.getShowcaseTasks(pageNum, limitNum);
  }
}
