import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdapterRegistry,
  BlueExpressAdapter,
  ChilexpressAdapter,
  MockCourierAdapter,
  StarkenAdapter,
} from '../src/adapters.js';
import { ConflictError, IntegrationGatedError, newId, nowIso } from '../src/domain.js';
import { buildServer } from '../src/server.js';
import { LogisticsService } from '../src/services.js';
import { SqliteStore } from '../src/store.js';

function fixture() {
  const store = new SqliteStore(':memory:');
  const adapters = new AdapterRegistry([
    new MockCourierAdapter(),
    new StarkenAdapter(),
    new BlueExpressAdapter(),
    new ChilexpressAdapter(),
  ]);
  const service = new LogisticsService(store, adapters);
  return { store, adapters, service };
}

function createTenantWithMock(store: SqliteStore, name = 'Tenant A') {
  const tenant = store.createTenant({ id: newId(), name, createdAt: nowIso() });
  store.createCarrierConnection({
    id: newId(),
    tenantId: tenant.id,
    provider: 'mock',
    credentialRef: null,
    enabled: true,
    config: {},
    createdAt: nowIso(),
  });
  return tenant;
}

const packageSpec = { weightKg: 5, lengthCm: 30, widthCm: 20, heightCm: 20 };
const origin = { region: 'Metropolitana', commune: 'Santiago' };
const destination = { region: 'Metropolitana', commune: 'Providencia' };

test('quote engine uses active tariff snapshot before live provider', async () => {
  const { store, service } = fixture();
  const tenant = createTenantWithMock(store);
  store.createTariffSnapshot({
    id: newId(),
    tenantId: tenant.id,
    provider: 'mock',
    version: '2026-08-25-v1',
    active: true,
    createdAt: nowIso(),
    rules: [
      {
        id: newId(),
        serviceCode: 'RM_STD',
        serviceName: 'RM Standard',
        currency: 'CLP',
        amount: 4990,
        region: 'Metropolitana',
        minWeightKg: 0,
        maxWeightKg: 30,
        estimatedBusinessDays: 1,
      },
    ],
  });

  const quote = await service.quote({
    tenantId: tenant.id,
    provider: 'mock',
    origin,
    destination,
    package: packageSpec,
  });

  assert.equal(quote.source, 'snapshot');
  assert.equal(quote.amount, 4990);
  assert.equal(quote.snapshotVersion, '2026-08-25-v1');
  store.close();
});

test('shipment creation is idempotent and cross-tenant reads are isolated', async () => {
  const { store, service } = fixture();
  const tenantA = createTenantWithMock(store, 'A');
  const tenantB = createTenantWithMock(store, 'B');
  const input = {
    tenantId: tenantA.id,
    provider: 'mock' as const,
    externalOrderId: 'MLC-ORDER-1',
    origin,
    destination,
    package: packageSpec,
    idempotencyKey: 'order-1:create',
  };

  const first = await service.createShipment(input);
  const second = await service.createShipment(input);

  assert.equal(first.id, second.id);
  assert.equal(store.getShipment(tenantB.id, first.id), null);
  assert.equal(store.getShipment(tenantA.id, first.id)?.trackingNumber, first.trackingNumber);
  store.close();
});

test('tracking final states are monotonic and duplicate provider events dedupe', async () => {
  const { store, service } = fixture();
  const tenant = createTenantWithMock(store);
  const shipment = await service.createShipment({
    tenantId: tenant.id,
    provider: 'mock',
    externalOrderId: 'MLC-ORDER-2',
    origin,
    destination,
    package: packageSpec,
    idempotencyKey: 'order-2:create',
  });

  const delivered = service.ingestTracking({
    tenantId: tenant.id,
    shipmentId: shipment.id,
    providerEventId: 'evt-delivered-1',
    canonicalStatus: 'delivered',
    occurredAt: nowIso(),
  });
  const duplicate = service.ingestTracking({
    tenantId: tenant.id,
    shipmentId: shipment.id,
    providerEventId: 'evt-delivered-1',
    canonicalStatus: 'delivered',
    occurredAt: nowIso(),
  });

  assert.equal(delivered.id, duplicate.id);
  assert.throws(
    () =>
      service.ingestTracking({
        tenantId: tenant.id,
        shipmentId: shipment.id,
        providerEventId: 'evt-late-transit',
        canonicalStatus: 'in_transit',
        occurredAt: nowIso(),
      }),
    ConflictError,
  );
  store.close();
});

test('real carrier adapter fails closed until official mapping is loaded', async () => {
  const { store, service } = fixture();
  const tenant = store.createTenant({ id: newId(), name: 'Starken tenant', createdAt: nowIso() });
  store.createCarrierConnection({
    id: newId(),
    tenantId: tenant.id,
    provider: 'starken',
    credentialRef: 'starken-test',
    enabled: true,
    config: { capabilities: ['create_shipment'] },
    createdAt: nowIso(),
  });

  await assert.rejects(
    () =>
      service.createShipment({
        tenantId: tenant.id,
        provider: 'starken',
        externalOrderId: 'MLC-ORDER-3',
        origin,
        destination,
        package: packageSpec,
        idempotencyKey: 'order-3:create',
      }),
    IntegrationGatedError,
  );
  store.close();
});

