import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { buildVolcengineSignedRequest, VolcengineCredentials } from '../../integrations/volcengine-signer';

const DEFAULT_ENDPOINT = 'https://billing.volcengineapi.com';
const DEFAULT_REGION = 'cn-north-1';
const SERVICE = 'billing';
const API_VERSION = '2022-01-01';

/**
 * 火山账单中的一行明细（规范化后）。
 */
export type BillingLine = {
  billDetailId: string;
  billPeriod: string;
  product: string;
  configuration: string;
  instanceId: string;
  billingUnit: string;
  currency: 'CNY';
  originalCny: string;
  discountCny: string;
  roundingCny: string;
  payableCny: string;
};

/**
 * 一个月度账单的完整快照。
 */
export type BillingMonthSnapshot = {
  provider: 'volcengine';
  monthKey: string;
  detailCount: number;
  includedLines: BillingLine[];
  detailPayableCny: string;
  billPayableCny: string;
  sourceDigest: string;
};

/**
 * 账单 Provider 客户端接口。
 */
export interface BillingProviderClient {
  fetchMonth(monthKey: string): Promise<BillingMonthSnapshot>;
}

/**
 * 火山引擎账单只读客户端。
 *
 * 使用费用中心 OpenAPI 获取正式账单，不创建付费任务。
 * 只纳入已验证的豆包 Seedance 推理和对应 AI 节省计划费用。
 */
@Injectable()
export class VolcengineBillingClient implements BillingProviderClient {
  private readonly endpoint: string;
  private readonly region: string;

  constructor() {
    this.endpoint = process.env.VOLCENGINE_BILLING_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
    this.region = process.env.VOLCENGINE_BILLING_REGION?.trim() || DEFAULT_REGION;
  }

  async fetchMonth(monthKey: string): Promise<BillingMonthSnapshot> {
    const credentials = this.requireCredentials();

    // 分页拉取所有明细
    const details = await this.fetchAllDetails(credentials, monthKey);

    // 规范化并过滤
    const normalized = details.map(normalizeDetail);
    const includedLines = normalized.filter(isIncludedProduct);

    // 验证纳入的明细
    for (const line of includedLines) {
      if (line.currency !== 'CNY') {
        throw new Error(`NON_CNY_CURRENCY:${line.currency}`);
      }
      if (parseFloat(line.payableCny) < 0) {
        throw new Error('NEGATIVE_AMOUNT');
      }
    }

    // 获取账单总额用于复核
    const billTotal = await this.fetchBillTotal(credentials, monthKey);

    // 计算明细合计
    const detailPayableCny = includedLines
      .reduce((sum, line) => sum.add(new Prisma.Decimal(line.payableCny)), new Prisma.Decimal(0))
      .toFixed(6);

    // 复核总额
    if (detailPayableCny !== billTotal) {
      throw new Error(`BILL_TOTAL_MISMATCH:detail=${detailPayableCny},bill=${billTotal}`);
    }

    // 计算源摘要
    const sortedLines = [...includedLines].sort((a, b) => a.billDetailId.localeCompare(b.billDetailId));
    const sourceDigest = createHash('sha256')
      .update(JSON.stringify(sortedLines))
      .digest('hex');

    return {
      provider: 'volcengine',
      monthKey,
      detailCount: includedLines.length,
      includedLines,
      detailPayableCny,
      billPayableCny: billTotal,
      sourceDigest,
    };
  }

  private requireCredentials(): VolcengineCredentials {
    // 测试环境禁止真实凭证
    if (process.env.VIDEO_FLOW_TEST_MODE === '1') {
      const hasCredentials =
        process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID?.trim() &&
        process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY?.trim();
      if (hasCredentials) {
        throw new Error('REAL_PROVIDER_CREDENTIAL_FORBIDDEN');
      }
    }

    const accessKeyId = process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY?.trim();

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('VOLCENGINE_BILLING_NOT_CONFIGURED');
    }

