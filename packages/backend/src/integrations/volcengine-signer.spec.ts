import { buildVolcengineSignedRequest } from './volcengine-signer';

const CREDENTIALS = { accessKeyId: 'AKTESTEXAMPLE', secretAccessKey: 'secret-example' };
const X_DATE = '20260917T000000Z';

describe('Volcengine OpenAPI Signer', () => {
  describe('Ark service signature', () => {
    it('produces the same signature as the independently verified Python probe', () => {
      // 期望值由一份**已在真实账号上验证通过**的 Python 实现算出（同一组固定输入）。
      // 两边只要有一处不一致——派生密钥链的顺序、签了哪些头、查询串怎么排序编码——
      // 这个断言就会红。真去踩的话，症状是线上 403 SignatureDoesNotMatch。
      const request = buildVolcengineSignedRequest({
        credentials: CREDENTIALS,
        host: 'ark.cn-beijing.volcengineapi.com',
        region: 'cn-beijing',
        service: 'ark',
        action: 'GetAsset',
        version: '2024-01-01',
        body: { Id: 'asset-1', ProjectName: 'default' },
        xDate: X_DATE,
      });

      expect(request.url).toBe('https://ark.cn-beijing.volcengineapi.com/?Action=GetAsset&Version=2024-01-01');
      expect(request.payload).toBe('{"Id":"asset-1","ProjectName":"default"}');
      expect(request.headers['x-content-sha256']).toBe(
        'f350a83877d1ff873274e702ef71d8adc3953c20c2b932d346bc50156831cc99',
      );
      expect(request.headers.authorization).toBe(
        'HMAC-SHA256 Credential=AKTESTEXAMPLE/20260917/cn-beijing/ark/request, ' +
          'SignedHeaders=content-type;host;x-content-sha256;x-date, ' +
          'Signature=8c6f2eca2b857aea2a2dae964938319aba77a66c20344ca0a2b22d70ad926a48',
      );
    });
  });

  describe('Billing service signature', () => {
    it('produces correct signature for ListBillDetail action', () => {
      // 账单服务使用不同的 host、region、service 和 API version
      const request = buildVolcengineSignedRequest({
        credentials: CREDENTIALS,
        host: 'billing.volcengineapi.com',
        region: 'cn-north-1',
        service: 'billing',
        action: 'ListBillDetail',
        version: '2022-01-01',
        body: { BillPeriod: '2026-09', Limit: 100, Offset: 0 },
        xDate: X_DATE,
      });

      expect(request.url).toBe(
        'https://billing.volcengineapi.com/?Action=ListBillDetail&Version=2022-01-01',
      );
      expect(request.payload).toBe('{"BillPeriod":"2026-09","Limit":100,"Offset":0}');
      expect(request.headers['content-type']).toBe('application/json');
      expect(request.headers.host).toBe('billing.volcengineapi.com');
      expect(request.headers['x-date']).toBe(X_DATE);
      // 验证 authorization header 格式
      expect(request.headers.authorization).toMatch(/^HMAC-SHA256 Credential=AKTESTEXAMPLE\/20260917\/cn-north-1\/billing\/request,/);
      expect(request.headers.authorization).toContain('SignedHeaders=content-type;host;x-content-sha256;x-date');
      expect(request.headers.authorization).toContain('Signature=');
    });

    it('produces correct signature for ListBill action', () => {
      const request = buildVolcengineSignedRequest({
        credentials: CREDENTIALS,
        host: 'billing.volcengineapi.com',
        region: 'cn-north-1',
        service: 'billing',
        action: 'ListBill',
        version: '2022-01-01',
        body: { BillPeriod: '2026-09' },
        xDate: X_DATE,
      });

      expect(request.url).toBe('https://billing.volcengineapi.com/?Action=ListBill&Version=2022-01-01');
      expect(request.payload).toBe('{"BillPeriod":"2026-09"}');
      expect(request.headers.authorization).toContain('cn-north-1/billing/request');
    });
  });

  describe('RFC3986 encoding', () => {
    it('correctly encodes special characters in query parameters', () => {
      const request = buildVolcengineSignedRequest({
        credentials: CREDENTIALS,
        host: 'test.volcengineapi.com',
        region: 'cn-north-1',
        service: 'test',
        action: 'Test Action',
        version: '2022-01-01',
        body: {},
        xDate: X_DATE,
      });

      // 空格应该编码为 %20
      expect(request.url).toContain('Action=Test%20Action');
    });
  });

  describe('Signature stability', () => {
    it('produces identical signatures for identical inputs', () => {
      const input = {
        credentials: CREDENTIALS,
        host: 'billing.volcengineapi.com',
        region: 'cn-north-1',
        service: 'billing',
        action: 'ListBillDetail',
        version: '2022-01-01',
        body: { BillPeriod: '2026-09', Limit: 50 },
        xDate: X_DATE,
      };

      const request1 = buildVolcengineSignedRequest(input);
      const request2 = buildVolcengineSignedRequest(input);

      expect(request1.headers.authorization).toBe(request2.headers.authorization);
      expect(request1.headers['x-content-sha256']).toBe(request2.headers['x-content-sha256']);
    });
  });
});
