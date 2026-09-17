// 本仓的 spec 一律**直接构造**被测服务、手写依赖替身
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { CostAlertService } from './cost-alert.service';

describe('CostAlertService', () => {
  let service: CostAlertService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      costAlert: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn((operations) => Promise.all(operations)),
    };

    service = new CostAlertService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('configureAlerts', () => {
    it('should create new alerts if they do not exist', async () => {
      const actorId = 'actor-1';
      const alerts = [
        { type: 'daily_threshold' as const, thresholdCny: '80.00', enabled: true },
        { type: 'monthly_threshold' as const, thresholdCny: '300.00', enabled: true },
      ];

      prisma.costAlert.upsert.mockResolvedValue({});
      prisma.$transaction.mockImplementation((ops) => Promise.all(ops));

      await service.configureAlerts(actorId, alerts);

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Array));
      expect(prisma.costAlert.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.costAlert.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            actorId_alertType: {
              actorId: 'actor-1',
              alertType: 'daily_threshold',
            },
          },
          create: expect.objectContaining({
            actorId: 'actor-1',
            alertType: 'daily_threshold',
            enabled: true,
          }),
        }),
      );
    });

    it('should update existing alerts', async () => {
      const actorId = 'actor-1';
      const alerts = [
        { type: 'daily_threshold' as const, thresholdCny: '90.00', enabled: false },
      ];

      prisma.costAlert.upsert.mockResolvedValue({});
      prisma.$transaction.mockImplementation((ops) => Promise.all(ops));

      await service.configureAlerts(actorId, alerts);

      expect(prisma.costAlert.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            thresholdCny: expect.any(Prisma.Decimal),
            enabled: false,
          }),
        }),
      );
    });
  });

  describe('getAlertConfigs', () => {
    it('should return alert configurations for an actor', async () => {
      const actorId = 'actor-1';
      prisma.costAlert.findMany.mockResolvedValue([
        {
          actorId: 'actor-1',
          alertType: 'daily_threshold',
          thresholdCny: new Prisma.Decimal('80.000000'),
          enabled: true,
        },
        {
          actorId: 'actor-1',
          alertType: 'monthly_threshold',
          thresholdCny: new Prisma.Decimal('300.000000'),
          enabled: false,
        },
      ]);

      const result = await service.getAlertConfigs(actorId);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'daily_threshold',
        thresholdCny: '80.000000',
        enabled: true,
      });
      expect(result[1]).toEqual({
        type: 'monthly_threshold',
        thresholdCny: '300.000000',
        enabled: false,
      });
    });

    it('should return empty array if no alerts configured', async () => {
      prisma.costAlert.findMany.mockResolvedValue([]);

      const result = await service.getAlertConfigs('actor-1');

      expect(result).toEqual([]);
    });
  });

  describe('checkAlerts', () => {
    it('should trigger daily alert when threshold exceeded', async () => {
      const actorId = 'actor-1';
      const dailyTotal = new Prisma.Decimal('85.000000');
      const monthlyTotal = new Prisma.Decimal('200.000000');

      prisma.costAlert.findMany.mockResolvedValue([
        {
          id: 'alert-1',
          actorId: 'actor-1',
          alertType: 'daily_threshold',
          thresholdCny: new Prisma.Decimal('80.000000'),
          enabled: true,
        },
      ]);

      prisma.costAlert.update.mockResolvedValue({});

      const result = await service.checkAlerts(actorId, dailyTotal, monthlyTotal);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'daily_threshold',
        threshold: '80.000000',
      });
      expect(result[0].message).toContain('日消费已达');
      expect(result[0].message).toContain('¥85.00');
      expect(prisma.costAlert.update).toHaveBeenCalledWith({
        where: { id: 'alert-1' },
        data: { lastTriggeredAt: expect.any(Date) },
      });
    });

    it('should trigger monthly alert when threshold exceeded', async () => {
      const actorId = 'actor-1';
      const dailyTotal = new Prisma.Decimal('50.000000');
      const monthlyTotal = new Prisma.Decimal('320.000000');

      prisma.costAlert.findMany.mockResolvedValue([
        {
          id: 'alert-2',
          actorId: 'actor-1',
          alertType: 'monthly_threshold',
          thresholdCny: new Prisma.Decimal('300.000000'),
          enabled: true,
        },
      ]);

      prisma.costAlert.update.mockResolvedValue({});

      const result = await service.checkAlerts(actorId, dailyTotal, monthlyTotal);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'monthly_threshold',
        threshold: '300.000000',
      });
      expect(result[0].message).toContain('月消费已达');
      expect(result[0].message).toContain('¥320.00');
    });

    it('should not trigger alerts when below threshold', async () => {
      const actorId = 'actor-1';
      const dailyTotal = new Prisma.Decimal('50.000000');
      const monthlyTotal = new Prisma.Decimal('200.000000');

      prisma.costAlert.findMany.mockResolvedValue([
        {
          id: 'alert-1',
          actorId: 'actor-1',
          alertType: 'daily_threshold',
          thresholdCny: new Prisma.Decimal('80.000000'),
          enabled: true,
        },
        {
          id: 'alert-2',
          actorId: 'actor-1',
          alertType: 'monthly_threshold',
          thresholdCny: new Prisma.Decimal('300.000000'),
          enabled: true,
        },
      ]);

      const result = await service.checkAlerts(actorId, dailyTotal, monthlyTotal);

      expect(result).toEqual([]);
      expect(prisma.costAlert.update).not.toHaveBeenCalled();
    });

    it('should not trigger disabled alerts', async () => {
      const actorId = 'actor-1';
      const dailyTotal = new Prisma.Decimal('85.000000');
      const monthlyTotal = new Prisma.Decimal('200.000000');

      // Mock返回空数组，因为查询时已经过滤了enabled=false的预警
      prisma.costAlert.findMany.mockResolvedValue([]);

      const result = await service.checkAlerts(actorId, dailyTotal, monthlyTotal);

      expect(result).toEqual([]);
      expect(prisma.costAlert.update).not.toHaveBeenCalled();
      // 验证查询时包含了enabled过滤条件
      expect(prisma.costAlert.findMany).toHaveBeenCalledWith({
        where: { actorId: 'actor-1', enabled: true },
      });
    });

    it('should trigger multiple alerts simultaneously', async () => {
      const actorId = 'actor-1';
      const dailyTotal = new Prisma.Decimal('85.000000');
      const monthlyTotal = new Prisma.Decimal('320.000000');

      prisma.costAlert.findMany.mockResolvedValue([
        {
          id: 'alert-1',
          actorId: 'actor-1',
          alertType: 'daily_threshold',
          thresholdCny: new Prisma.Decimal('80.000000'),
          enabled: true,
        },
        {
          id: 'alert-2',
          actorId: 'actor-1',
          alertType: 'monthly_threshold',
          thresholdCny: new Prisma.Decimal('300.000000'),
          enabled: true,
        },
      ]);

      prisma.costAlert.update.mockResolvedValue({});

      const result = await service.checkAlerts(actorId, dailyTotal, monthlyTotal);

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('daily_threshold');
      expect(result[1].type).toBe('monthly_threshold');
      expect(prisma.costAlert.update).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteAllAlerts', () => {
    it('should delete all alerts for an actor', async () => {
      const actorId = 'actor-1';
      prisma.costAlert.deleteMany.mockResolvedValue({ count: 2 });

      await service.deleteAllAlerts(actorId);

      expect(prisma.costAlert.deleteMany).toHaveBeenCalledWith({
        where: { actorId: 'actor-1' },
      });
    });
  });
});
