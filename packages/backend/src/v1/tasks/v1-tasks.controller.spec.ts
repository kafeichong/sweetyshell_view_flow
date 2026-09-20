jest.mock('ali-oss', () => class OSS {});
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  createParamDecorator: () => () => () => {},
  Controller: () => (target: unknown) => target,
  UseGuards: () => (target: unknown) => target,
  Post: () => () => {}, Get: () => () => {}, Body: () => () => {}, Headers: () => () => {}, Param: () => () => {},
  Query: () => () => {},
  ConflictException: class ConflictException extends Error { status = 409; },
  BadRequestException: class BadRequestException extends Error { status = 400; response: unknown; constructor(value: unknown) { super(typeof value === 'string' ? value : 'Bad Request'); this.response = value; } },
  ForbiddenException: class ForbiddenException extends Error { status = 403; },
  HttpStatus: { TOO_MANY_REQUESTS: 429 },
  HttpException: class HttpException extends Error { status: number; constructor(value: unknown, status: number) { super(String(value)); this.status = status; } },
  NotFoundException: class NotFoundException extends Error { status = 404; },
  ServiceUnavailableException: class ServiceUnavailableException extends Error { status = 503; },
  Logger: class Logger { log() {} },
}));

import { PreflightRecordError } from '../../tasks/preflight.service';
import { ProductionSubmissionError } from '../../tasks/production-submission.service';
import { WorkflowContractError } from '../../tasks/workflow-catalog.service';
import { V1TasksController } from './v1-tasks.controller';

