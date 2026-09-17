import { createHash } from 'crypto';
import { Readable } from 'stream';
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
  getStream: (objectKey: string) => Promise<{ stream: Readable }>;
  signatureUrl: (objectKey: string, options: Record<string, unknown>) => string;
  put: (
    objectKey: string,
    data: Buffer,
    options?: Record<string, unknown>,
  ) => Promise<{ name?: string }>;
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

  async verifyObjectContent(objectKey: string, expectedHash: string, expectedSize: number): Promise<void> {
    if (!this.client) throw new ServiceUnavailableException('OSS presign service is not configured');
    const { stream } = await this.client.getStream(objectKey);
    const timer = setTimeout(() => stream.destroy(new Error('CONTENT_CHECK_TIMEOUT')), 60_000);
    try {
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > expectedSize) throw new Error('CONTENT_SIZE_MISMATCH');
        hash.update(chunk);
      }
      if (size !== expectedSize || hash.digest('hex') !== expectedHash) throw new Error('CONTENT_HASH_MISMATCH');
    } finally { clearTimeout(timer); stream.destroy(); }
  }

  createDownloadUrl(objectKey: string) {
    if (!this.client) throw new ServiceUnavailableException('OSS presign service is not configured');
    return { downloadUrl: this.client.signatureUrl(objectKey, { method: 'GET', expires: 300 }), expiresIn: 300 };
  }

  /**
   * 服务端自己把字节写进存储桶，并算出 sha256。**只给服务端用**。
   *
   * 常规上传是客户端拿 `createUploadTicket` 签好的地址直传的，服务端不碰素材本体。
   * 唯一的例外是私域素材库素材的登记：那份字节在方舟手里，只能由服务端取回来。
   * `x-oss-meta-sha256` 与客户端上传路径保持一致，`inspectObject` 才读得到同一个摘要。
   */
  async putObject(objectKey: string, bytes: Buffer, mimeType: string) {
    if (!this.client) throw new ServiceUnavailableException('OSS presign service is not configured');
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    await this.client.put(objectKey, bytes, {
      mime: mimeType,
      headers: { 'x-oss-meta-sha256': fileHash },
    });
    return { sizeBytes: bytes.length, fileHash };
  }
}
