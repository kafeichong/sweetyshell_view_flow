jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Logger: class Logger { log() {} },
}));

import { TaskBudgetService, fitsBudget } from './task-budget.service';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

describe('TaskBudgetService', () => {
  let service: TaskBudgetService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(),
      taskBudgetReservation: {
        create: jest.fn(), findUnique: jest.fn(), update: jest.fn(),
        findMany: jest.fn(), aggregate: jest.fn(),
      },
      actorCredential: { findUnique: jest.fn() },
      productionGate: { findUnique: jest.fn() },
    };
    service = new TaskBudgetService(prisma as PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('fitsBudget', () => {
    it('should return true when reserve fits within limit', () => {
      expect(fitsBudget('10.000000', '5.000000', '4.000000')).toBe(true);
    });

    it('should return false when reserve exceeds limit', () => {
      expect(fitsBudget('10.000000', '5.000000', '6.000000')).toBe(false);
    });

    it('should return false when used+reserve exactly exceeds limit by micro-unit', () => {
      expect(fitsBudget('10.000000', '9.000001', '1.000000')).toBe(false);
    });

    it('should return true when used+reserve exactly equals limit', () => {
      expect(fitsBudget('10.000000', '5.000000', '5.000000')).toBe(true);
    });

    it('should handle decimal precision correctly', () => {
      expect(fitsBudget('1.000000', '0.333333', '0.333333')).toBe(true);
      expect(fitsBudget('1.000000', '0.333334', '0.666667')).toBe(false);
    });
  });

  describe('reserveInTransaction', () => {
    it('should create budget reservation with correct values', async () => {
      const mockTx = {
        taskBudgetReservation: {
          create: jest.fn().mockResolvedValue({}),
        },
      } as any;

      const executionPlan = {
        version: 'test-v1',
        model: 'test-model',
        duration: 5,
        ratio: '16:9',
        resolution: 'test-resolution',
        generate_audio: false,
        watermark: true,
        pricingVersion: 'test-price',
        reserveCny: '2.500000',
      };

      await service.reserveInTransaction(
        mockTx,
        'task-1',
        'actor-1',
        executionPlan,
      );

      expect(mockTx.taskBudgetReservation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: 'task-1',
          actorId: 'actor-1',
          reservedCny: expect.any(Prisma.Decimal),
          state: 'reserved',
          pricingVersion: 'test-price',
          dayKey: expect.any(String),
          monthKey: expect.any(String),
        }),
      });
    });
  });

  describe('settleInTransaction', () => {
    it('should settle reservation with correct amount', async () => {
      const mockReservation = {
        taskId: 'task-1',
        state: 'reserved',
        settledCny: null,
      };

      const mockTx = {
        taskBudgetReservation: {
          findUnique: jest.fn().mockResolvedValue(mockReservation),
          update: jest.fn().mockResolvedValue({}),
        },
      } as any;

      await service.settleInTransaction(mockTx, 'task-1', '2.345678');

      expect(mockTx.taskBudgetReservation.update).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        data: expect.objectContaining({
          settledCny: expect.any(Prisma.Decimal),
          state: 'settled',
        }),
      });
    });

    it('should be idempotent when settling with same amount', async () => {
      const mockReservation = {
        taskId: 'task-1',
        state: 'settled',
        settledCny: new Prisma.Decimal('2.345678'),
      };

      const mockTx = {
        taskBudgetReservation: {
          findUnique: jest.fn().mockResolvedValue(mockReservation),
          update: jest.fn(),
        },
      } as any;

      await service.settleInTransaction(mockTx, 'task-1', '2.345678');

      expect(mockTx.taskBudgetReservation.update).not.toHaveBeenCalled();
    });

    it('should throw when settling with different amount', async () => {
      const mockReservation = {
        taskId: 'task-1',
        state: 'settled',
        settledCny: new Prisma.Decimal('2.345678'),
      };

      const mockTx = {
        taskBudgetReservation: {
          findUnique: jest.fn().mockResolvedValue(mockReservation),
        },
      } as any;

      await expect(
        service.settleInTransaction(mockTx, 'task-1', '3.000000'),
      ).rejects.toThrow('already settled with different amount');
    });

    it('should throw when reservation not found', async () => {
      const mockTx = {
        taskBudgetReservation: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      } as any;

      await expect(
        service.settleInTransaction(mockTx, 'task-1', '2.345678'),
      ).rejects.toThrow('No reservation found');
    });
  });

  describe('checkBudgetAvailability', () => {
    it('should reject when credential not found', async () => {
      const mockTx = {
        actorCredential: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        productionGate: {
          findUnique: jest.fn().mockResolvedValue({ paused: false }),
        },
      } as any;

      const result = await service.checkBudgetAvailability(
        mockTx,
        'actor-1',
        '5.000000',
      );

      expect(result).toEqual({
        canProceed: false,
        reason: 'NO_CREDENTIAL',
      });
    });

    it('should reject when credential is inactive', async () => {
      const mockTx = {
        actorCredential: {
          findUnique: jest.fn().mockResolvedValue({
            actorId: 'actor-1',
            status: 'inactive',
          }),
        },
      } as any;

      const result = await service.checkBudgetAvailability(
        mockTx,
        'actor-1',
        '5.000000',
      );

      expect(result).toEqual({
        canProceed: false,
        reason: 'CREDENTIAL_INACTIVE',
      });
    });

    it('should reject when limits not configured', async () => {
      const mockTx = {
        actorCredential: {
          findUnique: jest.fn().mockResolvedValue({
            actorId: 'actor-1',
            status: 'active',
            dailyLimitCny: null,
            monthlyLimitCny: null,
          }),
        },
      } as any;

      const result = await service.checkBudgetAvailability(
        mockTx,
        'actor-1',
        '5.000000',
      );

      expect(result).toEqual({
        canProceed: false,
        reason: 'NO_LIMITS_CONFIGURED',
      });
    });

    it('should approve when budget available', async () => {
      const mockTx = {
        actorCredential: {
          findUnique: jest.fn().mockResolvedValue({
            actorId: 'actor-1',
            status: 'active',
            dailyLimitCny: new Prisma.Decimal('100.000000'),
            monthlyLimitCny: new Prisma.Decimal('1000.000000'),
          }),
        },
        taskBudgetReservation: {
          findMany: jest.fn().mockResolvedValue([]),
          aggregate: jest.fn().mockResolvedValue({
            _sum: { settledCny: null },
          }),
          count: jest.fn().mockResolvedValue(0),
        },
        task: { count: jest.fn().mockResolvedValue(0) },
      } as any;

      const result = await service.checkBudgetAvailability(
        mockTx,
        'actor-1',
        '5.000000',
      );

      expect(result).toEqual({ canProceed: true });
    });

    it('should reject when daily limit exceeded', async () => {
      const mockTx = {
        actorCredential: {
          findUnique: jest.fn().mockResolvedValue({
            actorId: 'actor-1',
            status: 'active',
            dailyLimitCny: new Prisma.Decimal('10.000000'),
            monthlyLimitCny: new Prisma.Decimal('1000.000000'),
          }),
        },
        taskBudgetReservation: {
          findMany: jest.fn().mockResolvedValue([
            { reservedCny: new Prisma.Decimal('8.000000') },
          ]),
          aggregate: jest.fn().mockResolvedValue({
            _sum: { settledCny: null },
          }),
        },
      } as any;

      const result = await service.checkBudgetAvailability(
        mockTx,
        'actor-1',
        '3.000000',
      );

      expect(result).toEqual({
        canProceed: false,
        reason: 'DAILY_LIMIT_EXCEEDED',
      });
    });

    it('should reject when monthly limit exceeded', async () => {
      const mockTx = {
        actorCredential: {
          findUnique: jest.fn().mockResolvedValue({
            actorId: 'actor-1',
            status: 'active',
            dailyLimitCny: new Prisma.Decimal('100.000000'),
            monthlyLimitCny: new Prisma.Decimal('100.000000'),
          }),
        },
        taskBudgetReservation: {
          findMany: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              { reservedCny: new Prisma.Decimal('95.000000') },
            ]),
          aggregate: jest.fn().mockResolvedValue({
            _sum: { settledCny: null },
          }),
        },
      } as any;

      const result = await service.checkBudgetAvailability(
        mockTx,
        'actor-1',
        '10.000000',
      );

      expect(result).toEqual({
        canProceed: false,
        reason: 'MONTHLY_LIMIT_EXCEEDED',
      });
    });

    it('should count an unsettled reservation from a prior month against current admission', async () => {
      // 占用 = 当前周期已结算 + 全部尚未结算预占（含跨周期在途/review），
      // 所以上个月的 reserved 记录必须仍然计入本次准入检查，不能因为跨月而"清零"。
      const mockTx = {
        actorCredential: {
          findUnique: jest.fn().mockResolvedValue({
            actorId: 'actor-1',
            status: 'active',
            dailyLimitCny: new Prisma.Decimal('10.000000'),
            monthlyLimitCny: new Prisma.Decimal('1000.000000'),
          }),
        },
        taskBudgetReservation: {
          findMany: jest.fn().mockResolvedValue([
            { reservedCny: new Prisma.Decimal('8.000000'), dayKey: '2026-08-15', monthKey: '2026-08' },
          ]),
          aggregate: jest.fn().mockResolvedValue({
            _sum: { settledCny: null },
          }),
        },
      } as any;

      const result = await service.checkBudgetAvailability(
        mockTx,
        'actor-1',
        '5.000000',
      );

      expect(result).toEqual({
        canProceed: false,
        reason: 'DAILY_LIMIT_EXCEEDED',
      });
    });

    it('should reject when daily task count limit exceeded', async () => {
      const previousEnv = process.env.VIDEO_FLOW_DAILY_TASK_LIMIT;
      process.env.VIDEO_FLOW_DAILY_TASK_LIMIT = '2';
      try {
        const mockTx = {
          actorCredential: {
            findUnique: jest.fn().mockResolvedValue({
              actorId: 'actor-1',
              status: 'active',
              dailyLimitCny: new Prisma.Decimal('100.000000'),
              monthlyLimitCny: new Prisma.Decimal('1000.000000'),
            }),
          },
          taskBudgetReservation: {
            findMany: jest.fn().mockResolvedValue([]),
            aggregate: jest.fn().mockResolvedValue({ _sum: { settledCny: null } }),
            count: jest.fn().mockResolvedValue(2),
          },
        } as any;

        const result = await service.checkBudgetAvailability(
          mockTx,
          'actor-1',
          '5.000000',
        );

        expect(result).toEqual({
          canProceed: false,
          reason: 'DAILY_TASK_COUNT_EXCEEDED',
        });
      } finally {
        process.env.VIDEO_FLOW_DAILY_TASK_LIMIT = previousEnv;
      }
    });

    it('should reject when global pending task limit exceeded', async () => {
      const previousEnv = process.env.VIDEO_FLOW_MAX_PENDING_TASKS;
      process.env.VIDEO_FLOW_MAX_PENDING_TASKS = '3';
      try {
        const mockTx = {
          actorCredential: {
            findUnique: jest.fn().mockResolvedValue({
              actorId: 'actor-1',
              status: 'active',
              dailyLimitCny: new Prisma.Decimal('100.000000'),
              monthlyLimitCny: new Prisma.Decimal('1000.000000'),
            }),
          },
          taskBudgetReservation: {
            findMany: jest.fn().mockResolvedValue([]),
            aggregate: jest.fn().mockResolvedValue({ _sum: { settledCny: null } }),
            count: jest.fn().mockResolvedValue(0),
          },
          task: { count: jest.fn().mockResolvedValue(3) },
        } as any;

        const result = await service.checkBudgetAvailability(
          mockTx,
          'actor-1',
          '5.000000',
        );

        expect(result).toEqual({
          canProceed: false,
          reason: 'GLOBAL_PENDING_LIMIT_EXCEEDED',
        });
      } finally {
        process.env.VIDEO_FLOW_MAX_PENDING_TASKS = previousEnv;
      }
    });
  });

  describe('createTaskWithReservation', () => {
    it('returns the same task under the actor lock and skips validation/reservation for an identical request', async () => {
      const existing = { id: 'task-existing', requestSnapshot: { submissionDigest: 'digest-1' } };
      const validate = jest.fn();
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        task: { findFirst: jest.fn().mockResolvedValue(existing) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => callback(tx));

      const result = await service.createTaskWithReservation({
        actorId: 'actor-1', clientRequestId: 'request-1', requestDigest: 'digest-1',
        estimatedCny: '5.000000',
        executionPlan: {
          model: 'test-model', duration: 5, ratio: '16:9', resolution: '720p', watermark: true,
          pricingVersion: 'test-price', reserveCny: '5.000000',
        },
        task: { createdBy: 'actor-1', prompt: 'hello', status: 'pending', requestSnapshot: { submissionDigest: 'digest-1' } },
      }, validate);

      expect(result).toEqual({ task: existing, created: false });
      expect(validate).not.toHaveBeenCalled();
    });

    it('runs the final snapshot validator inside the locked transaction before creating the task', async () => {
      const order: string[] = [];
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        task: {
          findFirst: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockImplementation(async () => { order.push('create'); return { id: 'task-1' }; }),
        },
        actorCredential: { findUnique: jest.fn().mockResolvedValue({ actorId: 'actor-1', status: 'active', dailyLimitCny: new Prisma.Decimal(100), monthlyLimitCny: new Prisma.Decimal(1000) }) },
        taskBudgetReservation: {
          findMany: jest.fn().mockResolvedValue([]), aggregate: jest.fn().mockResolvedValue({ _sum: { settledCny: null } }),
          count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({}),
        },
        productionGate: { findUnique: jest.fn().mockResolvedValue({ paused: false }) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => callback(tx));
      const validate = jest.fn().mockImplementation(async () => { order.push('validate'); });

      const result = await service.createTaskWithReservation({
        actorId: 'actor-1', clientRequestId: 'request-1', requestDigest: 'digest-1', estimatedCny: '5.000000',
        executionPlan: { model: 'test', duration: 5, ratio: '16:9', resolution: '720p', watermark: false, pricingVersion: 'p1', reserveCny: '5.000000' },
        task: { createdBy: 'actor-1', prompt: 'hello', status: 'pending', requestSnapshot: { submissionDigest: 'digest-1' } },
      }, validate);

      expect(result).toMatchObject({ task: { id: 'task-1' }, created: true });
      expect(validate).toHaveBeenCalledWith(tx);
      expect(order).toEqual(['validate', 'create']);
    });

    it('returns the current locked Task for the same execution slot without creating or reserving again', async () => {
      const current = {
        id: 'task-current', slotSequence: 1, clientDeliveryStatus: 'pending',
        deliveryStatus: 'not_started', executionAttempts: [],
      };
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        task: { findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(current) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => callback(tx));
      const validate = jest.fn();

      const result = await service.createTaskWithReservation({
        actorId: 'actor-1', clientRequestId: 'request-2', requestDigest: 'digest-2', executionSlotId: 'slot-1',
        estimatedCny: '5.000000',
        executionPlan: { model: 'test', duration: 4, ratio: '16:9', resolution: '720p', watermark: false, pricingVersion: 'p1', reserveCny: '5.000000' },
        task: { createdBy: 'actor-1', prompt: 'new content', status: 'pending' },
      }, validate);

      expect(result).toEqual({ task: current, created: false, recovered: true });
      expect(validate).not.toHaveBeenCalled();
    });

    it('creates the next sequence after client delivery has released the slot', async () => {
      const delivered = {
        id: 'task-old', slotSequence: 1, clientDeliveryStatus: 'delivered',
        deliveryStatus: 'ready', executionAttempts: [{ status: 'completed', providerTaskId: 'provider-1' }],
      };
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        actorCredential: { findUnique: jest.fn().mockResolvedValue({ actorId: 'actor-1', status: 'active', dailyLimitCny: new Prisma.Decimal(100), monthlyLimitCny: new Prisma.Decimal(1000) }) },
        taskBudgetReservation: { findMany: jest.fn().mockResolvedValue([]), aggregate: jest.fn().mockResolvedValue({ _sum: { settledCny: null } }), count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({}) },
        productionGate: { findUnique: jest.fn().mockResolvedValue({ paused: false }) },
        task: {
          findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(delivered),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn(async ({ data }) => ({ id: 'task-next', ...data })),
        },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => callback(tx));

      const result = await service.createTaskWithReservation({
        actorId: 'actor-1', clientRequestId: 'request-2', requestDigest: 'digest-2', executionSlotId: 'slot-1',
        estimatedCny: '5.000000',
        executionPlan: { model: 'test', duration: 4, ratio: '16:9', resolution: '720p', watermark: false, pricingVersion: 'p1', reserveCny: '5.000000' },
        task: { createdBy: 'actor-1', prompt: 'new content', status: 'pending' },
      });

      expect(result).toMatchObject({ task: { id: 'task-next', executionSlotId: 'slot-1', slotSequence: 2, clientDeliveryStatus: 'pending' }, created: true });
    });

    it('acquires the global lock before the actor lock', async () => {
      const executedSql: string[] = [];
      const tx = {
        $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
          executedSql.push(strings.join('?'));
          return Promise.resolve();
        }),
        actorCredential: {
          findUnique: jest.fn().mockResolvedValue({
            actorId: 'actor-1',
            status: 'active',
            dailyLimitCny: new Prisma.Decimal('100.000000'),
            monthlyLimitCny: new Prisma.Decimal('1000.000000'),
          }),
        },
        taskBudgetReservation: {
          findMany: jest.fn().mockResolvedValue([]),
          aggregate: jest.fn().mockResolvedValue({ _sum: { settledCny: null } }),
          create: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(0),
        },
        task: {
          create: jest.fn().mockResolvedValue({ id: 'task-1', status: 'pending' }),
          count: jest.fn().mockResolvedValue(0),
        },
        productionGate: {
          findUnique: jest.fn().mockResolvedValue({ paused: false }),
        },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => callback(tx));

      await service.createTaskWithReservation({
        actorId: 'actor-1',
        clientRequestId: 'request-1',
        estimatedCny: '5.000000',
        executionPlan: {
          version: 'test-v1',
          model: 'test-model',
          duration: 5,
          ratio: '16:9',
          resolution: '720p',
          generate_audio: false,
          watermark: true,
          pricingVersion: 'test-price',
          reserveCny: '5.000000',
        },
        task: { createdBy: 'actor-1', prompt: 'hello', status: 'pending' },
      });

      expect(executedSql).toHaveLength(2);
      expect(executedSql[0]).toContain('pg_advisory_xact_lock(0, 0)');
      expect(executedSql[1]).toContain('pg_advisory_xact_lock(1, hashtext(');
    });

    it('creates the task and reservation in one transaction', async () => {
      const tx = {
        actorCredential: {
          findUnique: jest.fn().mockResolvedValue({
            actorId: 'actor-1',
            status: 'active',
            dailyLimitCny: new Prisma.Decimal('100.000000'),
            monthlyLimitCny: new Prisma.Decimal('1000.000000'),
          }),
        },
        taskBudgetReservation: {
          findMany: jest.fn().mockResolvedValue([]),
          aggregate: jest.fn().mockResolvedValue({ _sum: { settledCny: null } }),
          create: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(0),
        },
        task: {
          create: jest.fn().mockResolvedValue({ id: 'task-1', status: 'pending' }),
          count: jest.fn().mockResolvedValue(0),
        },
        productionGate: {
          findUnique: jest.fn().mockResolvedValue({ paused: false }),
        },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => callback(tx));

      const result = await service.createTaskWithReservation({
        actorId: 'actor-1',
        clientRequestId: 'request-1',
        estimatedCny: '5.000000',
        executionPlan: {
          version: 'test-v1',
          model: 'test-model',
          duration: 5,
          ratio: '16:9',
          resolution: '720p',
          generate_audio: false,
          watermark: true,
          pricingVersion: 'test-price',
          reserveCny: '5.000000',
        },
        task: { createdBy: 'actor-1', prompt: 'hello', status: 'pending' },
      });

      expect(result).toMatchObject({ task: { id: 'task-1', status: 'pending' }, created: true });
      expect(tx.task.create).toHaveBeenCalledTimes(1);
      expect(tx.taskBudgetReservation.create).toHaveBeenCalledTimes(1);
    });
  });
});
