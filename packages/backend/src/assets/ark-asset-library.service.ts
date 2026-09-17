import { createHash, createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

// 火山方舟「私域素材库」的 Access Key 通道。与视频生成用的 API Key 是**两套鉴权**：
// 生成走 bearer token，素材库走 AK/SK 签名（服务名 ark、动作走 2024-01-01 版本）。
// 详见 docs/runbooks/ark-asset-library-credentials.md。
const HOST = 'ark.cn-beijing.volcengineapi.com';
const REGION = 'cn-beijing';
const SERVICE = 'ark';
const API_VERSION = '2024-01-01';
const DEFAULT_CREDENTIALS_FILE = join(homedir(), '.video-flow', 'ark-asset-credentials');

/** 素材库里一条素材的最小事实集。字段名对应 GetAsset/ListAssets 的返回体。 */
export type ArkAssetSummary = {
  id: string;
  name: string;
  assetType: string;
  status: string;
  groupId: string;
  projectName: string;
  /** 方舟自己的签名地址。**只用来取字节做检查，绝不写进日志或错误信息。** */
  url: string | null;
};

type ArkCredentials = { accessKeyId: string; secretAccessKey: string };

@Injectable()
export class ArkAssetLibraryService {
  private readonly logger = new Logger(ArkAssetLibraryService.name);

  /** 有没有配凭证（**不代表**当前环境允许用——见 requireCredentials）。 */
  hasCredentials(): boolean {
    return this.readCredentials() !== null;
  }

  isConfigured(): boolean {
    return process.env.VIDEO_FLOW_TEST_MODE !== '1' && this.hasCredentials();
  }

  async getAsset(assetId: string, projectName: string): Promise<ArkAssetSummary> {
    const result = await this.call<Record<string, unknown>>('GetAsset', { Id: assetId, ProjectName: projectName });
    return toSummary(result);
  }

  async listAssets(options: { groupType: string; groupId?: string; maxResults?: number }): Promise<ArkAssetSummary[]> {
    const filter: Record<string, unknown> = { GroupType: options.groupType };
    if (options.groupId) filter.GroupIds = [options.groupId];
    const result = await this.call<{ Items?: Record<string, unknown>[] }>('ListAssets', {
      Filter: filter,
      MaxResults: options.maxResults ?? 20,
    });
    return (result.Items ?? []).map(toSummary);
  }

  private readCredentials(): ArkCredentials | null {
    const inlineId = process.env.ARK_ASSET_ACCESS_KEY_ID?.trim();
    const inlineSecret = process.env.ARK_ASSET_ACCESS_KEY_SECRET?.trim();
    if (inlineId && inlineSecret) return { accessKeyId: inlineId, secretAccessKey: inlineSecret };

    const file = process.env.ARK_ASSET_CREDENTIALS_FILE?.trim() || DEFAULT_CREDENTIALS_FILE;
    try {
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length >= 2) return { accessKeyId: lines[0], secretAccessKey: lines[1] };
    } catch {
      // 文件不存在/读不到就是"没配"，由调用方 fail-closed，不在这里抛。
    }
    return null;
  }

  private requireCredentials(): ArkCredentials {
    // 与 Worker 的 REAL_PROVIDER_CREDENTIAL_FORBIDDEN 同一条规矩：合同/验收环境里出现
    // 真实凭证就直接失败，而不是"碰巧没用到"。素材库的 AK 是**全账号级**的（能建删素材组），
    // 比生成用的 API Key 危险得多，更不能让它跟着测试环境跑起来。
    if (process.env.VIDEO_FLOW_TEST_MODE === '1' && this.hasCredentials()) {
      throw new ServiceUnavailableException('REAL_PROVIDER_CREDENTIAL_FORBIDDEN');
    }
    const credentials = this.readCredentials();
    if (!credentials) throw new ServiceUnavailableException('ARK_ASSET_LIBRARY_NOT_CONFIGURED');
    return credentials;
  }

  private async call<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const credentials = this.requireCredentials();
    const request = buildSignedRequest(credentials, action, body, formatXDate(new Date()));
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.payload,
    });

    const text = await response.text();
    let parsed: Record<string, any> | null = null;
    try {
      parsed = JSON.parse(text) as Record<string, any>;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const code = parsed?.ResponseMetadata?.Error?.Code ?? `HTTP_${response.status}`;
      // 只带方舟给的原因码。**这条 message 会原样回到客户端**，所以既不塞请求体也不塞
      // 任何带签名的地址——历史上已经踩过反方向的坑（错误信息丢原因），别再踩这一侧。
      this.logger.warn(`Ark asset library ${action} failed: ${code}`);
      throw new ServiceUnavailableException(`ARK_ASSET_LIBRARY_ERROR:${code}`);
    }

    return (parsed?.Result ?? parsed ?? {}) as T;
  }
}

/**
 * 构造一条已签名的方舟 OpenAPI 请求。抽成纯函数是为了能用**固定时钟**对拍：
 * 同一组输入在 Python 探针（已在真实账号上验证通过）与本实现下必须算出同一个签名。
 */
export function buildSignedRequest(
  credentials: ArkCredentials,
  action: string,
  body: Record<string, unknown>,
  xDate: string,
): { url: string; headers: Record<string, string>; payload: string } {
  const payload = JSON.stringify(body);
  const payloadHash = sha256Hex(payload);
  const shortDate = xDate.slice(0, 8);

  const canonicalQuery = Object.entries({ Action: action, Version: API_VERSION })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&');

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: HOST,
    'x-content-sha256': payloadHash,
    'x-date': xDate,
  };
  const sortedNames = Object.keys(headers).sort();
  const signedHeaders = sortedNames.join(';');
  const canonicalHeaders = sortedNames.map((key) => `${key}:${headers[key]}\n`).join('');
  const canonicalRequest = ['POST', '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${shortDate}/${REGION}/${SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  // 派生密钥链：SK -> 日期 -> 区域 -> 服务 -> "request"，与 AWS SigV4 同形。
  const signingKey = [shortDate, REGION, SERVICE, 'request'].reduce(
    (key: Buffer | string, step) => hmacSha256(key, step),
    credentials.secretAccessKey,
  ) as Buffer;
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    url: `https://${HOST}/?${canonicalQuery}`,
    headers: {
      ...headers,
      authorization:
        `HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    payload,
  };
}

function toSummary(raw: Record<string, unknown>): ArkAssetSummary {
  return {
    id: String(raw.Id ?? ''),
    name: String(raw.Name ?? ''),
    assetType: String(raw.AssetType ?? ''),
    status: String(raw.Status ?? ''),
    groupId: String(raw.GroupId ?? ''),
    projectName: String(raw.ProjectName ?? ''),
    url: typeof raw.URL === 'string' && raw.URL ? raw.URL : null,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function formatXDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}
