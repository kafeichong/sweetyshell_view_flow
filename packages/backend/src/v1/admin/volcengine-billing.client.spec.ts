import { VolcengineBillingClient } from './volcengine-billing.client';

const page1Fixture = require('./fixtures/volcengine-list-bill-detail-page-1.json');
const page2Fixture = require('./fixtures/volcengine-list-bill-detail-page-2.json');
const listBillFixture = require('./fixtures/volcengine-list-bill.json');

describe('VolcengineBillingClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.VIDEO_FLOW_TEST_MODE = '1';
    delete process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID;
    delete process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('credential gate', () => {
    it('throws REAL_PROVIDER_CREDENTIAL_FORBIDDEN when test mode has real credentials', () => {
      process.env.VIDEO_FLOW_TEST_MODE = '1';
      process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID = 'AK_TEST';
      process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY = 'SK_TEST';

      const client = new VolcengineBillingClient();
      expect(() => client.fetchMonth('2026-09')).rejects.toThrow('REAL_PROVIDER_CREDENTIAL_FORBIDDEN');
    });

    it('throws configuration error when credentials are missing in production mode', () => {
      process.env.VIDEO_FLOW_TEST_MODE = '0';
      delete process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID;
      delete process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY;

      const client = new VolcengineBillingClient();
      expect(() => client.fetchMonth('2026-09')).rejects.toThrow('VOLCENGINE_BILLING_NOT_CONFIGURED');
    });
  });

  describe('pagination', () => {
    it('fetches multiple pages until total is reached', async () => {
      process.env.VIDEO_FLOW_TEST_MODE = '0';
      process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID = 'AK_TEST';
      process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY = 'SK_TEST';

      // 构造完整的两页数据（Total = 2）
      const page1 = {
        ...page1Fixture,
        Result: {
          ...page1Fixture.Result,
          Total: 2,
          Limit: 50,
          Offset: 0,
        },
      };

      const page2 = {
        ...page2Fixture,
        Result: {
          ...page2Fixture.Result,
          Total: 2,
          Limit: 50,
          Offset: 1,
        },
      };

      // ListBill 返回两条明细的合计
      const billTotal = {
        ...listBillFixture,
        Result: {
          ...listBillFixture.Result,
          List: [{
            ...listBillFixture.Result.List[0],
            PayableAmount: '13.734000', // 6.111000 + 7.623000
          }],
        },
      };

      const mockFetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(page1),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(page2),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(billTotal),
        });

      global.fetch = mockFetch as any;

      const client = new VolcengineBillingClient();
      const result = await client.fetchMonth('2026-09');

      expect(result.provider).toBe('volcengine');
      expect(result.monthKey).toBe('2026-09');
      expect(result.detailCount).toBe(2);
      expect(result.includedLines).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(3); // 2 detail pages + 1 bill summary
    });

    it('detects duplicate bill detail IDs across pages', async () => {
      process.env.VIDEO_FLOW_TEST_MODE = '0';
      process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID = 'AK_TEST';
      process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY = 'SK_TEST';

      const page1 = {
        ...page1Fixture,
        Result: { ...page1Fixture.Result, Total: 2 },
      };

      const duplicatePage = {
        ...page2Fixture,
        Result: {
          ...page2Fixture.Result,
          Total: 2,
          List: [{ ...page1Fixture.Result.List[0], BillDetailId: 'detail-001' }],
        },
      };

      const mockFetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(page1),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(duplicatePage),
        });

      global.fetch = mockFetch as any;

      const client = new VolcengineBillingClient();
      await expect(client.fetchMonth('2026-09')).rejects.toThrow('DUPLICATE_BILL_DETAIL_ID');
    });

    it('throws error when page count does not match total', async () => {
      process.env.VIDEO_FLOW_TEST_MODE = '0';
      process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID = 'AK_TEST';
      process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY = 'SK_TEST';

      // 第一页声称有 3 条记录
      const page1 = {
        ...page1Fixture,
        Result: {
          ...page1Fixture.Result,
          Total: 3,
          Limit: 50,
          Offset: 0,
          List: [page1Fixture.Result.List[0]],
        },
      };

      // 第二页空，但 total 仍然是 3（不一致）
      const emptyPage = {
        ...page1Fixture,
        Result: {
          ...page1Fixture.Result,
          Total: 3,
          Limit: 50,
          Offset: 1,
          List: [],
        },
      };

      const mockFetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(page1),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(emptyPage),
        });

      global.fetch = mockFetch as any;

      const client = new VolcengineBillingClient();
      await expect(client.fetchMonth('2026-09')).rejects.toThrow('INCOMPLETE_PAGINATION');
    });
  });

  describe('validation', () => {
    it('rejects non-CNY currency', async () => {
      process.env.VIDEO_FLOW_TEST_MODE = '0';
      process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID = 'AK_TEST';
      process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY = 'SK_TEST';

      const usdPage = {
        ...page1Fixture,
        Result: {
          ...page1Fixture.Result,
          List: [{ ...page1Fixture.Result.List[0], Currency: 'USD' }],
          Total: 1,
        },
      };

      const mockFetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(usdPage),
        });

      global.fetch = mockFetch as any;

      const client = new VolcengineBillingClient();
      await expect(client.fetchMonth('2026-09')).rejects.toThrow('NON_CNY_CURRENCY');
    });

    it('rejects negative amounts', async () => {
      process.env.VIDEO_FLOW_TEST_MODE = '0';
      process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID = 'AK_TEST';
      process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY = 'SK_TEST';

      const negativePage = {
        ...page1Fixture,
        Result: {
          ...page1Fixture.Result,
          List: [{ ...page1Fixture.Result.List[0], PayableAmount: '-10.000000' }],
          Total: 1,
        },
      };

      const mockFetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(negativePage),
        });

      global.fetch = mockFetch as any;

      const client = new VolcengineBillingClient();
      await expect(client.fetchMonth('2026-09')).rejects.toThrow('NEGATIVE_AMOUNT');
    });

    it('validates bill total matches detail sum', async () => {
      process.env.VIDEO_FLOW_TEST_MODE = '0';
      process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID = 'AK_TEST';
      process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY = 'SK_TEST';

      const page1 = {
        ...page1Fixture,
        Result: { ...page1Fixture.Result, Total: 2 },
      };

      const page2 = {
        ...page2Fixture,
        Result: { ...page2Fixture.Result, Total: 2 },
      };

      const mismatchBill = {
        ...listBillFixture,
        Result: {
          ...listBillFixture.Result,
          List: [{ ...listBillFixture.Result.List[0], PayableAmount: '999.999999' }],
        },
      };

      const mockFetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(page1),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(page2),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(mismatchBill),
        });

      global.fetch = mockFetch as any;

      const client = new VolcengineBillingClient();
      await expect(client.fetchMonth('2026-09')).rejects.toThrow('BILL_TOTAL_MISMATCH');
    });

    it('excludes non-video-generation products', async () => {
      process.env.VIDEO_FLOW_TEST_MODE = '0';
      process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID = 'AK_TEST';
      process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY = 'SK_TEST';

      const mixedPage = {
        ...page1Fixture,
        Result: {
          ...page1Fixture.Result,
          Total: 2,
          List: [
            page1Fixture.Result.List[0], // 视频生成-豆包大模型平台
            { ...page1Fixture.Result.List[0], BillDetailId: 'detail-002', Product: '对象存储 TOS' },
          ],
        },
      };

      const billSummary = {
        ...listBillFixture,
        Result: {
          ...listBillFixture.Result,
          List: [
            { ...listBillFixture.Result.List[0], PayableAmount: '6.111000' }, // 只计算视频生成
          ],
        },
      };

      const mockFetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(mixedPage),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify(billSummary),
        });

      global.fetch = mockFetch as any;

      const client = new VolcengineBillingClient();
      const result = await client.fetchMonth('2026-09');

      expect(result.detailCount).toBe(1); // 只包含视频生成产品
      expect(result.includedLines[0].product).toContain('视频生成');
    });
  });

  describe('error handling', () => {
    it('handles HTTP 403 authentication failure', async () => {
      process.env.VIDEO_FLOW_TEST_MODE = '0';
      process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID = 'AK_TEST';
      process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY = 'SK_TEST';

      const mockFetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ ResponseMetadata: { Error: { Code: 'InvalidAccessKeyId' } } }),
      });

      global.fetch = mockFetch as any;

      const client = new VolcengineBillingClient();
      await expect(client.fetchMonth('2026-09')).rejects.toThrow('BILLING_API_ERROR');
    });

    it('does not include credentials in error messages', async () => {
      process.env.VIDEO_FLOW_TEST_MODE = '0';
      process.env.VOLCENGINE_BILLING_ACCESS_KEY_ID = 'AK_SENSITIVE';
      process.env.VOLCENGINE_BILLING_SECRET_ACCESS_KEY = 'SK_SENSITIVE';

      const mockFetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Unauthorized',
      });

      global.fetch = mockFetch as any;

      const client = new VolcengineBillingClient();

      try {
        await client.fetchMonth('2026-09');
        fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).not.toContain('AK_SENSITIVE');
        expect(error.message).not.toContain('SK_SENSITIVE');
        expect(error.message).not.toContain('authorization');
      }
    });
  });
});