test('HTTP MVP creates tenant, snapshot and quote while rejecting inline secrets', async () => {
  const { store, adapters } = fixture();
  const app = buildServer({
    store,
    adapters,
    config: {
      host: '127.0.0.1',
      port: 0,
      sqlitePath: ':memory:',
      logLevel: 'silent',
      me1Certified: false,
      enableDevRoutes: true,
      meliApiBaseUrl: 'https://api.mercadolibre.com',
    },
  });

  const tenantResponse = await app.inject({ method: 'POST', url: '/v1/tenants', payload: { name: 'HTTP tenant' } });
  assert.equal(tenantResponse.statusCode, 201);
  const tenant = tenantResponse.json() as { id: string };

  const badCarrier = await app.inject({
    method: 'POST',
    url: `/v1/tenants/${tenant.id}/carriers`,
    payload: { provider: 'mock', config: { token: 'must-not-be-stored' } },
  });
  assert.equal(badCarrier.statusCode, 400);
  assert.equal((badCarrier.json() as { error: string }).error, 'inline_secret_rejected');

  const carrier = await app.inject({
    method: 'POST',
    url: `/v1/tenants/${tenant.id}/carriers`,
    payload: { provider: 'mock', config: {} },
  });
  assert.equal(carrier.statusCode, 201);

  const snapshot = await app.inject({
    method: 'POST',
    url: `/v1/tenants/${tenant.id}/tariff-snapshots`,
    payload: {
      provider: 'mock',
      version: 'http-v1',
      rules: [
        {
          serviceCode: 'HTTP_STD',
          serviceName: 'HTTP Standard',
          currency: 'CLP',
          amount: 5990,
          minWeightKg: 0,
          maxWeightKg: 20,
          estimatedBusinessDays: 2,
        },
      ],
    },
  });
  assert.equal(snapshot.statusCode, 201);

  const quote = await app.inject({
    method: 'POST',
    url: '/v1/quotes',
    payload: {
      tenantId: tenant.id,
      provider: 'mock',
      origin,
      destination,
      package: packageSpec,
    },
  });
  assert.equal(quote.statusCode, 200);
  assert.equal((quote.json() as { amount: number }).amount, 5990);

  const safety = await app.inject({ method: 'GET', url: '/v1/dev/safety' });
  assert.deepEqual(safety.json(), {
    me1Certified: false,
    liveCarrierMappingsInstalled: false,
    productionCallsInDefaultConfig: false,
  });

  await app.close();
});


test('server refuses non-loopback bind without runtime API key', () => {
  const { store, adapters } = fixture();
  assert.throws(() =>
    buildServer({
      store,
      adapters,
      config: {
        host: '0.0.0.0',
        port: 8787,
        sqlitePath: ':memory:',
        logLevel: 'silent',
        me1Certified: false,
        enableDevRoutes: false,
        meliApiBaseUrl: 'https://api.mercadolibre.com',
      },
    }),
  /APP_API_KEY is required/);
  store.close();
});


test('HTTP quote boundary rejects unknown delivery modes and negative declared values', async () => {
  const { store, adapters } = fixture();
  const tenant = createTenantWithMock(store);
  store.createTariffSnapshot({
    id: newId(), tenantId: tenant.id, provider: 'mock', version: 'validation-v1', active: true, createdAt: nowIso(),
    rules: [{ id: newId(), serviceCode: 'STD', serviceName: 'Standard', currency: 'CLP', amount: 4990, minWeightKg: 0, maxWeightKg: 100, estimatedBusinessDays: 2 }],
  });
  const app = buildServer({ store, adapters, config: { host: '127.0.0.1', port: 0, sqlitePath: ':memory:', logLevel: 'silent', me1Certified: false, enableDevRoutes: false, meliApiBaseUrl: 'https://api.mercadolibre.com' } });

  const invalidMode = await app.inject({ method: 'POST', url: '/v1/quotes', payload: {
    tenantId: tenant.id, provider: 'mock', origin, destination, package: packageSpec, deliveryPreference: 'teleport',
  } });
  assert.equal(invalidMode.statusCode, 400);

  const invalidValue = await app.inject({ method: 'POST', url: '/v1/quotes', payload: {
    tenantId: tenant.id, provider: 'mock', origin, destination, package: packageSpec, declaredValueClp: -1,
  } });
  assert.equal(invalidValue.statusCode, 400);
  await app.close();
});


test('snapshot rules prefer exact delivery and payment metadata over cheaper generic rules', async () => {
  const { store, service } = fixture();
  const tenant = createTenantWithMock(store);
  store.createTariffSnapshot({
    id: newId(), tenantId: tenant.id, provider: 'mock', version: 'delivery-v1', active: true, createdAt: nowIso(),
    rules: [
      { id: newId(), serviceCode: 'GEN', serviceName: 'Generic', currency: 'CLP', amount: 1000, minWeightKg: 0, maxWeightKg: 100, estimatedBusinessDays: 2 },
      { id: newId(), serviceCode: 'HOME', serviceName: 'Home', currency: 'CLP', amount: 3000, minWeightKg: 0, maxWeightKg: 100, estimatedBusinessDays: 2, deliveryMode: 'home', paymentMode: 'recipient_pay' },
      { id: newId(), serviceCode: 'AGENCY', serviceName: 'Agency', currency: 'CLP', amount: 5000, minWeightKg: 0, maxWeightKg: 100, estimatedBusinessDays: 2, deliveryMode: 'agency', paymentMode: 'sender_prepaid' },
    ],
  });
  const quote = await service.quote({
    tenantId: tenant.id, provider: 'mock', origin, destination, package: packageSpec,
    deliveryPreference: 'agency', paymentMode: 'sender_prepaid', declaredValueClp: 25000,
  });
  assert.equal(quote.serviceCode, 'AGENCY');
  assert.equal(quote.deliveryMode, 'agency');
  store.close();
});
