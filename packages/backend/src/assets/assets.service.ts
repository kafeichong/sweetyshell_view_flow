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

export type UploadedAssetMetadata = {
  bucket: string;
  sizeBytes: number;
  mimeType: string;
};

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
