import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { StarkenAdapter } from '../src/adapters.js';
import { IntegrationGatedError, type CarrierConnection, type Shipment } from '../src/domain.js';
import type { SecretProvider } from '../src/ports.js';

class CountingSecretProvider implements SecretProvider {
  calls = 0;
  constructor(private readonly value = 'test-secret') {}
  async resolve(_reference: string): Promise<string> {
    this.calls += 1;
    return this.value;
  }
}

const origin = { region: 'Metropolitana', commune: 'Santiago' };
const destination = { region: 'Valparaiso', commune: 'Vina del Mar' };
const packageSpec = { weightKg: 2.5, lengthCm: 40, widthCm: 20, heightCm: 10 };

function connection(config: Record<string, unknown>, credentialRef: string | null = 'starken/example'): CarrierConnection {
  return {
    id: 'conn-starken',
    tenantId: 'tenant-example',
    provider: 'starken',
    credentialRef,
    enabled: true,
    config,
    createdAt: new Date().toISOString(),
  };
}

async function withJsonServer(
  handler: (req: IncomingMessage, body: unknown, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body: unknown = null;
      if (raw) body = JSON.parse(raw);
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function contract(baseUrl: string) {
  return {
    capabilities: ['quote', 'create_shipment', 'tracking'],
    contract: {
      version: 'fixture-rest-v1',
      baseUrl,
      allowedHosts: ['127.0.0.1'],
      auth: { mode: 'bearer' },
      timeoutMs: 2000,
      statusMap: {
        CREATED: 'created',
        TRANSIT: 'in_transit',
        DELIVERED: 'delivered',
      },
      operations: {
        quote: {
          method: 'POST',
          path: '/quote',
          bodyTemplate: {
            origin: '{{origin.commune}}',
            destination: '{{destination.commune}}',
            weight: '{{package.weightKg}}',
          },
          response: {
            itemsPath: 'data.services',
            serviceCodePath: 'code',
            serviceNamePath: 'name',
            amountPath: 'price',
            estimatedBusinessDaysPath: 'days',
          },
        },
        createShipment: {
          method: 'POST',
          path: '/shipments',
          bodyTemplate: {
            order: '{{externalOrderId}}',
            service: '{{serviceCode}}',
            weight: '{{package.weightKg}}',
          },
          response: {
            providerShipmentRefPath: 'data.freightOrder',
            trackingNumberPath: 'data.tracking',
            labelUrlPath: 'data.labelUrl',
            statusCodePath: 'data.status',
          },
        },
        tracking: {
          method: 'POST',
          path: '/tracking',
          bodyTemplate: { tracking: '{{trackingNumber}}' },
          response: {
            eventsPath: 'data.events',
            providerEventIdPath: 'id',
            statusCodePath: 'status',
            occurredAtPath: 'occurredAt',
            locationPath: 'location',
            commentPath: 'comment',
          },
        },
      },
    },
  };
}

test('Starken stays fail-closed before a verified contract and does not resolve secrets', async () => {
  const secrets = new CountingSecretProvider();
  const adapter = new StarkenAdapter(secrets);
  await assert.rejects(
    () => adapter.quote({ tenantId: 'tenant-example', provider: 'starken', origin, destination, package: packageSpec, allowLive: true }, connection({ capabilities: ['quote'] })),
    IntegrationGatedError,
  );
  assert.equal(secrets.calls, 0);
});

test('Starken quote renders a safe normalized request and selects the cheapest valid CLP service', async () => {
  await withJsonServer((req, body, res) => {
    assert.equal(req.url, '/quote');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    assert.deepEqual(body, { origin: 'Santiago', destination: 'Vina del Mar', weight: 2.5 });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { services: [
      { code: 'EXP', name: 'Express', price: 8900, days: 1 },
      { code: 'STD', name: 'Standard', price: 5900, days: 3 },
    ] } }));
  }, async (baseUrl) => {
    const secrets = new CountingSecretProvider('fixture-token');
    const adapter = new StarkenAdapter(secrets);
    const quote = await adapter.quote(
      { tenantId: 'tenant-example', provider: 'starken', origin, destination, package: packageSpec, allowLive: true },
      connection(contract(baseUrl)),
    );
    assert.equal(quote.provider, 'starken');
    assert.equal(quote.serviceCode, 'STD');
    assert.equal(quote.amount, 5900);
    assert.equal(quote.estimatedBusinessDays, 3);
    assert.equal(quote.source, 'live');
    assert.equal(secrets.calls, 1);
  });
});

