jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  BadRequestException: class BadRequestException extends Error { status = 400; },
  ConflictException: class ConflictException extends Error { status = 409; },
  NotFoundException: class NotFoundException extends Error { status = 404; },
}));

import { ExecutionsService, ExecutionMode, AttemptStatus } from './executions.service';
import { PricingCatalog } from '../tasks/pricing-catalog';

const mockExecutionAttempt = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};

const mockTask = {
  update: jest.fn(),
  findUnique: jest.fn(),
};

const prisma: any = {
  executionAttempt: mockExecutionAttempt,
  task: mockTask,
  $transaction: jest.fn(),
};

const budget = {
  settleInTransaction: jest.fn(),
  holdForReviewInTransaction: jest.fn(),
};

const executionPlan = {
  pricingVersion: 'seedance-token-v1',
  model: 'doubao-seedance-2-5-260628',
};

const attemptRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'attempt-1',
  taskId: 'task-1',
  status: 'running',
  providerTaskId: 'provider-1',
  providerUsage: null,
  costStatus: 'unavailable',
  usageCalculatedCostCny: null,
  pricingVersion: null,
  task: {
    id: 'task-1',
    executionPlan,
    status: 'running',
    taskStatus: 'in_progress',
    deliveryStatus: 'not_started',
    cost: null,
  },
  ...overrides,
});

