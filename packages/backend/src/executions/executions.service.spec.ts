jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import { ExecutionsService, ExecutionMode, AttemptStatus } from './executions.service';

const mockExecutionAttempt = {
  findFirst: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};

const prisma: any = {
  executionAttempt: mockExecutionAttempt,
};

describe('ExecutionsService contract', () => {
  let service: ExecutionsService;

  beforeEach(() => {
    service = new ExecutionsService(prisma);
    mockExecutionAttempt.findFirst.mockReset();
    mockExecutionAttempt.create.mockReset();
    mockExecutionAttempt.update.mockReset();
  });

  it('createAttempt should create first attempt when no history exists', async () => {
    mockExecutionAttempt.findFirst.mockResolvedValue(null);
    mockExecutionAttempt.create.mockResolvedValue({ id: 'attempt-1' });

    await service.createAttempt('task-1', ExecutionMode.PRODUCTION, { provider: 'seedance' });

    expect(mockExecutionAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: 'task-1',
          attemptNo: 1,
          mode: ExecutionMode.PRODUCTION,
          provider: 'seedance',
          status: AttemptStatus.PENDING,
        }),
      }),
    );
  });

  it('createAttempt should auto increment attemptNo', async () => {
    mockExecutionAttempt.findFirst.mockResolvedValue({ attemptNo: 3 });
    mockExecutionAttempt.create.mockResolvedValue({ id: 'attempt-4' });

    await service.createAttempt('task-1', ExecutionMode.PREVIEW);

    expect(mockExecutionAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptNo: 4,
          mode: ExecutionMode.PREVIEW,
        }),
      }),
    );
  });

  it('recordProviderSubmission should persist provider task id and set submitted status', async () => {
    mockExecutionAttempt.update.mockResolvedValue({ id: 'attempt-1' });

    await service.recordProviderSubmission('attempt-1', 'provider-abc');

    expect(mockExecutionAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-1' },
        data: expect.objectContaining({
          providerTaskId: 'provider-abc',
          status: AttemptStatus.SUBMITTED,
        }),
      }),
    );
  });

  it('recordUsage should store provider usage and usage_calculated status', async () => {
    mockExecutionAttempt.update.mockResolvedValue({ id: 'attempt-1' });

    await service.recordUsage('attempt-1', { total_tokens: 1000 });

    expect(mockExecutionAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-1' },
        data: expect.objectContaining({
          providerUsage: { total_tokens: 1000 },
        }),
      }),
    );
  });

  it('markRequiresReview should write failure trace', async () => {
    mockExecutionAttempt.update.mockResolvedValue({ id: 'attempt-1' });

    await service.markRequiresReview('attempt-1', 'PAYLOAD_TIMEOUT', 'provider request uncertainty');

    expect(mockExecutionAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-1' },
        data: expect.objectContaining({
          status: AttemptStatus.REQUIRES_REVIEW,
          failureCode: 'PAYLOAD_TIMEOUT',
          failureMessage: 'provider request uncertainty',
        }),
      }),
    );
  });
});