test('Starken create and tracking normalize provider responses through explicit mappings', async () => {
  let calls = 0;
  await withJsonServer((req, body, res) => {
    calls += 1;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/shipments') {
      assert.deepEqual(body, { order: 'ORDER-42', service: 'STD', weight: 2.5 });
      res.end(JSON.stringify({ data: { freightOrder: 'OF-42', tracking: 'STK-42', labelUrl: 'https://labels.example.invalid/42.pdf', status: 'CREATED' } }));
      return;
    }
    assert.equal(req.url, '/tracking');
    assert.deepEqual(body, { tracking: 'STK-42' });
    res.end(JSON.stringify({ data: { events: [
      { id: 'evt-1', status: 'TRANSIT', occurredAt: '2026-08-25T20:00:00.000Z', location: 'Hub', comment: 'moving' },
      { id: 'evt-2', status: 'DELIVERED', occurredAt: '2026-08-26T16:00:00.000Z', location: 'Destination' },
    ] } }));
  }, async (baseUrl) => {
    const adapter = new StarkenAdapter(new CountingSecretProvider('fixture-token'));
    const conn = connection(contract(baseUrl));
    const created = await adapter.createShipment({
      tenantId: 'tenant-example', provider: 'starken', externalOrderId: 'ORDER-42', origin, destination,
      package: packageSpec, serviceCode: 'STD', idempotencyKey: 'order-42',
    }, conn);
    assert.deepEqual(created, {
      providerShipmentRef: 'OF-42', trackingNumber: 'STK-42', status: 'created',
      labelUrl: 'https://labels.example.invalid/42.pdf', metadata: { contractVersion: 'fixture-rest-v1' },
    });
    const shipment: Shipment = {
      id: 'shipment-42', tenantId: 'tenant-example', provider: 'starken', externalOrderId: 'ORDER-42', marketplaceShipmentId: null,
      providerShipmentRef: 'OF-42', trackingNumber: 'STK-42', status: 'created', serviceCode: 'STD', idempotencyKey: 'order-42',
      metadata: {}, createdAt: '2026-08-25T19:00:00.000Z', updatedAt: '2026-08-25T19:00:00.000Z',
    };
    const events = await adapter.tracking!(shipment, conn);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.canonicalStatus, 'in_transit');
    assert.equal(events[1]?.canonicalStatus, 'delivered');
    assert.equal(events[1]?.final, true);
    assert.equal(calls, 2);
  });
});

test('Starken rejects unsafe transport and unknown tracking statuses instead of guessing', async () => {
  const unsafeSecrets = new CountingSecretProvider();
  const adapter = new StarkenAdapter(unsafeSecrets);
  await assert.rejects(
    () => adapter.quote({ tenantId: 'tenant-example', provider: 'starken', origin, destination, package: packageSpec, allowLive: true }, connection(contract('http://api.example.com'))),
    /HTTPS/,
  );
  assert.equal(unsafeSecrets.calls, 0);

  const mismatched = contract('https://api.example.com') as { contract: { allowedHosts: string[] } };
  mismatched.contract.allowedHosts = ['other.example.com'];
  await assert.rejects(
    () => adapter.quote({ tenantId: 'tenant-example', provider: 'starken', origin, destination, package: packageSpec, allowLive: true }, connection(mismatched as unknown as Record<string, unknown>)),
    /allowedHosts/,
  );
  assert.equal(unsafeSecrets.calls, 0);

  await withJsonServer((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { events: [{ id: 'evt-x', status: 'MYSTERY', occurredAt: '2026-08-25T20:00:00.000Z' }] } }));
  }, async (baseUrl) => {
    const conn = connection(contract(baseUrl));
    const shipment: Shipment = {
      id: 'shipment-x', tenantId: 'tenant-example', provider: 'starken', externalOrderId: 'ORDER-X', marketplaceShipmentId: null,
      providerShipmentRef: 'OF-X', trackingNumber: 'STK-X', status: 'in_transit', serviceCode: 'STD', idempotencyKey: 'order-x',
      metadata: {}, createdAt: '2026-08-25T19:00:00.000Z', updatedAt: '2026-08-25T19:00:00.000Z',
    };
    await assert.rejects(() => adapter.tracking!(shipment, conn), /Unknown Starken tracking status/);
  });
});


test('Starken request templates can consume generic delivery, agency, payment and declared-value fields', async () => {
  await withJsonServer((_req, body, res) => {
    assert.deepEqual(body, {
      delivery: 'agency',
      payment: 'sender_prepaid',
      declaredValue: 75000,
      agency: 'OPAQUE-LOCATION-9',
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { services: [{ code: 'STD', name: 'Standard', price: 5900, days: 2 }] } }));
  }, async (baseUrl) => {
    const cfg = contract(baseUrl) as any;
    cfg.contract.operations.quote.bodyTemplate = {
      delivery: '{{deliveryPreference}}',
      payment: '{{paymentMode}}',
      declaredValue: '{{declaredValueClp}}',
      agency: '{{destination.providerLocationId}}',
    };
    const adapter = new StarkenAdapter(new CountingSecretProvider('fixture-token'));
    const quote = await adapter.quote({
      tenantId: 'tenant-example', provider: 'starken', origin,
      destination: { ...destination, providerLocationId: 'OPAQUE-LOCATION-9' },
      package: packageSpec, allowLive: true,
      deliveryPreference: 'agency', paymentMode: 'sender_prepaid', declaredValueClp: 75000,
    }, connection(cfg));
    assert.equal(quote.amount, 5900);
  });
});
