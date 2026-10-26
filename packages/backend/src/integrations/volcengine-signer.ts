import { createHash, createHmac } from 'crypto';

/**
 * 火山引擎 OpenAPI 通用签名器。
 *
 * 遵守火山引擎 SigV4 签名规范，可用于 Ark、Billing 等所有基于 AK/SK 的服务。
 * 抽取为独立模块是为了让不同服务（素材库、账单）共用签名逻辑，避免重复实现。
 */

export type VolcengineCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type VolcengineSignedRequestInput = {
  credentials: VolcengineCredentials;
  host: string;
  region: string;
  service: string;
  action: string;
  version: string;
  body: Record<string, unknown>;
  xDate: string;
};

/**
 * 构造一条已签名的火山引擎 OpenAPI 请求。
 *
 * 使用 HMAC-SHA256 签名，遵守火山引擎 SigV4 规范（与 AWS SigV4 同形）。
 * 抽成纯函数是为了能用固定时钟对拍：同一组输入必须算出同一个签名。
 *
 * @param input 包含凭证、服务信息、动作和请求体的完整输入
 * @returns 包含 URL、headers 和 payload 的已签名请求
 */
export function buildVolcengineSignedRequest(
  input: VolcengineSignedRequestInput,
): { url: string; headers: Record<string, string>; payload: string } {
  const { credentials, host, region, service, action, version, body, xDate } = input;

  const payload = JSON.stringify(body);
  const payloadHash = sha256Hex(payload);
  const shortDate = xDate.slice(0, 8);

  // 构造 canonical query string
  const canonicalQuery = Object.entries({ Action: action, Version: version })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&');

  // 构造 canonical headers
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: host,
    'x-content-sha256': payloadHash,
    'x-date': xDate,
  };
  const sortedNames = Object.keys(headers).sort();
  const signedHeaders = sortedNames.join(';');
  const canonicalHeaders = sortedNames.map((key) => `${key}:${headers[key]}\n`).join('');

  // 构造 canonical request
  const canonicalRequest = ['POST', '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  // 构造 string to sign
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  // 派生密钥链：SK -> 日期 -> 区域 -> 服务 -> "request"，与 AWS SigV4 同形。
  const signingKey = [shortDate, region, service, 'request'].reduce(
    (key: Buffer | string, step) => hmacSha256(key, step),
    credentials.secretAccessKey,
  ) as Buffer;

  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    url: `https://${host}/?${canonicalQuery}`,
    headers: {
      ...headers,
      authorization:
        `HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    payload,
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
