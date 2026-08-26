import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AdapterRegistry, MockCourierAdapter } from '../src/adapters.js';
import {
  newId,
  nowIso,
  type CarrierCapability,
  type CarrierConnection,
  type ProviderShipmentResult,
  type QuoteInput,
  type QuoteResult,
  type ShipmentCreateInput,
} from '../src/domain.js';
import type { CourierAdapter } from '../src/ports.js';
import { buildServer } from '../src/server.js';
import { SqliteStore } from '../src/store.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function payloadDigest(input: ShipmentCreateInput): string {
  return sha256(JSON.stringify(canonical(input)));
}

class ControlledTestAdapter implements CourierAdapter {
  readonly provider = 'starken' as const;
  readonly caps = new Set<CarrierCapability>(['quote', 'create_shipment']);
  quoteCalls = 0;
  createCalls = 0;
  createDelayMs = 0;
  lastConnection: CarrierConnection | null = null;

  capabilities(_connection: CarrierConnection): ReadonlySet<CarrierCapability> {
    return this.caps;
  }

  async quote(input: QuoteInput, connection: CarrierConnection): Promise<QuoteResult> {
    this.quoteCalls += 1;
    this.lastConnection = connection;
    return {
      provider: 'starken',
      serviceCode: 'NORMAL',
      serviceName: 'Normal',
      currency: 'CLP',
      amount: 4200,
      estimatedBusinessDays: 2,
      chargeableWeightKg: input.package.weightKg,
      snapshotVersion: null,
      source: 'live',
      deliveryMode: input.deliveryPreference === 'agency' ? 'agency' : 'home',
      paymentMode: input.paymentMode ?? 'recipient_pay',
    };
  }

