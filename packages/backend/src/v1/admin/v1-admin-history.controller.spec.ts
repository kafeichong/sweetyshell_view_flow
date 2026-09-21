jest.mock('ali-oss', () => class OSS {});
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Controller: () => (target: unknown) => target,
  UseGuards: () => (target: unknown) => target,
  Get: () => () => {},
  Query: () => () => {},
  Param: () => () => {},
  NotFoundException: class NotFoundException extends Error { status = 404; },
}));
jest.mock('@nestjs/swagger', () => ({
  ApiTags: () => (target: unknown) => target,
  ApiSecurity: () => (target: unknown) => target,
  ApiOperation: () => () => {},
}));

import { V1AdminHistoryController } from './v1-admin-history.controller';

describe('V1AdminHistoryController', () => {
  const taskList = {
    listAllTasks: jest.fn(),
    getAnyTaskDetail: jest.fn(),
  };
  const assets = { findUploadedById: jest.fn() };
  const presign = { createDownloadUrl: jest.fn() };
  const controller = new V1AdminHistoryController(taskList as never, assets as never, presign as never);

  beforeEach(() => jest.clearAllMocks());

  it('lists all tasks without an actor scope', async () => {
    taskList.listAllTasks.mockResolvedValue({ tasks: [], pagination: { page: 1 } });

    await controller.listTasks('1', '20');

    expect(taskList.listAllTasks).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      status: undefined,
      workflowKey: undefined,
      startDate: undefined,
      endDate: undefined,
    });
  });

  it('returns any task detail to an authenticated administrator', async () => {
    taskList.getAnyTaskDetail.mockResolvedValue({ id: 'task-1', actorId: 'actor-1' });

    await expect(controller.getTaskDetail('task-1')).resolves.toMatchObject({ id: 'task-1' });
  });

  it('signs only an uploaded asset found by the admin-safe lookup', async () => {
    assets.findUploadedById.mockResolvedValue({ id: 'asset-1', objectKey: 'inputs/a.png' });
    presign.createDownloadUrl.mockReturnValue({ downloadUrl: 'https://signed', expiresIn: 300 });

    await expect(controller.downloadAsset('asset-1')).resolves.toEqual({ downloadUrl: 'https://signed', expiresIn: 300 });
    expect(presign.createDownloadUrl).toHaveBeenCalledWith('inputs/a.png');
  });
});
