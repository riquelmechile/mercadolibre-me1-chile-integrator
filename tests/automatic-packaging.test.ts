import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { AdapterRegistry, MockCourierAdapter } from '../src/adapters.js';
import { newId, nowIso, type CarrierCapability, type CarrierConnection, type ProviderShipmentResult, type QuoteInput, type QuoteResult, type ShipmentCreateInput } from '../src/domain.js';
import { AutomaticShippingService, PackagingResolver } from '../src/packaging.js';
import type { CourierAdapter } from '../src/ports.js';
import { LogisticsService } from '../src/services.js';
import { SqliteStore } from '../src/store.js';
import { buildServer } from '../src/server.js';

const origin = { region: 'Metropolitana', commune: 'Santiago' };
const destination = { region: 'Metropolitana', commune: 'Providencia' };

class TestStarkenAdapter implements CourierAdapter {
  readonly provider = 'starken' as const;
  private readonly caps = new Set<CarrierCapability>(['quote', 'create_shipment']);
  lastCreateInput: ShipmentCreateInput | null = null;
  capabilities(_connection: CarrierConnection): ReadonlySet<CarrierCapability> { return this.caps; }
  async quote(_input: QuoteInput): Promise<QuoteResult> { throw new Error('snapshot should be used'); }
  async createShipment(input: ShipmentCreateInput): Promise<ProviderShipmentResult> {
    this.lastCreateInput = input;
    return { providerShipmentRef: `starken-test-${input.externalOrderId}`, trackingNumber: 'STKTEST1', status: 'label_ready', metadata: { testAdapter: true } };
  }
}

function setup() {
  const store = new SqliteStore(':memory:');
  const starkenAdapter = new TestStarkenAdapter();
  const adapters = new AdapterRegistry([new MockCourierAdapter(), starkenAdapter]);
  const logistics = new LogisticsService(store, adapters);
  const packaging = new PackagingResolver(store);
  const automatic = new AutomaticShippingService(store, logistics, packaging);
  const tenant = store.createTenant({ id: newId(), name: 'ExampleCo', createdAt: nowIso() });
  store.createSellerConnection({ id: newId(), tenantId: tenant.id, marketplace: 'mercadolibre', sellerId: 'seller-1', credentialRef: 'meli/exampleco', enabled: true, config: {}, createdAt: nowIso() });
  return { store, adapters, logistics, packaging, automatic, tenant, starkenAdapter };
}

function profile(store: SqliteStore, tenantId: string, values: Partial<Parameters<SqliteStore['createPackagingProfile']>[0]> & { name: string }) {
  return store.createPackagingProfile({
    id: newId(), tenantId, name: values.name,
    matchType: values.matchType ?? 'default', matchValue: values.matchValue ?? null,
    priority: values.priority ?? 0, active: values.active ?? true,
    package: values.package ?? { weightKg: 1, lengthCm: 30, widthCm: 20, heightCm: 10 },
    packingMode: values.packingMode ?? 'fixed', maxQuantity: values.maxQuantity ?? 1,
    metadata: values.metadata ?? {}, createdAt: nowIso(),
  });
}

function snapshot(store: SqliteStore, tenantId: string, provider: 'mock' | 'starken', amount: number) {
  store.createTariffSnapshot({
    id: newId(), tenantId, provider, version: `${provider}-v1`, active: true, createdAt: nowIso(),
    rules: [{ id: newId(), serviceCode: `${provider.toUpperCase()}_STD`, serviceName: `${provider} standard`, currency: 'CLP', amount, minWeightKg: 0, maxWeightKg: 100, estimatedBusinessDays: provider === 'starken' ? 2 : 1 }],
  });
}