describe('ExecutionsService contract', () => {
  let service: ExecutionsService;

  beforeEach(() => {
    service = new ExecutionsService(prisma, budget as never);
    mockExecutionAttempt.findFirst.mockReset();
    mockExecutionAttempt.findUnique.mockReset();
    mockExecutionAttempt.create.mockReset();
    mockExecutionAttempt.update.mockReset();
    mockTask.update.mockReset();
    mockTask.findUnique.mockReset();
    budget.settleInTransaction.mockReset();
    budget.holdForReviewInTransaction.mockReset();
    prisma.$transaction.mockReset();
    prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
    mockTask.findUnique.mockImplementation(async () => ({
      id: 'task-1',
      taskStatus: 'in_progress',
      deliveryStatus: 'archiving',
    }));
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

  describe('recordProviderOutcome', () => {
    it('settles the budget from frozen usage before archiving', async () => {
      mockExecutionAttempt.findUnique.mockResolvedValue(attemptRecord());
      mockExecutionAttempt.update.mockResolvedValue({ id: 'attempt-1' });
      mockTask.update.mockResolvedValue({ id: 'task-1' });

      const result = await service.recordProviderOutcome('attempt-1', {
        providerTaskId: 'provider-1',
        status: 'succeeded',
        usage: { total_tokens: 10000 },
      });

      expect(result.outcome).toBe('applied');
      expect(result.cost).toEqual({
        status: 'usage_calculated',
        amountCny: '0.700000',
        pricingVersion: 'seedance-token-v1',
      });
      expect(budget.settleInTransaction).toHaveBeenCalledWith(prisma, 'task-1', '0.700000');
      expect(budget.holdForReviewInTransaction).not.toHaveBeenCalled();
      expect(mockExecutionAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: AttemptStatus.COMPLETED,
            providerUsage: { total_tokens: 10000 },
            pricingVersion: 'seedance-token-v1',
          }),
        }),
      );
      // Provider 成功但产物还没交付：Task 进 archiving，不是 completed。
      expect(mockTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'archiving',
            taskStatus: 'in_progress',
            deliveryStatus: 'archiving',
          }),
        }),
      );
    });

    it('passes the complete frozen pricing snapshot into settlement', async () => {
      const snapshot = new PricingCatalog({
        confirmedPromotionIds: ['seedance-2.5-1080p-2026-08-14-2026-09-17'],
      }).select('doubao-seedance-2-5-260628', '1080p', false, new Date('2026-09-17T05:45:00.000Z'))!;
      mockExecutionAttempt.findUnique.mockResolvedValue(attemptRecord({
        task: {
          ...attemptRecord().task,
          executionPlan: {
            pricingVersion: snapshot.pricingVersion,
            model: snapshot.model,
            resolution: '1080p',
            pricingSnapshot: snapshot,
          },
        },
      }));
      mockExecutionAttempt.update.mockResolvedValue({ id: 'attempt-1' });
      mockTask.update.mockResolvedValue({ id: 'task-1' });

      const result = await service.recordProviderOutcome('attempt-1', {
        providerTaskId: 'provider-1',
        status: 'succeeded',
        usage: { completion_tokens: 100000 },
      });

      expect(result.cost.amountCny).toBe('5.544000');
      expect(budget.settleInTransaction).toHaveBeenCalledWith(prisma, 'task-1', '5.544000');
    });

    it('keeps the reservation in review but still allows archiving when usage is missing', async () => {
      mockExecutionAttempt.findUnique.mockResolvedValue(attemptRecord());
      mockExecutionAttempt.update.mockResolvedValue({ id: 'attempt-1' });
      mockTask.update.mockResolvedValue({ id: 'task-1' });

      const result = await service.recordProviderOutcome('attempt-1', {
        providerTaskId: 'provider-1',
        status: 'succeeded',
        usage: null,
      });

      expect(result.outcome).toBe('applied');
      expect(result.cost).toEqual({
        status: 'unavailable',
        amountCny: null,
        pricingVersion: null,
        reason: 'MISSING_USAGE',
      });
      expect(budget.settleInTransaction).not.toHaveBeenCalled();
      expect(budget.holdForReviewInTransaction).toHaveBeenCalledWith(prisma, 'task-1');
      // 费用未知不能阻止把已经生成的视频交出去。
      expect(mockTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'archiving', deliveryStatus: 'archiving' }),
        }),
      );
    });

    it('is idempotent for a repeated identical outcome', async () => {
      mockExecutionAttempt.findUnique.mockResolvedValue(
        attemptRecord({
          status: 'completed',
          providerUsage: { total_tokens: 10000 },
          costStatus: 'usage_calculated',
          usageCalculatedCostCny: 0.7,
          pricingVersion: 'seedance-token-v1',
        }),
      );

      const result = await service.recordProviderOutcome('attempt-1', {
        providerTaskId: 'provider-1',
        status: 'succeeded',
        usage: { total_tokens: 10000 },
      });

      expect(result.outcome).toBe('idempotent');
      expect(result.cost.amountCny).toBe('0.700000');
      expect(budget.settleInTransaction).not.toHaveBeenCalled();
      expect(mockExecutionAttempt.update).not.toHaveBeenCalled();
      expect(mockTask.update).not.toHaveBeenCalled();
    });

    it('sends conflicting usage to review without overwriting existing evidence', async () => {
      mockExecutionAttempt.findUnique.mockResolvedValue(
        attemptRecord({
          status: 'completed',
          providerUsage: { total_tokens: 10000 },
          costStatus: 'usage_calculated',
          usageCalculatedCostCny: 0.7,
          pricingVersion: 'seedance-token-v1',
        }),
      );

      const result = await service.recordProviderOutcome('attempt-1', {
        providerTaskId: 'provider-1',
        status: 'succeeded',
        usage: { total_tokens: 20000 },
      });

      expect(result.outcome).toBe('review');
      expect(budget.holdForReviewInTransaction).toHaveBeenCalledWith(prisma, 'task-1');
      expect(budget.settleInTransaction).not.toHaveBeenCalled();
      expect(mockExecutionAttempt.update).not.toHaveBeenCalled();
    });

    it('does not overwrite a completed attempt with a later failure', async () => {
      mockExecutionAttempt.findUnique.mockResolvedValue(
        attemptRecord({
          status: 'completed',
          providerUsage: { total_tokens: 10000 },
          costStatus: 'usage_calculated',
          usageCalculatedCostCny: 0.7,
        }),
      );

      const result = await service.recordProviderOutcome('attempt-1', {
        providerTaskId: 'provider-1',
        status: 'failed',
        errorCode: 'PROVIDER_ERROR',
      });

      expect(result.outcome).toBe('review');
      expect(mockExecutionAttempt.update).not.toHaveBeenCalled();
    });

    it('settles a failed generation when usage proves it was charged', async () => {
      mockExecutionAttempt.findUnique.mockResolvedValue(attemptRecord());
      mockExecutionAttempt.update.mockResolvedValue({ id: 'attempt-1' });
      mockTask.update.mockResolvedValue({ id: 'task-1' });

      const result = await service.recordProviderOutcome('attempt-1', {
        providerTaskId: 'provider-1',
        status: 'failed',
        usage: { total_tokens: 5000 },
        errorCode: 'CONTENT_POLICY',
      });

      expect(result.outcome).toBe('applied');
      expect(budget.settleInTransaction).toHaveBeenCalledWith(prisma, 'task-1', '0.350000');
      expect(mockTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            taskStatus: 'failed',
            deliveryStatus: 'not_started',
          }),
        }),
      );
    });

    it('never infers a free generation from a failed HTTP status', async () => {
      mockExecutionAttempt.findUnique.mockResolvedValue(attemptRecord());
      mockExecutionAttempt.update.mockResolvedValue({ id: 'attempt-1' });
      mockTask.update.mockResolvedValue({ id: 'task-1' });

      const result = await service.recordProviderOutcome('attempt-1', {
        providerTaskId: 'provider-1',
        status: 'failed',
        errorCode: 'PROVIDER_ERROR',
      });

      expect(result.outcome).toBe('applied');
      // 没有收费证据时保留预占，不能据此释放（释放等于宣称这次没花钱）。
      expect(budget.holdForReviewInTransaction).toHaveBeenCalledWith(prisma, 'task-1');
      expect(budget.settleInTransaction).not.toHaveBeenCalled();
    });

    it('marks unknown pricing versions unavailable instead of applying a formula', async () => {
      mockExecutionAttempt.findUnique.mockResolvedValue(
        attemptRecord({
          task: {
            id: 'task-1',
            executionPlan: { pricingVersion: 'not-verified', model: 'doubao-seedance-2-5-260628' },
            status: 'running',
            taskStatus: 'in_progress',
            deliveryStatus: 'not_started',
          },
        }),
      );
      mockExecutionAttempt.update.mockResolvedValue({ id: 'attempt-1' });
      mockTask.update.mockResolvedValue({ id: 'task-1' });

      const result = await service.recordProviderOutcome('attempt-1', {
        providerTaskId: 'provider-1',
        status: 'succeeded',
        usage: { total_tokens: 10000 },
      });

      expect(result.cost.status).toBe('unavailable');
      expect(result.cost.reason).toBe('UNKNOWN_PRICING_VERSION');
      expect(budget.holdForReviewInTransaction).toHaveBeenCalled();
      expect(budget.settleInTransaction).not.toHaveBeenCalled();
    });

    it('rejects an outcome reported against another attempt provider task', async () => {
      // 该 attempt 还没有 providerTaskId，但这个 ID 已经属于别的 Attempt。
      mockExecutionAttempt.findUnique
        .mockResolvedValueOnce(attemptRecord({ providerTaskId: null }))
        .mockResolvedValueOnce({ id: 'other-attempt' });

      await expect(
        service.recordProviderOutcome('attempt-1', {
          providerTaskId: 'provider-of-another-attempt',
          status: 'succeeded',
          usage: { total_tokens: 10 },
        }),
      ).rejects.toThrow('PROVIDER_TASK_OWNED_BY_ANOTHER_ATTEMPT');

      expect(mockExecutionAttempt.update).not.toHaveBeenCalled();
      expect(budget.settleInTransaction).not.toHaveBeenCalled();
    });

    it('rejects a provider task id that contradicts the stored one', async () => {
      mockExecutionAttempt.findUnique.mockResolvedValue(
        attemptRecord({ providerTaskId: 'provider-1' }),
      );

      await expect(
        service.recordProviderOutcome('attempt-1', {
          providerTaskId: 'provider-2',
          status: 'succeeded',
        }),
      ).rejects.toThrow('PROVIDER_TASK_MISMATCH');
    });

    it('rejects unknown outcome statuses and missing attempts', async () => {
      await expect(
        service.recordProviderOutcome('attempt-1', { status: 'maybe' as never }),
      ).rejects.toThrow('INVALID_OUTCOME_STATUS');

      mockExecutionAttempt.findUnique.mockResolvedValue(null);
      await expect(
        service.recordProviderOutcome('attempt-1', { status: 'succeeded' }),
      ).rejects.toThrow('ATTEMPT_NOT_FOUND');
    });
  });
});
