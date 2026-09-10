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

  createUploadTicket(assetId: string, objectKey: string, mimeType: string, sizeBytes: number) {
    if (!this.client) throw new ServiceUnavailableException('OSS presign service is not configured');
    return {
      assetId,
      objectKey,
      uploadUrl: this.client.signatureUrl(objectKey, { method: 'PUT', expires: 900, 'Content-Type': mimeType }),
      uploadHeaders: { 'Content-Type': mimeType, 'Content-Length': String(sizeBytes) },
      expiresIn: 900,
    };
  }

  createDownloadUrl(objectKey: string) {
    if (!this.client) throw new ServiceUnavailableException('OSS presign service is not configured');
    return { downloadUrl: this.client.signatureUrl(objectKey, { method: 'GET', expires: 300 }), expiresIn: 300 };
  }
}