test('packaging resolver prefers SKU over family/default and applies quantity strategy', () => {
  const { store, packaging, tenant } = setup();
  profile(store, tenant.id, { name: 'Default huge priority', matchType: 'default', priority: 999, package: { weightKg: 9, lengthCm: 90, widthCm: 90, heightCm: 90 } });
  profile(store, tenant.id, { name: 'Flexible family', matchType: 'family', matchValue: 'flex', priority: 100, package: { weightKg: 3, lengthCm: 60, widthCm: 40, heightCm: 15 }, packingMode: 'scale_weight_only', maxQuantity: 5 });
  const sku = profile(store, tenant.id, { name: 'Flexible 100 exact', matchType: 'sku', matchValue: 'FLEX-100', priority: 0, package: { weightKg: 2, lengthCm: 50, widthCm: 30, heightCm: 10 }, packingMode: 'stack_height', maxQuantity: 3 });

  const result = packaging.resolve(tenant.id, [{ sku: 'FLEX-100', family: 'FLEX', quantity: 2 }]);
  assert.deepEqual(result.profileIds, [sku.id]);
  assert.deepEqual(result.package, { weightKg: 4, lengthCm: 50, widthCm: 30, heightCm: 20 });
  store.close();
});

test('multi-line consolidation is conservative and missing profile fails before side effects', async () => {
  const { store, packaging, automatic, tenant } = setup();
  store.createCarrierConnection({ id: newId(), tenantId: tenant.id, provider: 'mock', credentialRef: null, enabled: true, config: {}, createdAt: nowIso() });
  snapshot(store, tenant.id, 'mock', 5000);
  profile(store, tenant.id, { name: 'SKU A', matchType: 'sku', matchValue: 'A', package: { weightKg: 2, lengthCm: 50, widthCm: 20, heightCm: 10 } });
  profile(store, tenant.id, { name: 'SKU B', matchType: 'sku', matchValue: 'B', package: { weightKg: 1, lengthCm: 30, widthCm: 40, heightCm: 5 } });
  assert.deepEqual(packaging.resolve(tenant.id, [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }]).package, { weightKg: 3, lengthCm: 50, widthCm: 40, heightCm: 15 });

  await assert.rejects(() => automatic.create({ tenantId: tenant.id, sellerId: 'seller-1', externalOrderId: 'ORDER-MISSING', origin, destination, items: [{ sku: 'NO-PROFILE', quantity: 1 }], idempotencyKey: 'missing' }), /No packaging profile matches/);
  assert.equal(store.getIdempotency(tenant.id, 'shipment:create:automatic:missing'), null);
  store.close();
});

test('automatic shipment selects cheapest snapshot carrier and is idempotent', async () => {
  const { store, automatic, tenant } = setup();
  for (const provider of ['mock', 'starken'] as const) store.createCarrierConnection({ id: newId(), tenantId: tenant.id, provider, credentialRef: provider === 'starken' ? 'starken/ref' : null, enabled: true, config: {}, createdAt: nowIso() });
  snapshot(store, tenant.id, 'mock', 5900);
  snapshot(store, tenant.id, 'starken', 4200);
  const p = profile(store, tenant.id, { name: 'Flexible 100', matchType: 'sku', matchValue: 'FLEX-100', package: { weightKg: 4, lengthCm: 60, widthCm: 40, heightCm: 20 } });
  const request = { tenantId: tenant.id, sellerId: 'seller-1', externalOrderId: 'MLC-100', marketplaceShipmentId: 'SHIP-100', origin, destination, items: [{ sku: 'FLEX-100', quantity: 1 }], idempotencyKey: 'MLC-100' };
  const first = await automatic.create(request);
  const second = await automatic.create(request);
  assert.equal(first.shipment.provider, 'starken');
  assert.equal(first.quote.amount, 4200);
  assert.equal(first.shipment.id, second.shipment.id);
  assert.deepEqual(first.packaging.profileIds, [p.id]);
  assert.equal((first.shipment.metadata.automaticShipping as { packagingProfileIds: string[] }).packagingProfileIds[0], p.id);
  store.close();
});

test('preferred provider overrides cheaper carrier and quantity overflow fails closed', async () => {
  const { store, automatic, tenant } = setup();
  for (const provider of ['mock', 'starken'] as const) store.createCarrierConnection({ id: newId(), tenantId: tenant.id, provider, credentialRef: provider === 'starken' ? 'starken/ref' : null, enabled: true, config: {}, createdAt: nowIso() });
  snapshot(store, tenant.id, 'mock', 5900);
  snapshot(store, tenant.id, 'starken', 4200);
  profile(store, tenant.id, { name: 'Flexible 200', matchType: 'sku', matchValue: 'FLEX-200', package: { weightKg: 2, lengthCm: 50, widthCm: 40, heightCm: 10 }, packingMode: 'stack_height', maxQuantity: 2 });
  const chosen = await automatic.create({ tenantId: tenant.id, sellerId: 'seller-1', externalOrderId: 'MLC-101', origin, destination, items: [{ sku: 'FLEX-200', quantity: 1 }], preferredProvider: 'mock', idempotencyKey: 'MLC-101' });
  assert.equal(chosen.shipment.provider, 'mock');
  await assert.rejects(() => automatic.create({ tenantId: tenant.id, sellerId: 'seller-1', externalOrderId: 'MLC-102', origin, destination, items: [{ sku: 'FLEX-200', quantity: 3 }], idempotencyKey: 'MLC-102' }), /does not cover this quantity/);
  assert.equal(store.getIdempotency(tenant.id, 'shipment:create:automatic:MLC-102'), null);
  store.close();
});

