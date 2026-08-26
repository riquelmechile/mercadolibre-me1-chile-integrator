import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { StarkenAdapter } from '../src/adapters.js';
import { IntegrationGatedError, type CarrierConnection, type Shipment } from '../src/domain.js';
import type { SecretProvider } from '../src/ports.js';

class CountingSecretProvider implements SecretProvider {
  calls = 0;
  constructor(private readonly value = 'fixture-token') {}
  async resolve(_reference: string): Promise<string> {
    this.calls += 1;
    return this.value;
  }
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

function officialConnection(baseUrl: string): CarrierConnection {
  return {
    id: 'starken-official',
    tenantId: 'tenant-example',
    provider: 'starken',
    credentialRef: 'starken/example',
    enabled: true,
    config: {
      protocol: 'starken-plugin-gateway-v1',
      capabilities: ['quote', 'create_shipment', 'tracking'],
      testBaseUrl: baseUrl,
      originAgencyCode: '1001',
      allowedOriginAgencyCodes: ['1001'],
      trackingStatusMap: {
        'EN TRANSITO': 'in_transit',
        ENTREGADO: 'delivered',
      },
    },
    createdAt: new Date().toISOString(),
  };
}

const origin = {
  region: 'Metropolitana',
  commune: 'Santiago',
  providerCityCode: '1',
  providerCommuneCode: '3126',
  providerAgencyCode: '1001',
  street: 'Origen',
  number: '100',
};

const destination = {
  region: 'Maule',
  commune: 'Talca',
  providerCityCode: '91',
  providerCommuneCode: '3001',
  providerAgencyCode: '2001',
  street: 'Destino',
  number: '200',
  unit: '5B',
};

const packageSpec = { weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 };

test('official Starken protocol sends the verified quote payload and preserves selected delivery/payment', async () => {
  await withJsonServer((req, body, res) => {
    assert.equal(req.url, '/quote/cotizador-multiple');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    assert.deepEqual(body, {
      origen: 1,
      destino: 91,
      bulto: 'BULTO',
      alto: 10,
      ancho: 10,
      largo: 10,
      kilos: 1,
      todas_alternativas: true,
    });
    res.statusCode = 201;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ alternativas: [
      { servicio: 'NORMAL', entrega: 'AGENCIA', codigo_tipo_pago: 3, precio: 5450 },
      { servicio: 'NORMAL', entrega: 'DOMICILIO', codigo_tipo_pago: 3, precio: 5730 },
    ] }));
  }, async (baseUrl) => {
    const secrets = new CountingSecretProvider();
    const adapter = new StarkenAdapter(secrets);
    const quote = await adapter.quote({
      tenantId: 'tenant-example', provider: 'starken', origin, destination,
      package: packageSpec, allowLive: true, deliveryPreference: 'any',
    }, officialConnection(baseUrl));
    assert.equal(quote.serviceCode, 'NORMAL');
    assert.equal(quote.amount, 5450);
    assert.equal(quote.deliveryMode, 'agency');
    assert.equal(quote.paymentMode, 'recipient_pay');
    assert.equal(quote.estimatedBusinessDays, null);
    assert.equal(secrets.calls, 1);
  });
});

test('official Starken protocol filters to requested home delivery even when agency is cheaper', async () => {
  await withJsonServer((_req, _body, res) => {
    res.statusCode = 201;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ alternativas: [
      { servicio: 'NORMAL', entrega: 'AGENCIA', codigo_tipo_pago: 3, precio: 5450 },
      { servicio: 'NORMAL', entrega: 'DOMICILIO', codigo_tipo_pago: 3, precio: 5730 },
    ] }));
  }, async (baseUrl) => {
    const adapter = new StarkenAdapter(new CountingSecretProvider());
    const quote = await adapter.quote({
      tenantId: 'tenant-example', provider: 'starken', origin, destination,
      package: packageSpec, allowLive: true, deliveryPreference: 'home', paymentMode: 'recipient_pay',
    }, officialConnection(baseUrl));
    assert.equal(quote.amount, 5730);
    assert.equal(quote.deliveryMode, 'home');
    assert.equal(quote.paymentMode, 'recipient_pay');
  });
});

