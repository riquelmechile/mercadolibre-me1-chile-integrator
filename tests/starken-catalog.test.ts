import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import {
  NotFoundError,
  newId,
  nowIso,
  type CarrierCapability,
  type CarrierConnection,
  type PackageSpec,
  type ProviderShipmentResult,
  type QuoteInput,
  type QuoteResult,
  type ShipmentCreateInput,
} from '../src/domain.js';
import type { CourierAdapter, SecretProvider } from '../src/ports.js';
import { SqliteStore } from '../src/store.js';
import { CarrierRoutingResolver, StarkenCatalogSyncService } from '../src/starken-catalog.js';
import { AdapterRegistry, MockCourierAdapter } from '../src/adapters.js';
import { PackagingResolver, AutomaticShippingService } from '../src/packaging.js';
import { LogisticsService } from '../src/services.js';
import { buildServer } from '../src/server.js';

class CountingSecretProvider implements SecretProvider {
  calls = 0;
  async resolve(_reference: string): Promise<string> {
    this.calls += 1;
    return 'fixture-token';
  }
}

class CapturingStarkenAdapter implements CourierAdapter {
  readonly provider = 'starken' as const;
  readonly caps = new Set<CarrierCapability>(['quote', 'create_shipment']);
  lastCreateInput: ShipmentCreateInput | null = null;
  capabilities(): ReadonlySet<CarrierCapability> { return this.caps; }
  async quote(_input: QuoteInput): Promise<QuoteResult> { throw new Error('snapshot should be used'); }
  async createShipment(input: ShipmentCreateInput): Promise<ProviderShipmentResult> {
    this.lastCreateInput = input;
    return { providerShipmentRef: `fixture-${input.externalOrderId}`, trackingNumber: null, status: 'created', metadata: { fixture: true } };
  }
}