test('HTTP bulk dimension list feeds automatic shipment without package in request', async () => {
  const { store, adapters } = setup();
  const app = buildServer({ store, adapters, config: { host: '127.0.0.1', port: 0, sqlitePath: ':memory:', logLevel: 'silent', me1Certified: false, enableDevRoutes: true, meliApiBaseUrl: 'https://api.mercadolibre.com' } });
  const tenantResponse = await app.inject({ method: 'POST', url: '/v1/tenants', payload: { name: 'HTTP auto' } });
  const tenant = tenantResponse.json() as { id: string };
  await app.inject({ method: 'POST', url: `/v1/tenants/${tenant.id}/sellers`, payload: { marketplace: 'mercadolibre', sellerId: 'seller-http', credentialRef: 'meli/http' } });
  await app.inject({ method: 'POST', url: `/v1/tenants/${tenant.id}/carriers`, payload: { provider: 'mock', config: {} } });
  await app.inject({ method: 'POST', url: `/v1/tenants/${tenant.id}/tariff-snapshots`, payload: { provider: 'mock', version: 'v1', rules: [{ serviceCode: 'STD', serviceName: 'Standard', currency: 'CLP', amount: 4990, minWeightKg: 0, maxWeightKg: 100, estimatedBusinessDays: 2 }] } });
  const imported = await app.inject({ method: 'POST', url: `/v1/tenants/${tenant.id}/packaging-profiles/import`, payload: { profiles: [{ name: 'Flexible 300', matchType: 'sku', matchValue: 'FLEX-300', priority: 10, packingMode: 'stack_height', maxQuantity: 4, package: { weightKg: 3, lengthCm: 65, widthCm: 45, heightCm: 12 } }] } });
  assert.equal(imported.statusCode, 201);
  const response = await app.inject({ method: 'POST', url: '/v1/automatic-shipments', payload: { tenantId: tenant.id, sellerId: 'seller-http', externalOrderId: 'MLC-HTTP', origin, destination, items: [{ sku: 'FLEX-300', quantity: 2 }], idempotencyKey: 'MLC-HTTP' } });
  assert.equal(response.statusCode, 201);
  const body = response.json() as { packaging: { package: { weightKg: number; heightCm: number } }; shipment: { provider: string } };
  assert.equal(body.shipment.provider, 'mock');
  assert.equal(body.packaging.package.weightKg, 6);
  assert.equal(body.packaging.package.heightCm, 24);
  await app.close();
});