describe('V1TasksController v2 workflow API', () => {
  const tasks = {
    findSummaryForActor: jest.fn(),
    findCurrentForSlot: jest.fn(),
    confirmClientDelivery: jest.fn(),
  };
  const report = {
    preflightId: 'preflight-1',
    requestCheck: { status: 'passed', items: [] },
    productionAdmission: { canSubmit: false, blockers: [] },
    willUploadMedia: false,
    willCallProvider: false,
  };
  const preflight = { preview: jest.fn().mockResolvedValue(report), check: jest.fn().mockResolvedValue(report) };
  const directory = {
    contractVersion: 2,
    contractRevision: '2026-09-15.3',
    contractDigest: 'd'.repeat(64),
    model: 'doubao-seedance-2-5-260628',
    workflows: [{ key: 'seedance.text-to-video.v1' }],
  };
  const catalog = { directory: jest.fn().mockReturnValue(directory) };
  const submission = { submit: jest.fn().mockResolvedValue({ id: 'task-1', status: 'pending', deduplicated: false }) };
  const taskListService = {
    listTasks: jest.fn(),
    getTaskDetail: jest.fn(),
  };
  const showcaseService = {
    getShowcaseTasks: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIDEO_FLOW_PRODUCTION_ACTORS = 'creative-pilot';
  });

  it('returns the shared contract catalog', () => {
    expect(new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never).workflows()).toEqual(directory);
  });

  it('delegates Preview without applying a controller-level Production whitelist gate', async () => {
    delete process.env.VIDEO_FLOW_PRODUCTION_ACTORS;
    const body = { contractVersion: 2, workflowKey: 'seedance.text-to-video.v1' };
    await expect(new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never)
      .preview({ actorId: 'creative-pilot' }, body)).resolves.toBe(report);
    expect(preflight.preview).toHaveBeenCalledWith('creative-pilot', body);
  });

  it('returns a structured 400 for malformed contract input', async () => {
    preflight.preview.mockRejectedValueOnce(new WorkflowContractError('WORKFLOW_FIELDS_INVALID', 'model'));
    await expect(new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never)
      .preview({ actorId: 'creative-pilot' }, { model: 'client-model' })).rejects.toMatchObject({
        status: 400,
        response: { code: 'WORKFLOW_FIELDS_INVALID', path: 'model' },
      });
  });

  it('delegates preflight recheck and maps a missing record', async () => {
    const controller = new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never);
    await expect(controller.checkPreflight({ actorId: 'creative-pilot' }, 'preflight-1')).resolves.toBe(report);
    preflight.check.mockRejectedValueOnce(new PreflightRecordError('PREFLIGHT_REQUIRED'));
    await expect(controller.checkPreflight({ actorId: 'creative-pilot' }, 'missing')).rejects.toMatchObject({
      status: 400,
      response: { code: 'PREFLIGHT_REQUIRED', path: 'preflightId' },
    });
  });

  it('retires Task-based Preview creation with a recognizable upgrade error', async () => {
    await expect(new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never).create(
      { actorId: 'creative-pilot' }, 'preview-1', { mode: 'preview' },
    )).rejects.toMatchObject({ status: 400, response: { code: 'PREVIEW_TASK_CREATION_RETIRED' } });
  });

  it('delegates an authenticated slot-bound Production request to the sole submission service', async () => {
    const controller = new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never);
    const body = {
      mode: 'production' as const, preflightId: 'preflight-1', executionSlotId: 'slot-1', media: [],
    };
    await expect(controller.create({ actorId: 'creative-pilot' }, 'prod-2', body)).resolves.toMatchObject({ id: 'task-1' });
    expect(submission.submit).toHaveBeenCalledWith('creative-pilot', 'prod-2', {
      preflightId: 'preflight-1', executionSlotId: 'slot-1', media: [],
    });
  });

  it('maps a formal submission contract failure without exposing a paid fallback', async () => {
    submission.submit.mockRejectedValueOnce(new ProductionSubmissionError('PREFLIGHT_EXPIRED', 'preflightId'));
    const controller = new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never);
    await expect(controller.create({ actorId: 'creative-pilot' }, 'prod-3', {
      mode: 'production', preflightId: 'preflight-1', executionSlotId: 'slot-1', media: [],
    })).rejects.toMatchObject({
      status: 400, response: { code: 'PREFLIGHT_EXPIRED', path: 'preflightId' },
    });
  });

  it.each([
    [new ProductionSubmissionError('PRODUCTION_NOT_ALLOWED', 'productionAdmission.actor'), 403],
    [new Error('DAILY_LIMIT_EXCEEDED'), 429],
  ])('maps Production admission failure %s to its explicit HTTP boundary', async (failure, status) => {
    submission.submit.mockRejectedValueOnce(failure);
    const controller = new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never);
    await expect(controller.create({ actorId: 'creative-pilot' }, 'prod-gated', {
      mode: 'production', preflightId: 'preflight-1', executionSlotId: 'slot-1', media: [],
    })).rejects.toMatchObject({ status });
  });

  it('keeps authorized existing-task lookup independent from new preflight admission', async () => {
    tasks.findSummaryForActor.mockResolvedValueOnce({ id: 'task-1', status: 'completed' });
    await expect(new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never)
      .findOne({ actorId: 'creative-pilot' }, 'task-1')).resolves.toMatchObject({ id: 'task-1' });
    expect(preflight.check).not.toHaveBeenCalled();
  });

  it('returns the Backend-authoritative current execution-slot Task without new-task admission checks', async () => {
    tasks.findCurrentForSlot.mockResolvedValueOnce({ id: 'task-current', status: 'running' });
    const controller = new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never);
    await expect(controller.findCurrentSlot({ actorId: 'creative-pilot' }, 'slot-1')).resolves.toEqual({
      executionSlotId: 'slot-1', currentTask: { id: 'task-current', status: 'running' },
    });
    expect(preflight.check).not.toHaveBeenCalled();
  });

  it('delegates client-delivery confirmation with Task ownership enforced by TasksService', async () => {
    tasks.confirmClientDelivery.mockResolvedValueOnce({ taskId: 'task-1', clientDeliveryStatus: 'delivered', applied: true });
    const controller = new V1TasksController(tasks as never, preflight as never, catalog as never, submission as never, taskListService as never, showcaseService as never);
    await expect(controller.confirmClientDelivery({ actorId: 'creative-pilot' }, 'task-1')).resolves.toMatchObject({
      taskId: 'task-1', clientDeliveryStatus: 'delivered', applied: true,
    });
    expect(tasks.confirmClientDelivery).toHaveBeenCalledWith('task-1', 'creative-pilot');
  });
});