async function withCatalogServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}/externo/integracion`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const rm = { id: 13, code_dls: 13, name: 'Región Metropolitana de Santiago', retiro_habilitado: true };
const maule = { id: 7, code_dls: 7, name: 'Región del Maule', retiro_habilitado: true };
const santiagoCity = { id: 1, code_dls: 1, name: 'SANTIAGO', region: rm, destino_indirecto: false, retiro_habilitado: true };
const talcaCity = { id: 91, code_dls: 91, name: 'TALCA', region: maule, destino_indirecto: false, retiro_habilitado: true };
const santiagoCommune = { id: 100, code_dls: 3126, name: 'SANTIAGO', city: { id: 1, code_dls: 1, name: 'SANTIAGO' }, retiro_habilitado: true };
const talcaCommune = { id: 200, code_dls: 3001, name: 'TALCA', city: { id: 91, code_dls: 91, name: 'TALCA' }, retiro_habilitado: true };

const baseRegions = [
  { ...rm, cities: [] },
  { ...maule, cities: [] },
];
const baseCities = [
  { ...santiagoCity, comunas: [] },
  { ...talcaCity, comunas: [] },
];
const baseCommunes = [
  { ...santiagoCommune, agencies: [] },
  { ...talcaCommune, agencies: [] },
];
const baseAgencies = [
  {
    id: 500,
    code_dls: 2001,
    name: 'TALCA CENTRO',
    comuna: { ...talcaCommune },
    address: 'Uno Sur 1000',
    latitude: '-35.4264',
    longitude: '-71.6554',
    status: 'ACTIVE',
    shipping: true,
    delivery: true,
    largo_max_agencia: 160,
    ancho_max_agencia: 80,
    alto_max_agencia: 80,
    valor_max_agencia: 1000000,
    weight_restriction: 'MT',
  },
  {
    id: 501,
    code_dls: 2002,
    name: 'TALCA NORTE',
    comuna: { ...talcaCommune },
    address: 'Norte 200',
    latitude: '-35.4000',
    longitude: '-71.6500',
    status: 'ACTIVE',
    shipping: true,
    delivery: true,
    largo_max_agencia: 0,
    ancho_max_agencia: 0,
    alto_max_agencia: 0,
    valor_max_agencia: 0,
    weight_restriction: 'MT',
  },
];

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function fixtureHandler(overrides: Partial<Record<string, unknown>> = {}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    const path = req.url ?? '';
    const bodies: Record<string, unknown> = {
      '/externo/integracion/agency/region': baseRegions,
      '/externo/integracion/agency/city': baseCities,
      '/externo/integracion/agency/comuna': baseCommunes,
      '/externo/integracion/agency/agency': baseAgencies,
      ...overrides,
    };
    if (!(path in bodies)) return sendJson(res, { error: 'not found' }, 404);
    sendJson(res, bodies[path]);
  };
}

function setup(baseUrl: string) {
  const store = new SqliteStore(':memory:');
  const tenant = store.createTenant({ id: newId(), name: 'ExampleCo', createdAt: nowIso() });
  const connection: CarrierConnection = store.createCarrierConnection({
    id: newId(),
    tenantId: tenant.id,
    provider: 'starken',
    credentialRef: 'starken/example',
    enabled: true,
    config: {
      protocol: 'starken-plugin-gateway-v1',
      capabilities: ['quote', 'create_shipment', 'tracking'],
      testBaseUrl: baseUrl,
    },
    createdAt: nowIso(),
  });
  const secrets = new CountingSecretProvider();
  return { store, tenant, connection, secrets };
}

const smallPackage: PackageSpec = { weightKg: 2, lengthCm: 100, widthCm: 40, heightCm: 30 };

test('Starken catalog sync normalizes all four catalogs and produces a deterministic active version', async () => {
  await withCatalogServer(fixtureHandler(), async (baseUrl) => {
    const { store, tenant, connection, secrets } = setup(baseUrl);
    const sync = new StarkenCatalogSyncService(store, secrets);
    const first = await sync.sync(connection);
    const second = await sync.sync(connection);
    assert.equal(first.version, second.version);
    assert.equal(first.regions.length, 2);
    assert.equal(first.cities.length, 2);
    assert.equal(first.communes.length, 2);
    assert.equal(first.agencies.length, 2);
    assert.equal(first.agencies[0]?.maxLengthCm, 160);
    assert.equal(first.agencies[1]?.maxLengthCm, undefined);
    assert.equal(first.agencies[0]?.weightRestriction, 'MT');
    assert.equal(store.getActiveCarrierLocationCatalog(tenant.id, 'starken')?.version, first.version);
    assert.equal(secrets.calls, 2);
    store.close();
  });
});

test('catalog sync fails closed and preserves the previous active snapshot when a required provider catalog is empty', async () => {
  await withCatalogServer(fixtureHandler(), async (baseUrl) => {
    const { store, tenant, connection, secrets } = setup(baseUrl);
    const sync = new StarkenCatalogSyncService(store, secrets);
    const first = await sync.sync(connection);
    store.close();

    await withCatalogServer(fixtureHandler({ '/externo/integracion/agency/comuna': [] }), async (brokenBase) => {
      const store2 = new SqliteStore(':memory:');
      const tenant2 = store2.createTenant({ id: tenant.id, name: 'ExampleCo', createdAt: nowIso() });
      store2.createCarrierConnection({ ...connection, tenantId: tenant2.id, config: { ...connection.config, testBaseUrl: brokenBase } });
      const existing = { ...first, tenantId: tenant2.id, id: newId(), active: true };
      store2.createCarrierLocationCatalog(existing);
      const sync2 = new StarkenCatalogSyncService(store2, secrets);
      await assert.rejects(() => sync2.sync(store2.getCarrierConnection(tenant2.id, 'starken')!), /commune catalog/i);
      assert.equal(store2.getActiveCarrierLocationCatalog(tenant2.id, 'starken')?.version, existing.version);
      store2.close();
    });
  });
});

test('routing resolves commune case/diacritics to city+commune DLS without provider network access', async () => {
  await withCatalogServer(fixtureHandler(), async (baseUrl) => {
    const { store, tenant, connection, secrets } = setup(baseUrl);
    const snapshot = await new StarkenCatalogSyncService(store, secrets).sync(connection);
    const callsAfterSync = secrets.calls;
    const resolver = new CarrierRoutingResolver(store);
    const resolved = resolver.resolve({
      tenantId: tenant.id,
      provider: 'starken',
      address: { region: 'region del maule', commune: 'Tálca', street: 'Uno Sur', number: '1' },
      deliveryMode: 'home',
    });
    assert.equal(resolved.catalogVersion, snapshot.version);
    assert.equal(resolved.address.providerCityCode, '91');
    assert.equal(resolved.address.providerCommuneCode, '3001');
    assert.equal(secrets.calls, callsAfterSync);
    store.close();
  });
});

test('agency routing requires an explicit unique agency when more than one eligible branch exists', async () => {
  await withCatalogServer(fixtureHandler(), async (baseUrl) => {
    const { store, tenant, connection, secrets } = setup(baseUrl);
    await new StarkenCatalogSyncService(store, secrets).sync(connection);
    const resolver = new CarrierRoutingResolver(store);
    assert.throws(() => resolver.resolve({
      tenantId: tenant.id,
      provider: 'starken',
      address: { region: 'Maule', commune: 'Talca' },
      deliveryMode: 'agency',
      package: smallPackage,
      declaredValueClp: 100000,
    }), /ambiguous agency/i);
    const resolved = resolver.resolve({
      tenantId: tenant.id,
      provider: 'starken',
      address: { region: 'Maule', commune: 'Talca' },
      deliveryMode: 'agency',
      agencyName: 'Talca Centro',
      package: smallPackage,
      declaredValueClp: 100000,
    });
    assert.equal(resolved.address.providerAgencyCode, '2001');
    assert.equal(resolved.address.providerLocationId, '2001');
    store.close();
  });
});

test('agency limits reject oversized packages/value while zero limits mean unspecified rather than zero capacity', async () => {
  await withCatalogServer(fixtureHandler(), async (baseUrl) => {
    const { store, tenant, connection, secrets } = setup(baseUrl);
    await new StarkenCatalogSyncService(store, secrets).sync(connection);
    const resolver = new CarrierRoutingResolver(store);
    assert.throws(() => resolver.resolve({
      tenantId: tenant.id,
      provider: 'starken',
      address: { region: 'Maule', commune: 'Talca' },
      deliveryMode: 'agency',
      agencyName: 'Talca Centro',
      package: { ...smallPackage, lengthCm: 200 },
      declaredValueClp: 100000,
    }), /agency package limit/i);
    assert.throws(() => resolver.resolve({
      tenantId: tenant.id,
      provider: 'starken',
      address: { region: 'Maule', commune: 'Talca' },
      deliveryMode: 'agency',
      agencyName: 'Talca Centro',
      package: smallPackage,
      declaredValueClp: 2000000,
    }), /declared value/i);
    const unrestricted = resolver.resolve({
      tenantId: tenant.id,
      provider: 'starken',
      address: { region: 'Maule', commune: 'Talca' },
      deliveryMode: 'agency',
      agencyName: 'Talca Norte',
      package: { weightKg: 50, lengthCm: 500, widthCm: 300, heightCm: 250 },
      declaredValueClp: 9999999,
    });
    assert.equal(unrestricted.address.providerAgencyCode, '2002');
    store.close();
  });
});


test('HTTP control-plane syncs catalog explicitly and resolves routing from the active local snapshot', async () => {
  await withCatalogServer(fixtureHandler(), async (baseUrl) => {
    const { store, tenant, secrets } = setup(baseUrl);
    const app = buildServer({
      store,
      adapters: new AdapterRegistry([new MockCourierAdapter()]),
      secrets,
      config: { host: '127.0.0.1', port: 0, sqlitePath: ':memory:', logLevel: 'silent', me1Certified: false, enableDevRoutes: true, meliApiBaseUrl: 'https://api.mercadolibre.com' },
    });
    const synced = await app.inject({ method: 'POST', url: `/v1/tenants/${tenant.id}/carriers/starken/catalog/sync` });
    assert.equal(synced.statusCode, 201);
    assert.deepEqual(synced.json().counts, { regions: 2, cities: 2, communes: 2, agencies: 2 });
    const summary = await app.inject({ method: 'GET', url: `/v1/tenants/${tenant.id}/carriers/starken/catalog` });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().version, synced.json().version);
    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenant.id}/carriers/starken/routing/resolve`,
      payload: {
        address: { region: 'Maule', commune: 'Tálca' },
        deliveryMode: 'agency',
        agencyName: 'Talca Centro',
        package: smallPackage,
        declaredValueClp: 100000,
      },
    });
    assert.equal(resolved.statusCode, 200);
    assert.equal(resolved.json().address.providerCityCode, '91');
    assert.equal(resolved.json().address.providerCommuneCode, '3001');
    assert.equal(resolved.json().address.providerAgencyCode, '2001');
    await app.close();
  });
});

