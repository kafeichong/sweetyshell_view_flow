jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Logger: class Logger {
    warn() {}
    error() {}
    log() {}
  },
  ServiceUnavailableException: class ServiceUnavailableException extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ServiceUnavailableException';
    }
  },
}));

import { ArkAssetLibraryService, buildSignedRequest } from './ark-asset-library.service';

const CREDENTIALS = { accessKeyId: 'AKTESTEXAMPLE', secretAccessKey: 'secret-example' };
const X_DATE = '20260917T000000Z';

describe('ArkAssetLibraryService request signing', () => {
  it('produces the same signature as the independently verified Python probe', () => {
    // 期望值由一份**已在真实账号上验证通过**的 Python 实现算出（同一组固定输入）。
    // 两边只要有一处不一致——派生密钥链的顺序、签了哪些头、查询串怎么排序编码——
    // 这个断言就会红。真去踩的话，症状是线上 403 SignatureDoesNotMatch。
    //
    // 注意：这个测试验证 Ark 包装器仍然产生与之前完全相同的签名。
    const request = buildSignedRequest(CREDENTIALS, 'GetAsset', { Id: 'asset-1', ProjectName: 'default' }, X_DATE);

    expect(request.url).toBe('https://ark.cn-beijing.volcengineapi.com/?Action=GetAsset&Version=2024-01-01');
    expect(request.payload).toBe('{"Id":"asset-1","ProjectName":"default"}');
    expect(request.headers['x-content-sha256']).toBe(
      'f350a83877d1ff873274e702ef71d8adc3953c20c2b932d346bc50156831cc99',
    );
    expect(request.headers.authorization).toBe(
      'HMAC-SHA256 Credential=AKTESTEXAMPLE/20260917/cn-beijing/ark/request, '
      + 'SignedHeaders=content-type;host;x-content-sha256;x-date, '
      + 'Signature=8c6f2eca2b857aea2a2dae964938319aba77a66c20344ca0a2b22d70ad926a48',
    );
  });
});

describe('ArkAssetLibraryService credential gate', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('refuses to run with real credentials in the contract environment', () => {
    // 与 Worker 的 REAL_PROVIDER_CREDENTIAL_FORBIDDEN 同一条规矩：合同环境里出现真实
    // 凭证就直接失败，而不是"碰巧没用到"。素材库 AK 是全账号级的，更不能在测试里跑起来。
    process.env.VIDEO_FLOW_TEST_MODE = '1';
    process.env.ARK_ASSET_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
    process.env.ARK_ASSET_ACCESS_KEY_SECRET = CREDENTIALS.secretAccessKey;

    const service = new ArkAssetLibraryService();
    expect(service.hasCredentials()).toBe(true);
    expect(service.isConfigured()).toBe(false);
    expect(() => (service as any).requireCredentials()).toThrow('REAL_PROVIDER_CREDENTIAL_FORBIDDEN');
  });

  it('fails closed when nothing is configured', () => {
    process.env.VIDEO_FLOW_TEST_MODE = '0';
    delete process.env.ARK_ASSET_ACCESS_KEY_ID;
    delete process.env.ARK_ASSET_ACCESS_KEY_SECRET;
    process.env.ARK_ASSET_CREDENTIALS_FILE = '/nonexistent/ark-asset-credentials';

    const service = new ArkAssetLibraryService();
    expect(service.isConfigured()).toBe(false);
    expect(() => (service as any).requireCredentials()).toThrow('ARK_ASSET_LIBRARY_NOT_CONFIGURED');
  });

  it('reads the two-line credentials file when no inline secrets are set', () => {
    process.env.VIDEO_FLOW_TEST_MODE = '0';
    delete process.env.ARK_ASSET_ACCESS_KEY_ID;
    delete process.env.ARK_ASSET_ACCESS_KEY_SECRET;
    const file = require('fs').mkdtempSync(require('os').tmpdir() + '/ark-cred-');
    require('fs').writeFileSync(`${file}/creds`, 'AKFROMFILE\nsecret-from-file\n');
    process.env.ARK_ASSET_CREDENTIALS_FILE = `${file}/creds`;

    const service = new ArkAssetLibraryService();
    expect(service.isConfigured()).toBe(true);
    expect((service as any).requireCredentials()).toEqual({ accessKeyId: 'AKFROMFILE', secretAccessKey: 'secret-from-file' });
  });
});

describe('ArkAssetLibraryService responses', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.VIDEO_FLOW_TEST_MODE = '0';
    process.env.ARK_ASSET_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
    process.env.ARK_ASSET_ACCESS_KEY_SECRET = CREDENTIALS.secretAccessKey;
  });

  afterEach(() => {
    process.env = { ...original };
    jest.restoreAllMocks();
  });

  const mockFetch = (payload: unknown, ok = true, status = 200) => {
    const spy = jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok,
      status,
      text: async () => JSON.stringify(payload),
    } as never);
    return spy;
  };

  it('maps a GetAsset response into the fields the submission gate needs', async () => {
    mockFetch({
      Result: {
        Id: 'asset-20260917115246-cgmtw',
        Name: '005',
        AssetType: 'Image',
        Status: 'Active',
        GroupId: 'group-20260917115246-vr2hh',
        ProjectName: 'default',
        URL: 'https://ark-media-asset-sts.example.invalid/x.jpg?X-Tos-Signature=***',
      },
    });

    const asset = await new ArkAssetLibraryService().getAsset('asset-20260917115246-cgmtw', 'default');
    expect(asset).toEqual({
      id: 'asset-20260917115246-cgmtw',
      name: '005',
      assetType: 'Image',
      status: 'Active',
      groupId: 'group-20260917115246-vr2hh',
      projectName: 'default',
      url: 'https://ark-media-asset-sts.example.invalid/x.jpg?X-Tos-Signature=***',
    });
  });

  it('reports only the provider reason code, never the request body or a signed url', async () => {
    // 这条 message 会**原样回到客户端**（ProductionSubmissionError 的既有行为）。
    // 历史上踩过"错误信息丢原因"，别再踩另一侧：把带签名的地址或请求体泄出去。
    mockFetch({
      ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'no' } },
    }, false, 403);

    const service = new ArkAssetLibraryService();
    await expect(service.getAsset('asset-x', 'default')).rejects.toThrow(
      'ARK_ASSET_LIBRARY_ERROR:AccessDenied',
    );
  });
});