test('generic threshold_growth examples resolve deterministic fictional dimensions', async () => {
  const { store, adapters } = setup();
  const app = buildServer({ store, adapters, config: { host: '127.0.0.1', port: 0, sqlitePath: ':memory:', logLevel: 'silent', me1Certified: false, enableDevRoutes: true, meliApiBaseUrl: 'https://api.mercadolibre.com' } });
  const tenantResponse = await app.inject({ method: 'POST', url: '/v1/tenants', payload: { name: 'ExampleCo table' } });
  const tenant = tenantResponse.json() as { id: string };
  const payload = JSON.parse(readFileSync(new URL('../examples/packaging-profiles.example.json', import.meta.url), 'utf8')) as { profiles: Record<string, unknown>[] };
  const imported = await app.inject({ method: 'POST', url: `/v1/tenants/${tenant.id}/packaging-profiles/import`, payload });
  assert.equal(imported.statusCode, 201);
  const resolver = new PackagingResolver(store);
  const cases = [
    { sku: 'FLEX-100', q: 1, expected: { weightKg: 1.25, lengthCm: 90, widthCm: 12, heightCm: 8 } },
    { sku: 'FLEX-100', q: 2, expected: { weightKg: 2.5, lengthCm: 120, widthCm: 13, heightCm: 9 } },
    { sku: 'FLEX-100', q: 3, expected: { weightKg: 3.75, lengthCm: 120, widthCm: 13.4, heightCm: 9.2 } },
    { sku: 'FLEX-100', q: 5, expected: { weightKg: 6.25, lengthCm: 120, widthCm: 14.2, heightCm: 9.6 } },
    { sku: 'FLEX-200', q: 3, expected: { weightKg: 2.25, lengthCm: 95, widthCm: 16.5, heightCm: 9.5 } },
    { sku: 'FLEX-300', q: 3, expected: { weightKg: 6.3, lengthCm: 140, widthCm: 26.8, heightCm: 15.6 } },
  ];
  for (const item of cases) {
    assert.deepEqual(resolver.resolve(tenant.id, [{ sku: item.sku, quantity: item.q }]).package, item.expected, `${item.sku} x ${item.q}`);
  }
  await app.close();
});

test('threshold_growth validation fails closed when its rule is missing or invalid', async () => {
  const { store, adapters } = setup();
  const app = buildServer({ store, adapters, config: { host: '127.0.0.1', port: 0, sqlitePath: ':memory:', logLevel: 'silent', me1Certified: false, enableDevRoutes: true, meliApiBaseUrl: 'https://api.mercadolibre.com' } });
  const tenantResponse = await app.inject({ method: 'POST', url: '/v1/tenants', payload: { name: 'Validation' } });
  const tenant = tenantResponse.json() as { id: string };
  const missing = await app.inject({ method: 'POST', url: `/v1/tenants/${tenant.id}/packaging-profiles`, payload: { name: 'bad', matchType: 'sku', matchValue: 'BAD', packingMode: 'threshold_growth', maxQuantity: 10, package: { weightKg: 1, lengthCm: 1, widthCm: 1, heightCm: 1 } } });
  assert.equal(missing.statusCode, 400);
  const invalid = await app.inject({ method: 'POST', url: `/v1/tenants/${tenant.id}/packaging-profiles`, payload: { name: 'bad2', matchType: 'sku', matchValue: 'BAD2', packingMode: 'threshold_growth', maxQuantity: 10, package: { weightKg: 1, lengthCm: 1, widthCm: 1, heightCm: 1 }, quantityRule: { threshold: 1, fixedLengthCm: 10, baseWidthCm: 2, baseHeightCm: 2, widthIncrementCm: 1, heightIncrementCm: 1 } } });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});


test('automatic shipment preserves generic agency, payment and declared-value intent for provider creation', async () => {
  const { store, automatic, tenant, starkenAdapter } = setup();
  store.createCarrierConnection({ id: newId(), tenantId: tenant.id, provider: 'starken', credentialRef: 'starken/ref', enabled: true, config: {}, createdAt: nowIso() });
  snapshot(store, tenant.id, 'starken', 4200);
  profile(store, tenant.id, { name: 'Agency-ready product', matchType: 'sku', matchValue: 'AGENCY-1', package: { weightKg: 2, lengthCm: 40, widthCm: 20, heightCm: 10 } });

  await automatic.create({
    tenantId: tenant.id,
    sellerId: 'seller-1',
    externalOrderId: 'ORDER-AGENCY',
    origin,
    destination: { ...destination, providerLocationId: 'AGENCY-OPAQUE-123' },
    items: [{ sku: 'AGENCY-1', quantity: 1 }],
    preferredProvider: 'starken',
    deliveryPreference: 'agency',
    paymentMode: 'sender_prepaid',
    declaredValueClp: 45000,
    idempotencyKey: 'ORDER-AGENCY',
  });

  assert.equal(starkenAdapter.lastCreateInput?.deliveryMode, 'agency');
  assert.equal(starkenAdapter.lastCreateInput?.paymentMode, 'sender_prepaid');
  assert.equal(starkenAdapter.lastCreateInput?.declaredValueClp, 45000);
  assert.equal(starkenAdapter.lastCreateInput?.destination.providerLocationId, 'AGENCY-OPAQUE-123');
  store.close();
});