test('automatic shipping routeWithCatalog fails closed when the selected provider has no active routing catalog', async () => {
  const store = new SqliteStore(':memory:');
  const tenant = store.createTenant({ id: newId(), name: 'No catalog tenant', createdAt: nowIso() });
  store.createSellerConnection({ id: newId(), tenantId: tenant.id, marketplace: 'mercadolibre', sellerId: 'seller-no-catalog', credentialRef: 'meli/example', enabled: true, config: {}, createdAt: nowIso() });
  store.createCarrierConnection({ id: newId(), tenantId: tenant.id, provider: 'starken', credentialRef: 'starken/example', enabled: true, config: {}, createdAt: nowIso() });
  store.createPackagingProfile({ id: newId(), tenantId: tenant.id, name: 'Fixture product', matchType: 'sku', matchValue: 'SKU-NO-CATALOG', priority: 1, active: true, package: smallPackage, packingMode: 'fixed', maxQuantity: 1, metadata: {}, createdAt: nowIso() });
  store.createTariffSnapshot({ id: newId(), tenantId: tenant.id, provider: 'starken', version: 'snapshot-no-catalog', active: true, createdAt: nowIso(), rules: [{ id: newId(), serviceCode: 'NORMAL', serviceName: 'Normal', currency: 'CLP', amount: 5000, minWeightKg: 0, maxWeightKg: 100, estimatedBusinessDays: 2, deliveryMode: 'home', paymentMode: 'recipient_pay' }] });
  const automatic = new AutomaticShippingService(store, new LogisticsService(store, new AdapterRegistry([new CapturingStarkenAdapter()])), new PackagingResolver(store), new CarrierRoutingResolver(store));
  await assert.rejects(() => automatic.create({
    tenantId: tenant.id, sellerId: 'seller-no-catalog', externalOrderId: 'ORDER-NO-CATALOG',
    origin: { region: 'Metropolitana de Santiago', commune: 'Santiago' },
    destination: { region: 'Maule', commune: 'Talca' },
    items: [{ sku: 'SKU-NO-CATALOG', quantity: 1 }], preferredProvider: 'starken', deliveryPreference: 'home', paymentMode: 'recipient_pay',
    routeWithCatalog: true, idempotencyKey: 'ORDER-NO-CATALOG',
  }), (error: unknown) => error instanceof NotFoundError && /No eligible carrier quote/i.test(error.message) && JSON.stringify(error.details ?? {}).includes('No active carrier location catalog'));
  store.close();
});

