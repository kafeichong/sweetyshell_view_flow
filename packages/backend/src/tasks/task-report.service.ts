import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { EVIDENCE_MISSING } from '../audit/audit-log.service';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const EVENTS_FILE_PREFIX = 'events-';
const EVENTS_FILE_SUFFIX = '.jsonl';

export type EvidenceSource = {
  source: string;
  available: boolean;
  reason?: string;
  detail?: string;
  records?: Record<string, number>;
  eventFiles?: string[];
  matchingRecords?: number;
  directory?: string;
};

@Injectable()
export class TaskReportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 按 taskId 汇总一条只读报表：Task / Attempt / Asset / 预算 / 最后错误 /
   * 事件关联键，并明确每一类证据的来源与可用性。
   *
   * 只读——报表不能隐式修复任何状态，否则排障本身会改变现场。
   */
  async buildReport(taskId: string) {
    const task = (await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        executionAttempts: { orderBy: { attemptNo: 'desc' } },
        budgetReservation: true,
        assets: { orderBy: { createdAt: 'asc' } },
      },
    })) as any;

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const attempts = task.executionAttempts ?? [];
    const latestAttempt = attempts[0] ?? null;
    const reservation = task.budgetReservation ?? null;
    const assets = task.assets ?? [];

    const workerAudit = await this.workerAuditEvidence(taskId);

    return {
      task: {
        id: task.id,
        actorId: task.actorId ?? null,
        createdBy: task.createdBy ?? null,
        status: task.status ?? null,
        taskStatus: task.taskStatus ?? null,
        deliveryStatus: task.deliveryStatus ?? null,
        createdAt: task.createdAt ?? null,
        updatedAt: task.updatedAt ?? null,
        completedAt: task.completedAt ?? null,
        // 错误信息可能是唯一线索，但其中的 URL 必须去掉签名 query。
        errorMsg: redactUrls(task.errorMsg ?? null),
      },
      attempts: attempts.map((attempt: any) => ({
        attemptId: attempt.id,
        attemptNo: attempt.attemptNo,
        mode: attempt.mode,
        provider: attempt.provider,
        model: attempt.model ?? null,
        status: attempt.status,
        providerTaskId: attempt.providerTaskId ?? null,
        costStatus: attempt.costStatus ?? null,
        pricingVersion: attempt.pricingVersion ?? null,
        estimatedCostCny: attempt.estimatedCostCny ?? null,
        usageCalculatedCostCny: attempt.usageCalculatedCostCny ?? null,
        billedCostCny: attempt.billedCostCny ?? null,
        failureCode: attempt.failureCode ?? null,
        failureMessage: redactUrls(attempt.failureMessage ?? null),
        submittedAt: attempt.submittedAt ?? null,
        startedAt: attempt.startedAt ?? null,
        finishedAt: attempt.finishedAt ?? null,
      })),
      assets: assets.map((asset: any) => ({
        assetId: asset.id,
        role: asset.role,
        objectKey: asset.objectKey,
        mimeType: asset.mimeType ?? null,
        sizeBytes: asset.sizeBytes === null || asset.sizeBytes === undefined
          ? null
          : Number(asset.sizeBytes),
        inspectionStatus: asset.inspectionStatus ?? null,
        createdAt: asset.createdAt ?? null,
      })),
      budget: reservation
        ? {
            state: reservation.state,
            reservedCny: reservation.reservedCny?.toFixed(6) ?? null,
            settledCny: reservation.settledCny?.toFixed(6) ?? null,
            dayKey: reservation.dayKey,
            monthKey: reservation.monthKey,
            pricingVersion: reservation.pricingVersion,
            reviewDecision: reservation.reviewDecision ?? null,
            reviewAmountCny: reservation.reviewAmountCny?.toFixed(6) ?? null,
            reviewEvidenceRef: reservation.reviewEvidenceRef ?? null,
            reviewOperator: reservation.reviewOperator ?? null,
            reviewedAt: reservation.reviewedAt ?? null,
            operatorIsDeclaredClaim: reservation.reviewOperator !== null,
          }
        : null,
      lastError: buildLastError(task, latestAttempt),
      correlation: {
        taskId: task.id,
        clientRequestId: task.clientRequestId ?? null,
        attemptIds: attempts.map((attempt: any) => attempt.id),
        providerTaskIds: attempts
          .map((attempt: any) => attempt.providerTaskId)
          .filter((value: unknown): value is string => typeof value === 'string'),
        objectKeys: assets.map((asset: any) => asset.objectKey),
      },
      evidence: {
        // 数据库里没有事件表，"查不到事件"不等于"没有记录"：
        // 这里逐条说明证据在哪、能不能读，避免把缺失写成"没发生"。
        sources: [
          {
            source: 'database',
            available: true,
            records: {
              tasks: 1,
              attempts: attempts.length,
              assets: assets.length,
              budgetReservations: reservation ? 1 : 0,
            },
          },
          workerAudit,
        ],
        note: 'report is read-only; unavailable sources mean evidence is missing or unreadable, not that nothing happened',
      },
    };
  }

  /** Worker 事件目录的可用性说明（Backend 与 Worker 各写各的子目录）。 */
  private async workerAuditEvidence(taskId: string): Promise<EvidenceSource> {
    const directory = (process.env.VIDEO_FLOW_WORKER_AUDIT_DIR ?? '').trim();
    if (!directory) {
      return {
        source: 'worker-audit',
        available: false,
        reason: 'audit_dir_not_configured',
        detail: 'set VIDEO_FLOW_WORKER_AUDIT_DIR to read worker events',
      };
    }

    let files: string[];
    try {
      files = (await readdir(directory)).filter(
        (name) => name.startsWith(EVENTS_FILE_PREFIX) && name.endsWith(EVENTS_FILE_SUFFIX),
      );
    } catch {
      return { source: 'worker-audit', available: false, reason: EVIDENCE_MISSING, directory };
    }

    if (!files.length) {
      return {
        source: 'worker-audit',
        available: false,
        reason: EVIDENCE_MISSING,
        directory,
        detail: 'no event files present (rotated or never written)',
      };
    }

    let matching = 0;
    for (const file of files) {
      try {
        const content = await readFile(join(directory, file), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            if ((JSON.parse(line) as { taskId?: string }).taskId === taskId) matching += 1;
          } catch {
            continue;
          }
        }
      } catch {
        return { source: 'worker-audit', available: false, reason: 'audit_dir_not_readable', directory };
      }
    }

    return {
      source: 'worker-audit',
      available: true,
      directory,
      eventFiles: files.sort(),
      matchingRecords: matching,
    };
  }
}

function redactUrls(value: string | null): string | null {
  if (!value) return value ?? null;
  return value.replace(/https?:\/\/[^\s"']+/g, (match) => {
    try {
      const parsed = new URL(match);
      parsed.search = '';
      parsed.hash = '';
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    } catch {
      return match;
    }
  });
}

function buildLastError(task: any, latestAttempt: any) {
  if (latestAttempt?.failureCode || latestAttempt?.failureMessage) {
    return {
      source: 'attempt',
      code: latestAttempt.failureCode ?? null,
      message: redactUrls(latestAttempt.failureMessage ?? null),
      at: latestAttempt.finishedAt ?? latestAttempt.updatedAt ?? null,
    };
  }

  if (task.errorMsg) {
    return {
      source: 'task',
      code: task.deliveryStatus === 'failed' ? 'DELIVERY_FAILED' : null,
      message: redactUrls(task.errorMsg),
      at: task.updatedAt ?? null,
    };
  }

  return null;
}
