import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AdminTokenGuard } from '../../auth/admin-token.guard';
import { AssetsService } from '../../assets/assets.service';
import { AssetPresignService } from '../../assets/asset-presign.service';
import { TaskListService } from '../tasks/task-list.service';

@ApiTags('admin-history')
@ApiSecurity('admin-token')
@Controller('v1/admin/history')
@UseGuards(AdminTokenGuard)
export class V1AdminHistoryController {
  constructor(
    private readonly taskList: TaskListService,
    private readonly assets: AssetsService,
    private readonly presign: AssetPresignService,
  ) {}

  @Get('tasks')
  @ApiOperation({ summary: '管理员查看全站任务历史' })
  listTasks(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('status') status?: string,
    @Query('workflowKey') workflowKey?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.taskList.listAllTasks({
      page: Math.max(parseInt(page, 10) || 1, 1),
      limit: Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100),
      status,
      workflowKey,
      startDate,
      endDate,
    });
  }

  @Get('tasks/:taskId')
  @ApiOperation({ summary: '管理员查看任意任务详情' })
  getTaskDetail(@Param('taskId') taskId: string) {
    return this.taskList.getAnyTaskDetail(taskId);
  }

  @Get('assets/:assetId/download')
  @ApiOperation({ summary: '管理员获取任务素材短时下载地址' })
  async downloadAsset(@Param('assetId') assetId: string) {
    const asset = await this.assets.findUploadedById(assetId);
    if (!asset) throw new NotFoundException('Asset not found');
    return this.presign.createDownloadUrl(asset.objectKey);
  }
}
