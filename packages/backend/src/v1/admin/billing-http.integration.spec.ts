import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { BillingController } from './billing.controller';
import { BillingImportService } from './billing-import.service';

// Exercise real Nest decorators, DI, Express routing and JSON body parsing.
// External billing and persistence are replaced at their service boundary only.
describe('BillingController Nest HTTP integration', () => {
  let app: INestApplication;
  const originalAdminToken = process.env.VIDEO_FLOW_ADMIN_TOKEN;
  const billing = {
    importAndPreview: jest.fn(),
    confirm: jest.fn(),
  };

  beforeAll(async () => {
    process.env.VIDEO_FLOW_ADMIN_TOKEN = 'billing-test-admin';
    const moduleRef = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: BillingImportService, useValue: billing }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (originalAdminToken === undefined) delete process.env.VIDEO_FLOW_ADMIN_TOKEN;
    else process.env.VIDEO_FLOW_ADMIN_TOKEN = originalAdminToken;
  });
  beforeEach(() => jest.clearAllMocks());

  it.each(['import', 'confirm'])('rejects anonymous %s before calling billing', async route => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/billing/${route}`)
      .send({ monthKey: '2026-09', provider: 'volcengine', userId: 'forged-admin' })
      .expect(401);
    expect(billing.importAndPreview).not.toHaveBeenCalled();
    expect(billing.confirm).not.toHaveBeenCalled();
  });

  it.each(['import', 'confirm'])('rejects an invalid admin token for %s', async route => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/billing/${route}`)
      .set('x-admin-token', 'invalid-test-admin')
      .send({ monthKey: '2026-09', provider: 'volcengine' })
      .expect(401);
    expect(billing.importAndPreview).not.toHaveBeenCalled();
    expect(billing.confirm).not.toHaveBeenCalled();
  });

  it('returns 401 rather than 500 for a token with extra UTF-8 bytes', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/billing/import')
      .set('x-admin-token', 'éilling-test-admin')
      .send({ monthKey: '2026-09', provider: 'volcengine' })
      .expect(401);
    expect(billing.importAndPreview).not.toHaveBeenCalled();
    expect(billing.confirm).not.toHaveBeenCalled();
  });

  it('injects the billing service and routes an import request', async () => {
    billing.importAndPreview.mockResolvedValue({ monthKey: '2026-09', allocations: [] });
    await request(app.getHttpServer())
      .post('/api/v1/admin/billing/import')
      .set('x-admin-token', 'billing-test-admin')
      .send({ monthKey: '2026-09', provider: 'volcengine' })
      .expect(201)
      .expect({ monthKey: '2026-09', allocations: [] });
    expect(billing.importAndPreview).toHaveBeenCalledWith('2026-09', 'volcengine');
  });

  it('routes confirmation and serializes the result', async () => {
    billing.confirm.mockResolvedValue({ billId: 'bill-fixture', allocationCount: 2 });
    await request(app.getHttpServer())
      .post('/api/v1/admin/billing/confirm')
      .set('x-admin-token', 'billing-test-admin')
      .send({ monthKey: '2026-09', provider: 'volcengine', userId: 'admin-fixture' })
      .expect(201)
      .expect({ billId: 'bill-fixture', allocationCount: 2 });
    expect(billing.confirm).toHaveBeenCalledWith('2026-09', 'volcengine', 'admin-fixture');
  });
});
