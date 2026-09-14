import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export enum AssetRole {
  INPUT = 'input',
  OUTPUT = 'output',
  REQUIRES_REVIEW = 'requires_review',
}

export interface RegisterAssetInput {
  ownerId?: string;
  taskId?: string;
  attemptId?: string;
  mediaType?: string;
  bucket?: string;
  objectKey: string;
  mimeType?: string;
  sizeBytes?: number;
  fileHash?: string;
  inspectionStatus?: string;
}

export interface RegisterAssetOutput extends RegisterAssetInput {}

export type MediaMetadata = { kind: 'image' | 'video' | 'audio'; width?: number; height?: number; durationSeconds?: number; frameRate?: number; videoCodec?: string; audioCodec?: string };

export type UploadedAssetMetadata = {
  bucket: string;
  sizeBytes: number;
  mimeType: string;
  mediaMetadata?: MediaMetadata;
};

export type RegisterOutputOnceInput = {
  taskId: string;
  attemptId?: string | null;
  objectKey: string;
  bucket?: string;
  mediaType?: string;
  mimeType?: string;
  sizeBytes?: number;
  fileHash?: string;
};

export type RegisterOutputOnceResult = {
  asset: {
    id: string;
    ownerId: string | null;
    taskId: string | null;
    attemptId: string | null;
    objectKey: string;
    inspectionStatus: string | null;
  };
  deduplicated: boolean;
};

// 归档登记的 advisory lock 命名空间：0/1 已被预算准入占用、2 被任务领取占用。
const DELIVERY_LOCK_CLASS = 3;

@Injectable()
export class AssetsService {
  constructor(private prisma: PrismaService) {}

  registerInput(data: RegisterAssetInput) {
    const prismaAsset = this.prisma as unknown as {
      asset: {
        create: any;
      };
    };

    const assets = prismaAsset.asset;

    return assets.create({
      data: {
        ownerId: data.ownerId,
        taskId: data.taskId,
        attemptId: data.attemptId ?? null,
        role: AssetRole.INPUT,
        mediaType: data.mediaType,
        bucket: data.bucket,
        objectKey: data.objectKey,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        fileHash: data.fileHash,
        inspectionStatus: data.inspectionStatus,
      },
    });
  }

  registerOutput(data: RegisterAssetOutput) {
    const prismaAsset = this.prisma as unknown as {
      asset: {
        create: any;
      };
    };

    const assets = prismaAsset.asset;

    return assets.create({
      data: {
        ownerId: data.ownerId,
        taskId: data.taskId,
        attemptId: data.attemptId ?? null,
        role: AssetRole.OUTPUT,
        mediaType: data.mediaType,
        bucket: data.bucket,
        objectKey: data.objectKey,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        fileHash: data.fileHash,
        inspectionStatus: data.inspectionStatus,
      },
    });
  }

