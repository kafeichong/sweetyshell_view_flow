import { Injectable } from '@nestjs/common';
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

  findOwned(id: string, ownerId: string) {
    const prismaAsset = this.prisma as unknown as { asset: { findFirst: any } };
    return prismaAsset.asset.findFirst({ where: { id, ownerId } });
  }

  findById(id: string) {
    const prismaAsset = this.prisma as unknown as { asset: { findUnique: any } };
    return prismaAsset.asset.findUnique({ where: { id } });
  }
}
