import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { AdapterRegistry, MercadoLibreAdapter, MockCourierAdapter } from '../src/adapters.js';
import type { SecretProvider } from '../src/ports.js';
import { nowIso, type SellerConnection } from '../src/domain.js';
import { buildServer } from '../src/server.js';
import { SqliteStore } from '../src/store.js';
import {
  analyzeSellerOwnedShipping,
  buildCustomItemShippingPlan,
  buildCustomShipmentUpdatePlan,
  buildMe1SellerNotificationPlan,
} from '../src/meli-seller-shipping.js';

class FixtureSecrets implements SecretProvider {
  calls = 0;
  async resolve(reference: string): Promise<string> {
    this.calls += 1;
    assert.equal(reference, 'meli/fixture');
    return 'fixture-token';
  }
}

const seller: SellerConnection = {
  id: 'seller-connection-1',
  tenantId: 'tenant-1',
  marketplace: 'mercadolibre',
  sellerId: '123456',
  credentialRef: 'meli/fixture',
  enabled: true,
  config: {},
  createdAt: '2026-08-26T00:00:00.000Z',
};

async function withServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('MercadoLibreAdapter reads seller/category/item shipping capabilities without writes', async () => {
  const requests: string[] = [];
  await withServer((req, _body, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/users/123456/shipping_preferences') {
      res.end(JSON.stringify({ modes: ['custom', 'not_specified', 'me2'], custom_calculator: null }));
      return;
    }
    if (req.url === '/categories/MLC123/shipping_preferences') {
      res.end(JSON.stringify({ logistics: [{ mode: 'custom', types: ['default'] }, { mode: 'me2', types: ['drop_off'] }] }));
      return;
    }
    if (req.url === '/items/MLC999') {
      res.end(JSON.stringify({ id: 'MLC999', site_id: 'MLC', title: 'Fixture', price: 10000, currency_id: 'CLP', category_id: 'MLC123', listing_type_id: 'gold_pro', buying_mode: 'buy_it_now', condition: 'new', attributes: [], shipping: { mode: 'custom', free_shipping: false, local_pick_up: false, dimensions: null } }));
      return;
    }
    if (req.url === '/users/123456/shipping_modes' && req.method === 'POST') {
      res.end(JSON.stringify({ channels: { marketplace: { available_modes: [{ mode: 'custom', logistic_types: [] }, { mode: 'me2', logistic_types: [] }] } } }));
      return;
    }
    if (req.url === '/items/MLC999/shipping_options?city_to=TUxDQ1NBTlRJR09D') {
      res.end(JSON.stringify({ options: [{ id: 'MLC999-0', name: 'Despacho', list_cost: 4990 }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  }, async (baseUrl) => {
    const secrets = new FixtureSecrets();
    const adapter = new MercadoLibreAdapter(secrets, baseUrl, false);
    const sellerPrefs = await adapter.fetchSellerShippingPreferences(seller);
    const categoryPrefs = await adapter.fetchCategoryShippingPreferences(seller, 'MLC123');
    const item = await adapter.fetchItem(seller, 'MLC999');
    const shippingModes = await adapter.fetchItemShippingModes(seller, { site_id: 'MLC', item_id: 'MLC999' });
    const options = await adapter.fetchItemShippingOptions(seller, 'MLC999', { cityTo: 'TUxDQ1NBTlRJR09D' });
    assert.deepEqual(sellerPrefs.modes, ['custom', 'not_specified', 'me2']);
    assert.equal((item.shipping as Record<string, unknown>).mode, 'custom');
    assert.ok(Array.isArray(options.options));
    assert.ok((shippingModes.channels as Record<string, unknown>).marketplace);
    assert.deepEqual(requests, [
      'GET /users/123456/shipping_preferences',
      'GET /categories/MLC123/shipping_preferences',
      'GET /items/MLC999',
      'POST /users/123456/shipping_modes',
      'GET /items/MLC999/shipping_options?city_to=TUxDQ1NBTlRJR09D',
    ]);
    assert.equal(secrets.calls, 5);
  });
});

test('seller-owned analysis allows Custom only when observed account/category evidence supports it', () => {
  const eligible = analyzeSellerOwnedShipping({
    sellerPreferences: { modes: ['custom', 'not_specified', 'me2'] },
    categoryPreferences: { logistics: [{ mode: 'custom', types: ['default'] }, { mode: 'me2', types: [] }] },
    item: { id: 'MLC999', site_id: 'MLC', title: 'Fixture', price: 10000, currency_id: 'CLP', category_id: 'MLC123', listing_type_id: 'gold_pro', buying_mode: 'buy_it_now', condition: 'new', attributes: [], shipping: { mode: 'custom', local_pick_up: false, dimensions: null } },
  });
  assert.equal(eligible.customEligible, true);
  assert.equal(eligible.me1AlreadyAvailable, false);
  assert.equal(eligible.me1DirectRequestChannelDocumented, true);
  assert.equal(eligible.me1SellerGuidanceRequiresCertifiedIntegrator, true);
  assert.equal(eligible.me1ActivationRequirementConflict, true);
  assert.equal(eligible.dynamicFreightActivationRequiresCertifiedIntegrator, true);
  assert.equal(eligible.dynamicFreightHomologationRequiresCertifiedIntegrator, true);
  assert.equal(eligible.recommendedPath, 'custom');

  const blocked = analyzeSellerOwnedShipping({
    sellerPreferences: { modes: ['custom', 'me2'] },
    categoryPreferences: { logistics: [{ mode: 'me2', types: ['drop_off'] }] },
    item: { id: 'MLC998', category_id: 'MLC321', shipping: { mode: 'me2' } },
  });
  assert.equal(blocked.customEligible, false);
  assert.equal(blocked.recommendedPath, 'none');
  assert.match(blocked.blockers.join(' '), /category/i);
});

test('seller-owned analysis reports existing ME1 but never claims seller-owned activation/homologation', () => {
  const result = analyzeSellerOwnedShipping({
    sellerPreferences: { modes: ['me1', 'custom'] },
    categoryPreferences: { logistics: [{ mode: 'me1', types: ['default'] }] },
    item: { id: 'MLC777', category_id: 'MLC777', shipping: { mode: 'me1' } },
  });
  assert.equal(result.me1AlreadyAvailable, true);
  assert.equal(result.me1DirectRequestChannelDocumented, true);
  assert.equal(result.me1SellerGuidanceRequiresCertifiedIntegrator, true);
  assert.equal(result.me1ActivationRequirementConflict, true);
  assert.equal(result.dynamicFreightActivationRequiresCertifiedIntegrator, true);
  assert.equal(result.dynamicFreightHomologationRequiresCertifiedIntegrator, true);
  assert.equal(result.recommendedPath, 'existing_me1');
});

test('item-specific shipping_modes prevalidation is stronger than incomplete seller mode evidence', () => {
  const result = analyzeSellerOwnedShipping({
    sellerPreferences: { modes: ['me2'] },
    categoryPreferences: { logistics: [{ mode: 'custom', types: ['custom'] }, { mode: 'me2', types: [] }] },
    item: { id: 'MLC900', category_id: 'MLC123', shipping: { mode: 'me2' } },
    itemShippingModes: { channels: { marketplace: { available_modes: [{ mode: 'custom' }, { mode: 'me2' }] } } },
  });
  assert.equal(result.customEligible, true);
  assert.deepEqual(result.itemAvailableModes, ['custom', 'me2']);
  assert.equal(result.recommendedPath, 'custom');

  const denied = analyzeSellerOwnedShipping({
    sellerPreferences: { modes: ['custom', 'me2'] },
    categoryPreferences: { logistics: [{ mode: 'custom', types: ['custom'] }, { mode: 'me2', types: [] }] },
    item: { id: 'MLC901', category_id: 'MLC123', shipping: { mode: 'me2' } },
    itemShippingModes: { channels: { marketplace: { available_modes: [{ mode: 'me2' }] } } },
  });
  assert.equal(denied.customEligible, false);
  assert.match(denied.blockers.join(' '), /prevalidation/i);
});

test('category contradiction fails closed even when item currently says custom', () => {
  const result = analyzeSellerOwnedShipping({
    sellerPreferences: { modes: ['custom', 'me2'] },
    categoryPreferences: { logistics: [{ mode: 'me2', types: ['drop_off'] }] },
    item: { id: 'MLC902', category_id: 'MLC321', shipping: { mode: 'custom', local_pick_up: true, free_shipping: false } },
  });
  assert.equal(result.customEligible, false);
  assert.match(result.blockers.join(' '), /category/i);
});

test('malformed discovery evidence fails closed', () => {
  assert.throws(() => analyzeSellerOwnedShipping({
    sellerPreferences: { modes: 'custom' },
    categoryPreferences: { logistics: [] },
    item: null,
  }), /shipping preferences/i);
});

test('Custom item plan is dry-run deterministic and refuses ineligible mode', () => {
  const capability = analyzeSellerOwnedShipping({
    sellerPreferences: { modes: ['custom'] },
    categoryPreferences: { logistics: [{ mode: 'custom', types: ['default'] }] },
    item: { id: 'MLC999', category_id: 'MLC123', shipping: { mode: 'not_specified' } },
  });
  const plan = buildCustomItemShippingPlan(capability, {
    itemId: 'MLC999',
    costs: [
      { description: 'Despacho zona 1', cost: 4990 },
      { description: 'Despacho zona 2', cost: 6990 },
    ],
  });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.method, 'PUT');
  assert.equal(plan.path, '/items/MLC999');
  assert.deepEqual(plan.body, {
    shipping: {
      mode: 'custom',
      local_pick_up: false,
      free_shipping: false,
      methods: [],
      costs: [
        { description: 'Despacho zona 1', cost: '4990' },
        { description: 'Despacho zona 2', cost: '6990' },
      ],
    },
  });

  assert.throws(() => buildCustomItemShippingPlan({ ...capability, customEligible: false }, {
    itemId: 'MLC999', costs: [{ description: 'X', cost: 1 }],
  }), /not eligible/i);
});

test('Custom shipment update plans follow official shipped/delivered/cancelled contracts', () => {
  const shipped = buildCustomShipmentUpdatePlan({
    shipmentId: 'SHIP-1',
    status: 'shipped',
    receiverId: '1234',
    trackingNumber: 'OF-999',
    speedHours: 72,
  });
  assert.equal(shipped.dryRun, true);
  assert.equal(shipped.method, 'PUT');
  assert.equal(shipped.path, '/shipments/SHIP-1');
  assert.deepEqual(shipped.body, { status: 'shipped', receiver_id: '1234', tracking_number: 'OF-999', speed: 72 });

  const delivered = buildCustomShipmentUpdatePlan({ shipmentId: 'SHIP-1', status: 'delivered', receiverId: '1234' });
  assert.deepEqual(delivered.body, { status: 'delivered', receiver_id: '1234' });

  const cancelled = buildCustomShipmentUpdatePlan({ shipmentId: 'SHIP-1', status: 'cancelled', receiverId: '1234' });
  assert.equal(cancelled.method, 'POST');
  assert.deepEqual(cancelled.body, { status: 'cancelled', receiver_id: '1234' });

  assert.throws(() => buildCustomShipmentUpdatePlan({ shipmentId: 'SHIP-1', status: 'shipped', receiverId: '1234' }), /trackingNumber/i);
});


test('ME1 V2 seller notification plan enforces current MLC status/substatus and tracking-pair contract', () => {
  const shipped = buildMe1SellerNotificationPlan({
    siteId: 'MLC',
    shipmentId: 'SHIP-ME1-1',
    status: 'shipped',
    substatus: 'receiver_absent',
    occurredAt: '2026-08-28T09:30:00-04:00',
    comment: 'Visita fallida',
    trackingNumber: 'OF-123',
    trackingUrl: 'https://tracking.example.invalid/OF-123',
  });
  assert.equal(shipped.dryRun, true);
  assert.equal(shipped.method, 'POST');
  assert.equal(shipped.path, '/v2/shipments/SHIP-ME1-1/seller_notifications');
  assert.deepEqual(shipped.body, {
    payload: { service_id: 282578, comment: 'Visita fallida', date: '2026-08-28T09:30:00-04:00' },
    tracking_number: 'OF-123',
    tracking_url: 'https://tracking.example.invalid/OF-123',
    status: 'shipped',
    substatus: 'receiver_absent',
  });

  const delivered = buildMe1SellerNotificationPlan({
    siteId: 'MLC', shipmentId: 'SHIP-ME1-1', status: 'delivered', substatus: null,
    occurredAt: '2026-08-28T12:00:00Z',
  });
  assert.equal(delivered.body.substatus, null);

  const notDelivered = buildMe1SellerNotificationPlan({
    siteId: 'MLC', shipmentId: 'SHIP-ME1-1', status: 'not_delivered', substatus: 'returned',
    occurredAt: '2026-08-28T13:00:00Z',
  });
  assert.equal(notDelivered.body.status, 'not_delivered');

  assert.throws(() => buildMe1SellerNotificationPlan({
    siteId: 'MLC', shipmentId: 'SHIP-ME1-1', status: 'shipped', substatus: 'returned',
    occurredAt: '2026-08-28T13:00:00Z',
  }), /status.*substatus|substatus.*status/i);
  assert.throws(() => buildMe1SellerNotificationPlan({
    siteId: 'MLC', shipmentId: 'SHIP-ME1-1', status: 'not_delivered', substatus: 'returning_to_sender' as never,
    occurredAt: '2026-08-28T13:00:00Z',
  }), /status.*substatus|substatus.*status/i);
  const nearDoor = buildMe1SellerNotificationPlan({
    siteId: 'MLC', shipmentId: 'SHIP-ME1-2', status: 'shipped', substatus: 'at_the_door',
    occurredAt: '2026-08-28T13:00:00Z',
  });
  assert.equal(nearDoor.body.substatus, 'at_the_door');

  assert.throws(() => buildMe1SellerNotificationPlan({
    siteId: 'MLC', shipmentId: 'SHIP-ME1-1', status: 'delivered', substatus: 'null' as never,
    occurredAt: '2026-08-28T13:00:00Z',
  }), /substatus/i);
  assert.throws(() => buildMe1SellerNotificationPlan({
    siteId: 'MLC', shipmentId: 'SHIP-ME1-1', status: 'shipped', substatus: null,
    occurredAt: 'not-a-date',
  }), /date|ISO/i);
  assert.throws(() => buildMe1SellerNotificationPlan({
    siteId: 'MLC', shipmentId: 'SHIP-ME1-1', status: 'shipped', substatus: null,
    occurredAt: '2026-08-28T13:00:00Z', trackingNumber: 'OF-1',
  }), /tracking.*together|tracking.*pair/i);
});

test('Custom marketplace writes stay disabled unless explicitly enabled on seller connection', async () => {
  const secrets = new FixtureSecrets();
  const adapter = new MercadoLibreAdapter(secrets, 'http://127.0.0.1:9', false);
  await assert.rejects(
    () => adapter.publishCustomTracking({ ...seller, config: {} }, 'SHIP-1', { status: 'delivered' }),
    /custom shipping writes are disabled/i,
  );
  assert.equal(secrets.calls, 0, 'write gate must fail before secret resolution/network');
});


test('explicitly enabled low-level Custom tracking write uses only the official shipment path', async () => {
  const requests: Array<{ method: string | undefined; url: string | undefined; body: string }> = [];
  await withServer((req, body, res) => {
    requests.push({ method: req.method, url: req.url, body });
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    assert.equal(req.headers['content-type'], 'application/json');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  }, async (baseUrl) => {
    const secrets = new FixtureSecrets();
    const adapter = new MercadoLibreAdapter(secrets, baseUrl, false);
    await adapter.publishCustomTracking(
      { ...seller, config: { customShippingWritesEnabled: true } },
      'SHIP-1',
      { status: 'delivered', receiver_id: '42' },
    );
    assert.equal(secrets.calls, 1);
    assert.deepEqual(requests, [{
      method: 'PUT',
      url: '/shipments/SHIP-1',
      body: JSON.stringify({ status: 'delivered', receiver_id: '42' }),
    }]);
  });
});



test('ME1 low-level write stays double-gated and uses only V2 seller_notifications when explicitly certified', async () => {
  const secrets = new FixtureSecrets();
  const runtimeBlocked = new MercadoLibreAdapter(secrets, 'http://127.0.0.1:9', false);
  await assert.rejects(
    () => runtimeBlocked.publishMe1Tracking({ ...seller, config: { me1Certified: true } }, 'SHIP-1', { status: 'delivered', substatus: null }),
    /certification.*enabled|ME1 publication is disabled/i,
  );
  assert.equal(secrets.calls, 0, 'runtime ME1 gate must fail before secret resolution/network');

  const requests: Array<{ method: string | undefined; url: string | undefined; body: string }> = [];
  await withServer((req, body, res) => {
    requests.push({ method: req.method, url: req.url, body });
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  }, async (baseUrl) => {
    const localSecrets = new FixtureSecrets();
    const adapter = new MercadoLibreAdapter(localSecrets, baseUrl, true);
    await assert.rejects(
      () => adapter.publishMe1Tracking({ ...seller, config: {} }, 'SHIP-1', { status: 'delivered', substatus: null }),
      /ME1 publication is disabled/i,
    );
    assert.equal(localSecrets.calls, 0, 'seller ME1 gate must fail before secret resolution/network');

    const payload = buildMe1SellerNotificationPlan({
      siteId: 'MLC', shipmentId: 'SHIP-1', status: 'delivered', substatus: null,
      occurredAt: '2026-08-28T12:00:00Z', trackingNumber: 'OF-1', trackingUrl: 'https://tracking.example.invalid/OF-1',
    }).body;
    await adapter.publishMe1Tracking({ ...seller, config: { me1Certified: true } }, 'SHIP-1', payload);
    assert.equal(localSecrets.calls, 1);
    assert.deepEqual(requests, [{
      method: 'POST',
      url: '/v2/shipments/SHIP-1/seller_notifications',
      body: JSON.stringify(payload),
    }]);
  });
});

test('HTTP seller-owned endpoints expose discovery and dry-run plans only', async () => {
  await withServer((req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/users/123456/shipping_preferences') {
      res.end(JSON.stringify({ modes: ['custom', 'me2'] }));
      return;
    }
    if (req.url === '/categories/MLC123/shipping_preferences') {
      res.end(JSON.stringify({ logistics: [{ mode: 'custom', types: ['default'] }] }));
      return;
    }
    if (req.url === '/items/MLC999') {
      res.end(JSON.stringify({ id: 'MLC999', site_id: 'MLC', title: 'Fixture', price: 10000, currency_id: 'CLP', category_id: 'MLC123', listing_type_id: 'gold_pro', buying_mode: 'buy_it_now', condition: 'new', attributes: [], shipping: { mode: 'custom', local_pick_up: false, dimensions: null } }));
      return;
    }
    if (req.url === '/users/123456/shipping_modes' && req.method === 'POST') {
      res.end(JSON.stringify({ channels: { marketplace: { available_modes: [{ mode: 'custom' }, { mode: 'me2' }] } } }));
      return;
    }
    if (req.url === '/items/MLC999/shipping_options?city_to=TUxDQ1NBTlRJR09D') {
      res.end(JSON.stringify({ options: [{ id: 'option-1', list_cost: 4990 }] }));
      return;
    }
    res.statusCode = 500;
    res.end('{}');
  }, async (baseUrl) => {
    const store = new SqliteStore(':memory:');
    store.createTenant({ id: 'tenant-1', name: 'Fixture', createdAt: nowIso() });
    store.createSellerConnection(seller);
    const marketplace = new MercadoLibreAdapter(new FixtureSecrets(), baseUrl, false);
    const app = buildServer({
      store,
      adapters: new AdapterRegistry([new MockCourierAdapter()]),
      marketplace,
      config: {
        host: '127.0.0.1', port: 0, sqlitePath: ':memory:', logLevel: 'silent', me1Certified: false,
        enableDevRoutes: false, meliApiBaseUrl: baseUrl,
      },
    });

    const capabilities = await app.inject({
      method: 'GET',
      url: '/v1/tenants/tenant-1/sellers/123456/shipping/capabilities?categoryId=MLC123&itemId=MLC999',
    });
    assert.equal(capabilities.statusCode, 200, capabilities.body);
    assert.equal(capabilities.json().customEligible, true);
    assert.equal(capabilities.json().me1DirectRequestChannelDocumented, true);
    assert.equal(capabilities.json().me1SellerGuidanceRequiresCertifiedIntegrator, true);
    assert.equal(capabilities.json().me1ActivationRequirementConflict, true);
    assert.equal(capabilities.json().dynamicFreightActivationRequiresCertifiedIntegrator, true);
    assert.equal(capabilities.json().dynamicFreightHomologationRequiresCertifiedIntegrator, true);

    const options = await app.inject({
      method: 'GET',
      url: '/v1/tenants/tenant-1/sellers/123456/shipping/item-options?itemId=MLC999&cityTo=TUxDQ1NBTlRJR09D',
    });
    assert.equal(options.statusCode, 200, options.body);

    const itemPlan = await app.inject({
      method: 'POST',
      url: '/v1/tenants/tenant-1/sellers/123456/shipping/custom/item-plan',
      payload: { categoryId: 'MLC123', itemId: 'MLC999', costs: [{ description: 'Despacho', cost: 4990 }] },
    });
    assert.equal(itemPlan.statusCode, 200, itemPlan.body);
    assert.equal(itemPlan.json().dryRun, true);
    assert.equal(itemPlan.json().path, '/items/MLC999');

    const trackingPlan = await app.inject({
      method: 'POST',
      url: '/v1/tenants/tenant-1/sellers/123456/shipping/custom/shipment-update-plan',
      payload: { shipmentId: 'SHIP-1', status: 'shipped', receiverId: '42', trackingNumber: 'OF-1', speedHours: 48 },
    });
    assert.equal(trackingPlan.statusCode, 200, trackingPlan.body);
    assert.equal(trackingPlan.json().dryRun, true);
    assert.equal(trackingPlan.json().method, 'PUT');

    const me1Plan = await app.inject({
      method: 'POST',
      url: '/v1/tenants/tenant-1/sellers/123456/shipping/me1/seller-notification-plan',
      payload: {
        siteId: 'MLC', shipmentId: 'SHIP-ME1-1', status: 'shipped', substatus: 'receiver_absent',
        occurredAt: '2026-08-28T09:30:00-04:00', trackingNumber: 'OF-ME1-1', trackingUrl: 'https://tracking.example.invalid/OF-ME1-1',
      },
    });
    assert.equal(me1Plan.statusCode, 200, me1Plan.body);
    assert.equal(me1Plan.json().dryRun, true);
    assert.equal(me1Plan.json().path, '/v2/shipments/SHIP-ME1-1/seller_notifications');
    assert.equal(me1Plan.json().body.payload.service_id, 282578);

    assert.equal(app.hasRoute({ method: 'PUT', url: '/v1/tenants/:tenantId/sellers/:sellerId/shipping/custom/item' }), false);
    await app.close();
  });
});
