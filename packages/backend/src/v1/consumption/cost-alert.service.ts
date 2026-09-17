import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

export interface AlertConfig {
  type: 'daily_threshold' | 'monthly_threshold';
  thresholdCny: string;
  enabled: boolean;
}

export interface TriggeredAlert {
  type: string;
  threshold: string;
  message: string;
}

@Injectable()
export class CostAlertService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 配置预警阈值
   */
  async configureAlerts(actorId: string, alerts: AlertConfig[]): Promise<void> {
    await this.prisma.$transaction(
      alerts.map((alert) =>
        this.prisma.costAlert.upsert({
          where: {
            actorId_alertType: {
              actorId,
              alertType: alert.type,
            },
          },
          create: {
            actorId,
            alertType: alert.type,
            thresholdCny: new Prisma.Decimal(alert.thresholdCny),
            enabled: alert.enabled,
          },
          update: {
            thresholdCny: new Prisma.Decimal(alert.thresholdCny),
            enabled: alert.enabled,
          },
        }),
      ),
    );
  }

  /**
   * 获取用户的预警配置
   */
  async getAlertConfigs(actorId: string): Promise<AlertConfig[]> {
    const alerts = await this.prisma.costAlert.findMany({
      where: { actorId },
      orderBy: { alertType: 'asc' },
    });

    return alerts.map((alert) => ({
      type: alert.alertType as 'daily_threshold' | 'monthly_threshold',
      thresholdCny: alert.thresholdCny.toFixed(6),
      enabled: alert.enabled,
    }));
  }

  /**
   * 检查是否触发预警
   * @param actorId 用户ID
   * @param dailyTotal 日消费总额
   * @param monthlyTotal 月消费总额
   * @returns 触发的预警列表
   */
  async checkAlerts(
    actorId: string,
    dailyTotal: Prisma.Decimal,
    monthlyTotal: Prisma.Decimal,
  ): Promise<TriggeredAlert[]> {
    const alerts = await this.prisma.costAlert.findMany({
      where: { actorId, enabled: true },
    });

    const triggered: TriggeredAlert[] = [];
    const now = new Date();

    for (const alert of alerts) {
      let shouldTrigger = false;
      let message = '';

      if (alert.alertType === 'daily_threshold') {
        if (dailyTotal.gte(alert.thresholdCny)) {
          shouldTrigger = true;
          const percent = dailyTotal.div(alert.thresholdCny).mul(100).toFixed(0);
          message = `日消费已达 ¥${dailyTotal.toFixed(2)}，超过预警阈值 ¥${alert.thresholdCny.toFixed(2)}（${percent}%）`;
        }
      } else if (alert.alertType === 'monthly_threshold') {
        if (monthlyTotal.gte(alert.thresholdCny)) {
          shouldTrigger = true;
          const percent = monthlyTotal.div(alert.thresholdCny).mul(100).toFixed(0);
          message = `月消费已达 ¥${monthlyTotal.toFixed(2)}，超过预警阈值 ¥${alert.thresholdCny.toFixed(2)}（${percent}%）`;
        }
      }

      if (shouldTrigger) {
        triggered.push({
          type: alert.alertType,
          threshold: alert.thresholdCny.toFixed(6),
          message,
        });

        // 更新最后触发时间
        await this.prisma.costAlert.update({
          where: { id: alert.id },
          data: { lastTriggeredAt: now },
        });
      }
    }

    return triggered;
  }

  /**
   * 删除用户的所有预警配置
   */
  async deleteAllAlerts(actorId: string): Promise<void> {
    await this.prisma.costAlert.deleteMany({
      where: { actorId },
    });
  }
}
