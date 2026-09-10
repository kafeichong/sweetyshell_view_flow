import { Injectable, ServiceUnavailableException } from '@nestjs/common';

@Injectable()
export class AssetPresignService {
  isConfigured() {
    return Boolean(process.env.OSS_PRESIGN_ENDPOINT);
  }

  private requireSigner() {
    const endpoint = process.env.OSS_PRESIGN_ENDPOINT;
    if (!endpoint) {
      throw new ServiceUnavailableException('OSS presign service is not configured');
    }
    return endpoint.replace(/\/$/, '');
  }

  createUploadTicket(assetId: string, objectKey: string, mimeType: string, sizeBytes: number) {
    const endpoint = this.requireSigner();
    return {
      assetId,
      objectKey,
      uploadUrl: `${endpoint}/upload`,
      uploadHeaders: { 'Content-Type': mimeType, 'X-Object-Key': objectKey, 'X-Object-Size': String(sizeBytes) },
      expiresIn: 900,
    };
  }

  createDownloadUrl(objectKey: string) {
    const endpoint = this.requireSigner();
    return { downloadUrl: `${endpoint}/download?objectKey=${encodeURIComponent(objectKey)}`, expiresIn: 300 };
  }
}