test('official Starken protocol creates an agency shipment from normalized recipient/address data', async () => {
  await withJsonServer((req, body, res) => {
    assert.equal(req.url, '/emision/emision');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    assert.deepEqual(body, {
      codigo_agencia_origen: '1001',
      codigo_agencia_destino: '2001',
      destinatario_rut: '11111111-1',
      destinatario_nombres: 'Ada',
      destinatario_paterno: 'Lovelace',
      destinatario_telefono: '+56911111111',
      destinatario_email: 'ada@example.invalid',
      destinatario_contacto: 'Ada Lovelace',
      destinatario_direccion: 'Destino',
      destinatario_numeracion: '200',
      destinatario_departamento: '5B',
      destinatario_codigo_comuna: 3001,
      contenido: '#ORDER-42',
      valor_declarado: 40000,
      tipo_entrega: { codigo_dls: '1' },
      tipo_pago: { codigo_dls: 3 },
      tipo_servicio: { codigo_dls: '0' },
      encargos: [{ descripcion: 'ORDER-42', tipo_encargo: 'BULTO', kilos: 1, alto: 10, ancho: 10, largo: 10 }],
    });
    res.statusCode = 201;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 123, orden_flete: 456, etiqueta: 'https://labels.example.invalid/456.pdf', estado: 'CREADA' }));
  }, async (baseUrl) => {
    const adapter = new StarkenAdapter(new CountingSecretProvider());
    const conn = officialConnection(baseUrl);
    conn.config.allowedOriginAgencyCodes = ['1001', '1002'];
    const result = await adapter.createShipment({
      tenantId: 'tenant-example', provider: 'starken', externalOrderId: 'ORDER-42',
      origin, destination, package: packageSpec, serviceCode: 'NORMAL',
      deliveryMode: 'agency', paymentMode: 'recipient_pay', declaredValueClp: 40000,
      recipient: {
        taxId: '11111111-1', firstName: 'Ada', lastName: 'Lovelace',
        phone: '+56911111111', email: 'ada@example.invalid', contactName: 'Ada Lovelace',
      },
      idempotencyKey: 'order-42',
    }, conn);
    assert.equal(result.providerShipmentRef, '123');
    assert.equal(result.trackingNumber, '456');
    assert.equal(result.status, 'label_ready');
    assert.equal(result.labelUrl, 'https://labels.example.invalid/456.pdf');
    assert.deepEqual(result.metadata, {
      protocol: 'starken-plugin-gateway-v1', issuanceId: '123', freightOrder: '456', rawState: 'CREADA',
    });
  });
});

test('official Starken tracking maps history only through explicit configured status map', async () => {
  await withJsonServer((req, _body, res) => {
    assert.equal(req.url, '/tracking/orden-flete/of/456');
    assert.equal(req.method, 'GET');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ history: [
      { status: 'EN TRANSITO', note: 'Hub', created_at: '2026-08-25T20:00:00.000Z', updated_at: '2026-08-25T20:00:00.000Z' },
      { status: 'ENTREGADO', note: 'Recepcionado', created_at: '2026-08-26T16:00:00.000Z', updated_at: '2026-08-26T16:00:00.000Z' },
    ] }));
  }, async (baseUrl) => {
    const adapter = new StarkenAdapter(new CountingSecretProvider());
    const shipment: Shipment = {
      id: 'shipment-42', tenantId: 'tenant-example', provider: 'starken', externalOrderId: 'ORDER-42',
      marketplaceShipmentId: null, providerShipmentRef: '123', trackingNumber: '456', status: 'created',
      serviceCode: 'NORMAL', idempotencyKey: 'order-42', metadata: {},
      createdAt: '2026-08-25T19:00:00.000Z', updatedAt: '2026-08-25T19:00:00.000Z',
    };
    const events = await adapter.tracking!(shipment, officialConnection(baseUrl));
    assert.equal(events.length, 2);
    assert.equal(events[0]?.canonicalStatus, 'in_transit');
    assert.equal(events[1]?.canonicalStatus, 'delivered');
    assert.equal(events[1]?.final, true);
    assert.match(events[0]?.providerEventId ?? '', /^starken:/);
  });
});

test('official Starken protocol rejects an origin agency outside the configured allowlist before secret/network', async () => {
  const secrets = new CountingSecretProvider();
  const adapter = new StarkenAdapter(secrets);
  const conn = officialConnection('http://127.0.0.1:9');
  conn.config.allowedOriginAgencyCodes = ['1001', '1002'];
  await assert.rejects(
    () => adapter.createShipment({
      tenantId: 'tenant-example', provider: 'starken', externalOrderId: 'ORDER-BLOCKED',
      origin: { ...origin, providerAgencyCode: '9009' }, destination, package: packageSpec, serviceCode: 'NORMAL',
      deliveryMode: 'agency', paymentMode: 'recipient_pay', declaredValueClp: 40000,
      recipient: {
        taxId: '11111111-1', firstName: 'Ada', lastName: 'Lovelace',
        phone: '+56911111111', email: 'ada@example.invalid', contactName: 'Ada Lovelace',
      },
      idempotencyKey: 'blocked-origin',
    }, conn),
    (error: unknown) => error instanceof IntegrationGatedError && /origin agency.*allow/i.test(error.message),
  );
  assert.equal(secrets.calls, 0);
});

test('official Starken protocol rejects an invalid empty origin allowlist before secret/network', async () => {
  const secrets = new CountingSecretProvider();
  const adapter = new StarkenAdapter(secrets);
  const conn = officialConnection('http://127.0.0.1:9');
  conn.config.allowedOriginAgencyCodes = [];
  await assert.rejects(
    () => adapter.createShipment({
      tenantId: 'tenant-example', provider: 'starken', externalOrderId: 'ORDER-INVALID-ALLOWLIST',
      origin, destination, package: packageSpec, serviceCode: 'NORMAL',
      deliveryMode: 'agency', paymentMode: 'recipient_pay', declaredValueClp: 40000,
      recipient: {
        taxId: '11111111-1', firstName: 'Ada', lastName: 'Lovelace',
        phone: '+56911111111', email: 'ada@example.invalid', contactName: 'Ada Lovelace',
      },
      idempotencyKey: 'invalid-allowlist',
    }, conn),
    (error: unknown) => error instanceof IntegrationGatedError && /non-empty array/i.test(error.message),
  );
  assert.equal(secrets.calls, 0);
});