    return { accessKeyId, secretAccessKey };
  }

  private async fetchAllDetails(credentials: VolcengineCredentials, monthKey: string): Promise<any[]> {
    const allDetails: any[] = [];
    const seenIds = new Set<string>();
    let offset = 0;
    const limit = 50;
    let total: number | null = null;

    for (;;) {
      const response = await this.call(credentials, 'ListBillDetail', {
        BillPeriod: monthKey,
        Limit: limit,
        Offset: offset,
      });

      const list = response.Result?.List ?? [];
      const currentTotal = response.Result?.Total ?? 0;

      if (total === null) {
        total = currentTotal;
      } else if (total !== currentTotal) {
        throw new Error('PAGINATION_TOTAL_CHANGED');
      }

      // 如果没有更多数据但 offset < total，说明分页不完整
      if (list.length === 0 && offset < total) {
        throw new Error(`INCOMPLETE_PAGINATION:expected=${total},actual=${allDetails.length}`);
      }

      for (const item of list) {
        const id = item.BillDetailId;
        if (seenIds.has(id)) {
          throw new Error(`DUPLICATE_BILL_DETAIL_ID:${id}`);
        }
        seenIds.add(id);
        allDetails.push(item);
      }

      offset += list.length;

      if (offset >= total) {
        break;
      }
    }

    if (allDetails.length !== total) {
      throw new Error(`INCOMPLETE_PAGINATION:expected=${total},actual=${allDetails.length}`);
    }

    return allDetails;
  }

  private async fetchBillTotal(credentials: VolcengineCredentials, monthKey: string): Promise<string> {
    const response = await this.call(credentials, 'ListBill', {
      BillPeriod: monthKey,
    });

    const list = response.Result?.List ?? [];

    // 只纳入视频生成产品
    const included = list.filter((item: any) => isIncludedProductName(item.Product));

    const total = included
      .reduce((sum: Prisma.Decimal, item: any) => {
        const amount = item.PayableAmount;
        if (typeof amount !== 'string') {
          throw new Error('BILL_AMOUNT_NOT_STRING');
        }
        return sum.add(new Prisma.Decimal(amount));
      }, new Prisma.Decimal(0))
      .toFixed(6);

    return total;
  }

  private async call(
    credentials: VolcengineCredentials,
    action: string,
    body: Record<string, unknown>,
  ): Promise<any> {
    const host = this.endpoint.replace(/^https?:\/\//, '');
    const xDate = formatXDate(new Date());

    const request = buildVolcengineSignedRequest({
      credentials,
      host,
      region: this.region,
      service: SERVICE,
      action,
      version: API_VERSION,
      body,
      xDate,
    });

    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.payload,
    });

    const text = await response.text();
    let parsed: any = null;

    try {
      parsed = JSON.parse(text);
    } catch {
      // 非 JSON 响应
    }

    if (!response.ok) {
      const code = parsed?.ResponseMetadata?.Error?.Code ?? `HTTP_${response.status}`;
      // 不包含凭证、签名或完整响应体
      throw new Error(`BILLING_API_ERROR:${code}`);
    }

    return parsed;
  }
}

function normalizeDetail(raw: any): BillingLine {
  return {
    billDetailId: String(raw.BillDetailId ?? ''),
    billPeriod: String(raw.BillPeriod ?? ''),
    product: String(raw.Product ?? ''),
    configuration: String(raw.Configuration ?? ''),
    instanceId: String(raw.InstanceNo ?? ''),
    billingUnit: String(raw.Element ?? ''),
    currency: String(raw.Currency ?? '') as 'CNY',
    originalCny: ensureDecimalString(raw.OriginalBillAmount),
    discountCny: ensureDecimalString(raw.DiscountBillAmount),
    roundingCny: ensureDecimalString(raw.RoundBillAmount),
    payableCny: ensureDecimalString(raw.PayableAmount),
  };
}

function isIncludedProduct(line: BillingLine): boolean {
  return isIncludedProductName(line.product);
}

function isIncludedProductName(product: string): boolean {
  // MVP 只纳入豆包 Seedance 视频生成
  return product.includes('视频生成') && product.includes('豆包');
}

function ensureDecimalString(value: any): string {
  if (typeof value !== 'string') {
    throw new Error('AMOUNT_NOT_STRING');
  }
  // 验证可以解析为 Decimal
  new Prisma.Decimal(value);
  return value;
}

function formatXDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}