test('automatic shipping routeWithCatalog enriches routing locally while pricing remains snapshot-first', async () => {
  await withCatalogServer(fixtureHandler(), async (baseUrl) => {
    const { store, tenant, connection, secrets } = setup(baseUrl);
    const snapshot = await new StarkenCatalogSyncService(store, secrets).sync(connection);
    const secretCallsAfterSync = secrets.calls;
    store.createSellerConnection({ id: newId(), tenantId: tenant.id, marketplace: 'mercadolibre', sellerId: 'seller-route', credentialRef: 'meli/example', enabled: true, config: {}, createdAt: nowIso() });
    store.createPackagingProfile({
      id: newId(), tenantId: tenant.id, name: 'Fixture product', matchType: 'sku', matchValue: 'SKU-ROUTE-001', priority: 1, active: true,
      package: smallPackage, packingMode: 'fixed', maxQuantity: 1, metadata: {}, createdAt: nowIso(),
    });
    store.createTariffSnapshot({
      id: newId(), tenantId: tenant.id, provider: 'starken', version: 'snapshot-v1', active: true, createdAt: nowIso(),
      rules: [{ id: newId(), serviceCode: 'NORMAL', serviceName: 'Normal', currency: 'CLP', amount: 5000, minWeightKg: 0, maxWeightKg: 100, estimatedBusinessDays: 2, deliveryMode: 'home', paymentMode: 'recipient_pay' }],
    });
    const capturing = new CapturingStarkenAdapter();
    const adapters = new AdapterRegistry([capturing]);
    const logistics = new LogisticsService(store, adapters);
    const automatic = new AutomaticShippingService(store, logistics, new PackagingResolver(store), new CarrierRoutingResolver(store));
    const result = await automatic.create({
      tenantId: tenant.id,
      sellerId: 'seller-route',
      externalOrderId: 'ORDER-ROUTE-1',
      origin: { region: 'Metropolitana de Santiago', commune: 'Santiago', providerAgencyCode: '1411' },
      destination: { region: 'Maule', commune: 'Tálca', street: 'Uno Sur', number: '100' },
      items: [{ sku: 'SKU-ROUTE-001', quantity: 1 }],
      preferredProvider: 'starken',
      deliveryPreference: 'home',
      paymentMode: 'recipient_pay',
      declaredValueClp: 100000,
      routeWithCatalog: true,
      idempotencyKey: 'ORDER-ROUTE-1',
    });
    assert.equal(result.quote.source, 'snapshot');
    assert.equal(capturing.lastCreateInput?.origin.providerCityCode, '1');
    assert.equal(capturing.lastCreateInput?.origin.providerAgencyCode, '1411');
    assert.equal(capturing.lastCreateInput?.destination.providerCityCode, '91');
    assert.equal(capturing.lastCreateInput?.destination.providerCommuneCode, '3001');
    assert.equal(capturing.lastCreateInput?.destination.providerAgencyCode, undefined);
    assert.equal((result.shipment.metadata.automaticShipping as { routingCatalogVersion?: string }).routingCatalogVersion, snapshot.version);
    assert.equal(secrets.calls, secretCallsAfterSync);
    store.close();
  });
});
