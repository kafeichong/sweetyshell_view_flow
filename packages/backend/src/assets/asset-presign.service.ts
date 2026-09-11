import { Injectable, ServiceUnavailableException } from '@nestjs/common';

// ali-oss publishes CommonJS. Resolve both CommonJS and transpiled ESM shapes
// because this service is compiled by Nest with `module: commonjs`.
const OssConstructor = ((require('ali-oss') as { default?: unknown }).default ?? require('ali-oss')) as new (options: {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  secure: boolean;
}) => {
  signatureUrl: (objectKey: string, options: Record<string, unknown>) => string;
  head: (objectKey: string) => Promise<{
    res?: { headers?: Record<string, string | number | undefined> };
  }>;
};

export type OssObjectMetadata = {
  sizeBytes: number;
  mimeType?: string;
  fileHash?: string;
};

@Injectable()
export class AssetPresignService {
  private readonly client = this.createClient();

  isConfigured() {
    return Boolean(
      process.env.OSS_ACCESS_KEY_ID &&
      process.env.OSS_ACCESS_KEY_SECRET &&
      process.env.OSS_BUCKET &&
      process.env.OSS_REGION,
    );
  }

  private createClient(): InstanceType<typeof OssConstructor> | null {
    if (!this.isConfigured()) {
      return null;
    }
    return new OssConstructor({
      region: process.env.OSS_REGION!,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
      bucket: process.env.OSS_BUCKET!,
      secure: true,
    });
  }

  getBucketName() {
    if (!process.env.OSS_BUCKET) {
      throw new ServiceUnavailableException('OSS presign service is not configured');
    }
    return process.env.OSS_BUCKET;
  }

  createUploadTicket(
    assetId: string,
    objectKey: string,
    mimeType: string,
    sizeBytes: number,
    fileHash?: string,
  ) {
    if (!this.client) throw new ServiceUnavailableException('OSS presign service is not configured');
    const uploadHeaders: Record<string, string> = {
      'Content-Type': mimeType,
      'Content-Length': String(sizeBytes),
    };
    if (fileHash) {
      uploadHeaders['x-oss-meta-sha256'] = fileHash;
    }
    return {
      assetId,
      objectKey,
      uploadUrl: this.client.signatureUrl(objectKey, {
        method: 'PUT',
        expires: 900,
        ...uploadHeaders,
      }),
      uploadHeaders,
      expiresIn: 900,
    };
  }

  async inspectObject(objectKey: string): Promise<OssObjectMetadata> {
    if (!this.client) throw new ServiceUnavailableException('OSS presign service is not configured');
    const result = await this.client.head(objectKey);
    const headers = result.res?.headers ?? {};
    const rawSize = headers['content-length'];
    const sizeBytes = Number(rawSize);
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      throw new ServiceUnavailableException('OSS object metadata is incomplete');
    }

    const rawMimeType = headers['content-type'];
    const rawHash = headers['x-oss-meta-sha256'];
    return {
      sizeBytes,
      mimeType: typeof rawMimeType === 'string' ? rawMimeType.split(';')[0].trim().toLowerCase() : undefined,
      fileHash: typeof rawHash === 'string' ? rawHash.trim().toLowerCase() : undefined,
    };
  }

  createDownloadUrl(objectKey: string) {
    if (!this.client) throw new ServiceUnavailableException('OSS presign service is not configured');
    return { downloadUrl: this.client.signatureUrl(objectKey, { method: 'GET', expires: 300 }), expiresIn: 300 };
  }
}