  /**
   * 登记产物 Asset —— 所有输出登记的唯一入口。
   *
   * 不变量：
   * - owner 继承 Task（不采信调用方传的 ownerId，避免越权挂到别人名下）；
   * - Attempt 必须属于该 Task；
   * - 同一 objectKey 重复登记返回既有行（归档重跑不得产生第二条产物记录）。
   *
   * 并发安全靠 taskId+attemptId 的事务级 advisory lock 串行化"查重+插入"，
   * 而不是先查再插。
   */
  async registerOutputOnce(
    data: RegisterOutputOnceInput,
  ): Promise<RegisterOutputOnceResult> {
    return this.prisma.$transaction(async (tx: any) => {
      const task = await tx.task.findUnique({
        where: { id: data.taskId },
        select: { id: true, actorId: true, createdBy: true },
      });
      if (!task) {
        throw new NotFoundException('Task not found');
      }

      if (data.attemptId) {
        const attempt = await tx.executionAttempt.findUnique({
          where: { id: data.attemptId },
          select: { taskId: true },
        });
        if (!attempt || attempt.taskId !== data.taskId) {
          throw new BadRequestException('ATTEMPT_TASK_MISMATCH');
        }
      }

      const lockKey = `${data.taskId}:${data.attemptId ?? 'none'}`;
      if (typeof tx.$executeRaw === 'function') {
        // 必须显式 ::int：Prisma 会把 JS number 作为 bigint 传参，
        // 而 pg_advisory_xact_lock 没有 (bigint, integer) 重载，会直接报 42883。
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DELIVERY_LOCK_CLASS}::int, hashtext(${lockKey})::int)`;
      }

      const existing = await tx.asset.findFirst({
        where: {
          taskId: data.taskId,
          role: AssetRole.OUTPUT,
          objectKey: data.objectKey,
        },
      });
      if (existing) {
        return { asset: existing, deduplicated: true };
      }

      const created = await tx.asset.create({
        data: {
          ownerId: task.actorId ?? task.createdBy,
          taskId: data.taskId,
          attemptId: data.attemptId ?? null,
          role: AssetRole.OUTPUT,
          mediaType: data.mediaType,
          bucket: data.bucket,
          objectKey: data.objectKey,
          mimeType: data.mimeType,
          // Asset.sizeBytes 是 BigInt 列：Worker 用 JSON 传数字，直接写会被
          // Prisma 拒绝。非整数或负数说明调用方给错了值，宁可拒绝也不猜。
          sizeBytes: this.toBigIntSize(data.sizeBytes),
          fileHash: data.fileHash,
          inspectionStatus: 'uploaded',
        },
      });

      return { asset: created, deduplicated: false };
    });
  }

  private toBigIntSize(sizeBytes: unknown): bigint | null | undefined {
    if (sizeBytes === null || sizeBytes === undefined) {
      return sizeBytes as null | undefined;
    }
    if (typeof sizeBytes === 'bigint') {
      return sizeBytes >= 0n ? sizeBytes : this.invalidSize();
    }
    if (
      typeof sizeBytes !== 'number' ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0
    ) {
      return this.invalidSize();
    }
    return BigInt(sizeBytes);
  }

  private invalidSize(): never {
    throw new BadRequestException('sizeBytes must be a non-negative integer');
  }

  findByTask(taskId: string) {
    const prismaAsset = this.prisma as unknown as {
      asset: {
        findMany: any;
      };
    };

    const assets = prismaAsset.asset;

    return assets.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findOutputForAttempt(taskId: string, attemptId: string, objectKey: string) {
    const prismaAsset = this.prisma as unknown as { asset: { findFirst: any } };
    return prismaAsset.asset.findFirst({
      where: {
        taskId,
        attemptId,
        role: AssetRole.OUTPUT,
        objectKey,
      },
    });
  }

  findOwned(id: string, ownerId: string) {
    const prismaAsset = this.prisma as unknown as { asset: { findFirst: any } };
    return prismaAsset.asset.findFirst({ where: { id, ownerId } });
  }

  findOwnedUploaded(id: string, ownerId: string) {
    const prismaAsset = this.prisma as unknown as { asset: { findFirst: any } };
    return prismaAsset.asset.findFirst({
      where: {
        id,
        ownerId,
        inspectionStatus: { in: ['uploaded', 'verified'] },
      },
    });
  }

  findOwnedUploadedInput(id: string, ownerId: string) {
    const prismaAsset = this.prisma as unknown as { asset: { findFirst: any } };
    return prismaAsset.asset.findFirst({
      where: {
        id,
        ownerId,
        role: AssetRole.INPUT,
        inspectionStatus: { in: ['uploaded', 'verified'] },
      },
    });
  }

  findLatestOwnedOutputForTask(taskId: string, ownerId: string) {
    const prismaAsset = this.prisma as unknown as { asset: { findFirst: any } };
    return prismaAsset.asset.findFirst({
      where: {
        taskId,
        ownerId,
        role: AssetRole.OUTPUT,
        inspectionStatus: { in: ['uploaded', 'verified'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findUploadedById(id: string) {
    const prismaAsset = this.prisma as unknown as { asset: { findFirst: any } };
    return prismaAsset.asset.findFirst({
      where: {
        id,
        inspectionStatus: { in: ['uploaded', 'verified'] },
      },
    });
  }

  async markUploaded(
    id: string,
    ownerId: string,
    metadata: UploadedAssetMetadata,
  ) {
    const prismaAsset = this.prisma as unknown as {
      asset: { updateMany: any; findUnique: any };
    };
    const updated = await prismaAsset.asset.updateMany({
      where: { id, ownerId },
      data: {
        bucket: metadata.bucket,
        sizeBytes: metadata.sizeBytes,
        mimeType: metadata.mimeType,
        mediaMetadata: metadata.mediaMetadata,
        inspectionStatus: 'uploaded',
      },
    });
    if (!updated.count) {
      return null;
    }
    return prismaAsset.asset.findUnique({ where: { id } });
  }

  /**
   * 内容寻址：同一 owner 上传相同内容时必须复用同一条 Asset。
   *
   * 这是幂等的前提。客户端用 prompt+图片内容算幂等键，如果每次上传都生成新的
   * asset_id，同一工作流第二次排队就会变成"同 key 不同请求体"并被判 409。
   */
  findByOwnerHash(ownerId: string, fileHash: string) {
    const prismaAsset = this.prisma as unknown as { asset: { findFirst: any } };
    return prismaAsset.asset.findFirst({
      where: { ownerId, fileHash, role: AssetRole.INPUT },
      orderBy: { createdAt: 'asc' },
    });
  }

  findById(id: string) {
    const prismaAsset = this.prisma as unknown as { asset: { findUnique: any } };
    return prismaAsset.asset.findUnique({ where: { id } });
  }
}