test('official Starken protocol rejects a missing origin allowlist before secret/network', async () => {
  const secrets = new CountingSecretProvider();
  const adapter = new StarkenAdapter(secrets);
  const conn = officialConnection('http://127.0.0.1:9');
  delete conn.config.allowedOriginAgencyCodes;
  await assert.rejects(
    () => adapter.createShipment({
      tenantId: 'tenant-example', provider: 'starken', externalOrderId: 'ORDER-MISSING-ALLOWLIST',
      origin, destination, package: packageSpec, serviceCode: 'NORMAL',
      deliveryMode: 'agency', paymentMode: 'recipient_pay', declaredValueClp: 40000,
      recipient: {
        taxId: '11111111-1', firstName: 'Ada', lastName: 'Lovelace',
        phone: '+56911111111', email: 'ada@example.invalid', contactName: 'Ada Lovelace',
      },
      idempotencyKey: 'missing-allowlist',
    }, conn),
    (error: unknown) => error instanceof IntegrationGatedError && /allowedOriginAgencyCodes.*required/i.test(error.message),
  );
  assert.equal(secrets.calls, 0);
});

test('official Starken protocol fails before secret/network when routing or recipient data is incomplete', async () => {
  const secrets = new CountingSecretProvider();
  const adapter = new StarkenAdapter(secrets);
  const conn = officialConnection('http://127.0.0.1:9');
  await assert.rejects(
    () => adapter.quote({
      tenantId: 'tenant-example', provider: 'starken',
      origin: { region: 'Metropolitana', commune: 'Santiago' }, destination,
      package: packageSpec, allowLive: true,
    }, conn),
    IntegrationGatedError,
  );
  await assert.rejects(
    () => adapter.createShipment({
      tenantId: 'tenant-example', provider: 'starken', externalOrderId: 'ORDER-X', origin, destination,
      package: packageSpec, serviceCode: 'NORMAL', deliveryMode: 'agency', paymentMode: 'recipient_pay',
      declaredValueClp: 10000, idempotencyKey: 'x',
    }, conn),
    IntegrationGatedError,
  );
  assert.equal(secrets.calls, 0);
});


test('official Starken protocol preserves configured base path when building endpoint URLs', async () => {
  await withJsonServer((req, _body, res) => {
    assert.equal(req.url, '/externo/integracion/quote/cotizador-multiple');
    res.statusCode = 201;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ alternativas: [
      { servicio: 'NORMAL', entrega: 'DOMICILIO', codigo_tipo_pago: 3, precio: 5730 },
    ] }));
  }, async (baseUrl) => {
    const adapter = new StarkenAdapter(new CountingSecretProvider());
    const quote = await adapter.quote({
      tenantId: 'tenant-example', provider: 'starken', origin, destination,
      package: packageSpec, allowLive: true, deliveryPreference: 'home', paymentMode: 'recipient_pay',
    }, officialConnection(`${baseUrl}/externo/integracion`));
    assert.equal(quote.amount, 5730);
  });
});

test('official Starken tracking event identity is stable when provider history order changes', async () => {
  let call = 0;
  const firstHistory = [
    { status: 'EN TRANSITO', note: 'moving', created_at: '2026-08-25T20:00:00.000Z' },
    { status: 'ENTREGADO', note: 'done', created_at: '2026-08-26T16:00:00.000Z' },
  ];
  await withJsonServer((_req, _body, res) => {
    call += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ history: call === 1 ? firstHistory : [...firstHistory].reverse() }));
  }, async (baseUrl) => {
    const adapter = new StarkenAdapter(new CountingSecretProvider());
    const shipment: Shipment = {
      id: 'shipment-stable', tenantId: 'tenant-example', provider: 'starken', externalOrderId: 'ORDER-STABLE', marketplaceShipmentId: null,
      providerShipmentRef: 'ISS-STABLE', trackingNumber: 'OF-STABLE', status: 'in_transit', serviceCode: 'NORMAL', idempotencyKey: 'stable',
      metadata: {}, createdAt: '2026-08-25T19:00:00.000Z', updatedAt: '2026-08-25T19:00:00.000Z',
    };
    const conn = officialConnection(baseUrl);
    const a = await adapter.tracking!(shipment, conn);
    const b = await adapter.tracking!(shipment, conn);
    assert.deepEqual(a.map((e) => e.providerEventId).sort(), b.map((e) => e.providerEventId).sort());
    assert.deepEqual(a.map((e) => e.canonicalStatus), ['in_transit', 'delivered']);
    assert.deepEqual(b.map((e) => e.canonicalStatus), ['in_transit', 'delivered']);
    assert.deepEqual(a.map((e) => e.occurredAt), b.map((e) => e.occurredAt));
  });
});