  async createShipment(input: ShipmentCreateInput, connection: CarrierConnection): Promise<ProviderShipmentResult> {
    this.createCalls += 1;
    this.lastConnection = connection;
    if (this.createDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    return {
      providerShipmentRef: `controlled-${input.externalOrderId}`,
      trackingNumber: 'OF-CONTROLLED-1',
      status: 'label_ready',
      metadata: { fixture: true },
    };
  }
}

function fixture() {
  const store = new SqliteStore(':memory:');
  const adapter = new ControlledTestAdapter();
  const adapters = new AdapterRegistry([new MockCourierAdapter(), adapter]);
  const tenant = store.createTenant({ id: newId(), name: 'Controlled Fixture', createdAt: nowIso() });
  const connection = store.createCarrierConnection({
    id: newId(),
    tenantId: tenant.id,
    provider: 'starken',
    credentialRef: 'starken/fixture',
    enabled: false,
    config: {
      protocol: 'starken-plugin-gateway-v1',
      capabilities: ['quote', 'create_shipment'],
      allowedOriginAgencyCodes: ['1001'],
      trackingStatusMap: {},
    },
    createdAt: nowIso(),
  });
  const shipment: ShipmentCreateInput = {
    tenantId: tenant.id,
    provider: 'starken',
    externalOrderId: 'ORDER-CONTROLLED-1',
    origin: {
      region: 'Metropolitana',
      commune: 'Santiago',
      providerCityCode: '1',
      providerCommuneCode: '3126',
      providerAgencyCode: '1001',
      street: 'Origen',
      number: '100',
    },
    destination: {
      region: 'Maule',
      commune: 'Talca',
      providerCityCode: '91',
      providerCommuneCode: '3001',
      street: 'Destino',
      number: '200',
    },
    package: { weightKg: 1, lengthCm: 20, widthCm: 15, heightCm: 10 },
    idempotencyKey: 'controlled-order-1',
    serviceCode: 'NORMAL',
    deliveryMode: 'home',
    paymentMode: 'recipient_pay',
    declaredValueClp: 40000,
    recipient: {
      taxId: '11111111-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '+56911111111',
      email: 'ada@example.invalid',
      contactName: 'Ada Lovelace',
    },
  };
  const secret = 'fixture-approval-secret';
  const approval = {
    approvalId: 'approval-fixture-1',
    tenantId: tenant.id,
    provider: 'starken' as const,
    payloadSha256: payloadDigest(shipment),
    secretSha256: sha256(secret),
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const previewSecret = 'fixture-preview-secret';
  const preview = {
    previewId: 'preview-fixture-1',
    tenantId: tenant.id,
    provider: 'starken' as const,
    secretSha256: sha256(previewSecret),
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const baseConfig = {
    host: '127.0.0.1',
    port: 0,
    sqlitePath: ':memory:',
    logLevel: 'silent',
    me1Certified: false,
    enableDevRoutes: false,
    meliApiBaseUrl: 'https://api.mercadolibre.com',
  };
  return { store, adapter, adapters, tenant, connection, shipment, secret, approval, previewSecret, preview, baseConfig };
}

const approvalHeader = (secret: string) => ({ 'x-controlled-shipment-approval': secret });
const previewHeader = (secret: string) => ({ 'x-controlled-shipment-preview': secret });

test('controlled routes are absent by default and normal shipment route still rejects disabled carriers', async () => {
  const { store, adapters, shipment, secret, baseConfig } = fixture();
  const app = buildServer({ store, adapters, config: baseConfig });
  const controlled = await app.inject({ method: 'POST', url: '/v1/controlled-shipments', headers: approvalHeader(secret), payload: shipment });
  assert.equal(controlled.statusCode, 404);
  const normal = await app.inject({ method: 'POST', url: '/v1/shipments', payload: shipment });
  assert.equal(normal.statusCode, 404);
  await app.close();
});

test('configured controlled ceremony is refused outside loopback', () => {
  const { store, adapters, approval, baseConfig } = fixture();
  assert.throws(
    () => buildServer({ store, adapters, config: { ...baseConfig, host: '0.0.0.0', apiKey: 'fixture-api-key', controlledShipmentApproval: approval } }),
    /controlled shipment.*loopback/i,
  );
  store.close();
});


test('preview and approval gates cannot coexist in one runtime', () => {
  const { store, adapters, preview, approval, baseConfig } = fixture();
  assert.throws(
    () => buildServer({ store, adapters, config: { ...baseConfig, controlledShipmentPreview: preview, controlledShipmentApproval: approval } }),
    /preview and approval runtimes must be separate/i,
  );
  store.close();
});

test('controlled preview can quote and derive normalized create digest while write route is absent', async () => {
  const { store, adapter, adapters, tenant, shipment, previewSecret, preview, baseConfig } = fixture();
  const app = buildServer({ store, adapters, config: { ...baseConfig, controlledShipmentPreview: preview } });
  const quotePayload = {
    tenantId: tenant.id,
    provider: 'starken',
    origin: shipment.origin,
    destination: shipment.destination,
    package: shipment.package,
    allowLive: true,
    deliveryPreference: shipment.deliveryMode,
    paymentMode: shipment.paymentMode,
    declaredValueClp: shipment.declaredValueClp,
  };
  const denied = await app.inject({ method: 'POST', url: '/v1/controlled-quotes', headers: previewHeader('wrong-secret'), payload: quotePayload });
  assert.equal(denied.statusCode, 403);
  assert.equal(adapter.quoteCalls, 0);
  assert.equal(app.hasRoute({ method: 'POST', url: '/v1/controlled-shipments' }), false, 'preview runtime must not register controlled create');
  const normalMutation = await app.inject({ method: 'POST', url: '/v1/shipments', payload: shipment });
  assert.equal(normalMutation.statusCode, 423, 'preview runtime must lock normal mutations');

  const ok = await app.inject({ method: 'POST', url: '/v1/controlled-quotes', headers: previewHeader(previewSecret), payload: quotePayload });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(adapter.quoteCalls, 1);
  assert.equal(adapter.lastConnection?.enabled, false);

  const digest = await app.inject({ method: 'POST', url: '/v1/controlled-shipment-digest', headers: previewHeader(previewSecret), payload: shipment });
  assert.equal(digest.statusCode, 200, digest.body);
  assert.equal(digest.json().payloadSha256, payloadDigest(shipment));
  assert.equal(adapter.createCalls, 0, 'digest derivation must never touch provider create');
  await app.close();
});

test('controlled shipment requires exact approved payload and keeps carrier disabled', async () => {
  const { store, adapter, adapters, connection, shipment, secret, approval, baseConfig } = fixture();
  const app = buildServer({ store, adapters, config: { ...baseConfig, controlledShipmentApproval: approval } });
  assert.equal(app.hasRoute({ method: 'POST', url: '/v1/controlled-quotes' }), false, 'approval runtime must not register preview quote');
  assert.equal(app.hasRoute({ method: 'POST', url: '/v1/controlled-shipment-digest' }), false, 'approval runtime must not register preview digest');
  const normalMutation = await app.inject({ method: 'POST', url: '/v1/shipments', payload: shipment });
  assert.equal(normalMutation.statusCode, 423, 'approval runtime must lock normal mutations');

  const changed = structuredClone(shipment);
  changed.declaredValueClp = 40001;
  const mismatch = await app.inject({ method: 'POST', url: '/v1/controlled-shipments', headers: approvalHeader(secret), payload: changed });
  assert.equal(mismatch.statusCode, 403);
  assert.equal(adapter.createCalls, 0);

  const created = await app.inject({ method: 'POST', url: '/v1/controlled-shipments', headers: approvalHeader(secret), payload: shipment });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(adapter.createCalls, 1);
  assert.equal(adapter.lastConnection?.id, connection.id);
  assert.equal(adapter.lastConnection?.enabled, false);

  const again = await app.inject({ method: 'POST', url: '/v1/controlled-shipments', headers: approvalHeader(secret), payload: shipment });
  assert.equal(again.statusCode, 201, again.body);
  assert.equal(adapter.createCalls, 1, 'completed controlled approval must never call provider twice');
  assert.equal(again.json().id, created.json().id);
  const audit = store.listAudit(shipment.tenantId, 10);
  assert.equal(audit[0]?.action, 'shipment.create.controlled');
  assert.equal(audit[0]?.metadata.approvalId, approval.approvalId);
  assert.ok(!JSON.stringify(audit).includes(secret), 'approval secret must never enter audit storage');
  await app.close();
});

test('controlled shipment rejects enabled carriers instead of becoming a second normal write path', async () => {
  const { store, adapter, adapters, connection, shipment, secret, approval, baseConfig } = fixture();
  store.close();
  const fresh = new SqliteStore(':memory:');
  fresh.createTenant({ id: shipment.tenantId, name: 'Controlled Fixture', createdAt: nowIso() });
  fresh.createCarrierConnection({ ...connection, enabled: true });
  const app = buildServer({ store: fresh, adapters, config: { ...baseConfig, controlledShipmentApproval: approval } });
  const response = await app.inject({ method: 'POST', url: '/v1/controlled-shipments', headers: approvalHeader(secret), payload: shipment });
  assert.equal(response.statusCode, 409);
  assert.equal(adapter.createCalls, 0);
  await app.close();
});

test('controlled approval is tenant/provider scoped before adapter I/O', async () => {
  const { store, adapter, adapters, shipment, secret, approval, baseConfig } = fixture();
  const wrongScope = { ...approval, tenantId: 'other-tenant' };
  const app = buildServer({ store, adapters, config: { ...baseConfig, controlledShipmentApproval: wrongScope } });
  const response = await app.inject({ method: 'POST', url: '/v1/controlled-shipments', headers: approvalHeader(secret), payload: shipment });
  assert.equal(response.statusCode, 403);
  assert.equal(adapter.createCalls, 0);
  await app.close();
});

test('controlled shipment approval expires fail-closed before adapter I/O', async () => {
  const { store, adapter, adapters, shipment, secret, approval, baseConfig } = fixture();
  const expired = { ...approval, issuedAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() };
  const app = buildServer({ store, adapters, config: { ...baseConfig, controlledShipmentApproval: expired } });
  const response = await app.inject({ method: 'POST', url: '/v1/controlled-shipments', headers: approvalHeader(secret), payload: shipment });
  assert.equal(response.statusCode, 403);
  assert.equal(adapter.createCalls, 0);
  await app.close();
});

test('concurrent controlled create calls allow at most one provider attempt', async () => {
  const { store, adapter, adapters, shipment, secret, approval, baseConfig } = fixture();
  adapter.createDelayMs = 40;
  const app = buildServer({ store, adapters, config: { ...baseConfig, controlledShipmentApproval: approval } });
  const request = () => app.inject({ method: 'POST', url: '/v1/controlled-shipments', headers: approvalHeader(secret), payload: shipment });
  const [a, b] = await Promise.all([request(), request()]);
  assert.deepEqual([a.statusCode, b.statusCode].sort((x, y) => x - y), [201, 409]);
  assert.equal(adapter.createCalls, 1);
  await app.close();
});


test('normal shipment creation also uses atomic idempotency claim under concurrency', async () => {
  const { store, adapter, adapters, connection, shipment, baseConfig } = fixture();
  store.close();
  const fresh = new SqliteStore(':memory:');
  fresh.createTenant({ id: shipment.tenantId, name: 'Normal Concurrency Fixture', createdAt: nowIso() });
  fresh.createCarrierConnection({ ...connection, enabled: true });
  adapter.createDelayMs = 40;
  const app = buildServer({ store: fresh, adapters, config: baseConfig });
  const request = () => app.inject({ method: 'POST', url: '/v1/shipments', payload: shipment });
  const [a, b] = await Promise.all([request(), request()]);
  assert.deepEqual([a.statusCode, b.statusCode].sort((x, y) => x - y), [201, 409]);
  assert.equal(adapter.createCalls, 1);
  await app.close();
});


test('shipment idempotency key rejects a different normalized payload after completion', async () => {
  const { store, adapter, adapters, connection, shipment, baseConfig } = fixture();
  store.close();
  const fresh = new SqliteStore(':memory:');
  fresh.createTenant({ id: shipment.tenantId, name: 'Idempotency Fingerprint Fixture', createdAt: nowIso() });
  fresh.createCarrierConnection({ ...connection, enabled: true });
  const app = buildServer({ store: fresh, adapters, config: baseConfig });
  const first = await app.inject({ method: 'POST', url: '/v1/shipments', payload: shipment });
  assert.equal(first.statusCode, 201, first.body);
  const changed = structuredClone(shipment);
  changed.declaredValueClp = 99999;
  const second = await app.inject({ method: 'POST', url: '/v1/shipments', payload: changed });
  assert.equal(second.statusCode, 409);
  assert.equal(adapter.createCalls, 1);
  await app.close();
});

test('controlled approval TTL cannot exceed sixty minutes', () => {
  const { store, adapters, approval, baseConfig } = fixture();
  const tooLong = {
    ...approval,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 61 * 60_000).toISOString(),
  };
  assert.throws(
    () => buildServer({ store, adapters, config: { ...baseConfig, controlledShipmentApproval: tooLong } }),
    /TTL must not exceed 60 minutes/i,
  );
  store.close();
});
