import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMercadoEnviosCarrierHarness } from '../src/meli-carrier-harness.js';

const CLIENT_ID = 'cit-client';
const CLIENT_SECRET = 'cit-secret';

function baseOptions() {
  return {
    host: '127.0.0.1',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    carrierCode: 'MAUSTIAN-CIT',
    coverage: [
      { city_id: 'TUxDQ1NBTnRpYWdv', city_name: 'Santiago', state_id: 'CL-RM', state_name: 'Metropolitana' },
      { city_id: 'TUxDQ1ZJTkE', city_name: 'Viña Del Mar', state_id: 'CL-VS', state_name: 'Valparaíso' },
    ],
    agencies: [
      {
        agency_id: 'MST001',
        agency_name: 'Maustian Fixture Agency',
        business_name: 'Maustian Fixture',
        agency_type: 'agency',
        is_movable: false,
        phone: '221234567',
        package_reception: true,
        pickup_availability: false,
        unlabeled_package_reception: false,
        chain_of_custody: false,
        status: 'active',
        location: {
          country_name: 'Chile',
          state_name: 'Metropolitana',
          city_name: 'Santiago',
          city_id: 'TUxDQ1NBTnRpYWdv',
          neighborhood_name: 'Fixture',
          street_name: 'Fixture',
          street_number: '1',
          other_info: '',
          zip_code: '8320000',
          geo_location: { latitude: -33.45, longitude: -70.66 },
        },
        open_hours: {
          monday_to_friday: [{ from: '09:00', to: '18:00' }],
          saturday: null,
          sunday: null,
          holidays: null,
        },
      },
    ],
    tracking: [
      {
        id: 10111075223,
        tracking_number: 'CIT-10111075223-1',
        events: [
          {
            code: '0204',
            carrier_code: 'PICKED_UP',
            payload: {
              date: '2026-08-26T10:00:00-04:00',
              location: { city: 'Santiago', state: 'Metropolitana', country: 'Chile' },
            },
          },
          {
            code: '0271',
            carrier_code: 'HUB_IN',
            payload: {
              date: '2026-08-26T11:00:00-04:00',
              location: { city: 'Santiago', state: 'Metropolitana', country: 'Chile', facility: { id: 'HUB-SCL-1', name: 'Fixture Hub' }, geolocation: { geolocation_type: 'ROOFTOP', latitude: -33.45, longitude: -70.66 } },
            },
          },
          {
            code: '0273',
            carrier_code: 'HUB_OUT',
            payload: {
              date: '2026-08-26T12:00:00-04:00',
              location: { city: 'Santiago', state: 'Metropolitana', country: 'Chile', facility: { id: 'HUB-SCL-1', name: 'Fixture Hub' }, geolocation: { geolocation_type: 'ROOFTOP', latitude: -33.45, longitude: -70.66 } },
            },
          },
          {
            code: '0211',
            carrier_code: 'IN_TRANSIT',
            payload: {
              date: '2026-08-26T13:00:00-04:00',
              location: { city: 'Santiago', state: 'Metropolitana', country: 'Chile' },
            },
          },
          {
            code: '0227',
            carrier_code: 'OUT_FOR_DELIVERY',
            payload: {
              date: '2026-08-26T14:00:00-04:00',
              location: { city: 'Viña Del Mar', state: 'Valparaíso', country: 'Chile', geolocation: { geolocation_type: 'APPROXIMATE', latitude: -33.02, longitude: -71.55 } },
            },
          },
          {
            code: '0401',
            carrier_code: 'DELIVERED',
            payload: {
              date: '2026-08-26T15:00:00-04:00',
              location: { city: 'Viña Del Mar', state: 'Valparaíso', country: 'Chile' },
              proof_of_delivery: { receiver_document: { type: 'RUT', number: '11111111-1' }, receiver_name: 'Fixture Receiver', receiver_relationship: 'BUYER' },
            },
          },
        ],
      },
    ],
  } as const;
}

async function token(app: ReturnType<typeof buildMercadoEnviosCarrierHarness>, audience: string) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const response = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
    payload: { audience, grant_type: 'client_credentials' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.expires_in, 21600);
  assert.equal(typeof body.access_token, 'string');
  assert.ok(body.access_token.length >= 24);
  return body.access_token as string;
}

function authorizationPayload() {
  return {
    id: 10111075223,
    transport_order_id: 'fixture-transport-order',
    direction: 'forward',
    carrier_information: { contract: 'fixture-contract' },
    shipment_information: {
      sender: {
        full_name: 'Fixture Sender',
        first_name: 'Fixture',
        last_name: 'Sender',
        phone: { number: '912345678' },
        address: {
          address_line: 'Fixture 100',
          street_name: 'Fixture',
          street_number: '100',
          city: { id: 'TUxDQ1NBTnRpYWdv', name: 'Santiago' },
          state: { id: 'CL-RM', name: 'Metropolitana' },
          country: { id: 'CL', name: 'Chile' },
        },
      },
      receiver: {
        full_name: 'Fixture Receiver',
        first_name: 'Fixture',
        last_name: 'Receiver',
        phone: { number: '987654321' },
        address: {
          address_line: 'Destino 200',
          street_name: 'Destino',
          street_number: '200',
          city: { id: 'TUxDQ1ZJTkE', name: 'Viña Del Mar' },
          state: { id: 'CL-VS', name: 'Valparaíso' },
          country: { id: 'CL', name: 'Chile' },
        },
      },
      package: {
        items: [{ item_id: 'MLC-CIT-1', description: 'Fixture item', quantity: 1 }],
        description: 'MLC-CIT-1',
        dimensions: { height: 10, width: 20, length: 30, weight: 800 },
        amount: 39990,
      },
    },
    test: true,
  };
}

test('carrier CIT harness is loopback-only', () => {
  assert.throws(
    () => buildMercadoEnviosCarrierHarness({ ...baseOptions(), host: '0.0.0.0' }),
    /loopback/i,
  );
});

test('OAuth follows carrier audience contract and supports revocation', async () => {
  const app = buildMercadoEnviosCarrierHarness(baseOptions());
  const missingAuth = await app.inject({ method: 'POST', url: '/oauth/token', payload: { audience: 'coverage', grant_type: 'client_credentials' } });
  assert.equal(missingAuth.statusCode, 401);

  const badBasic = Buffer.from(`${CLIENT_ID}:wrong`).toString('base64');
  const wrongCreds = await app.inject({ method: 'POST', url: '/oauth/token', headers: { authorization: `Basic ${badBasic}` }, payload: { audience: 'coverage', grant_type: 'client_credentials' } });
  assert.equal(wrongCreds.statusCode, 401);

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const noAudience = await app.inject({ method: 'POST', url: '/oauth/token', headers: { authorization: `Basic ${basic}` }, payload: { grant_type: 'client_credentials' } });
  assert.equal(noAudience.statusCode, 400);
  const wrongAudience = await app.inject({ method: 'POST', url: '/oauth/token', headers: { authorization: `Basic ${basic}` }, payload: { audience: 'wrong', grant_type: 'client_credentials' } });
  assert.equal(wrongAudience.statusCode, 400);
  const wrongGrant = await app.inject({ method: 'POST', url: '/oauth/token', headers: { authorization: `Basic ${basic}` }, payload: { audience: 'coverage', grant_type: 'password' } });
  assert.equal(wrongGrant.statusCode, 400);

  const coverageToken = await token(app, 'coverage');
  const agenciesToken = await token(app, 'agencies');
  const wrongScope = await app.inject({ method: 'POST', url: '/coverage', headers: { authorization: `Bearer ${agenciesToken}` }, payload: { service_type: 'a_domicilio', direction: 'destination' } });
  assert.equal(wrongScope.statusCode, 401);

  const revokeToken = await token(app, 'revoke');
  const sameTokenRevoke = await app.inject({ method: 'POST', url: '/oauth/revoke', headers: { authorization: `Bearer ${coverageToken}`, 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${encodeURIComponent(coverageToken)}` });
  assert.equal(sameTokenRevoke.statusCode, 401);

  const revoked = await app.inject({ method: 'POST', url: '/oauth/revoke', headers: { authorization: `Bearer ${revokeToken}`, 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${encodeURIComponent(coverageToken)}` });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.deepEqual(revoked.json(), { status: 'OK' });
  const afterRevoke = await app.inject({ method: 'POST', url: '/coverage', headers: { authorization: `Bearer ${coverageToken}` }, payload: { service_type: 'a_domicilio', direction: 'destination' } });
  assert.equal(afterRevoke.statusCode, 401);
  await app.close();
});

test('Chile coverage and agencies require their dedicated audiences', async () => {
  const app = buildMercadoEnviosCarrierHarness(baseOptions());
  const coverageToken = await token(app, 'coverage');
  const coverage = await app.inject({
    method: 'POST', url: '/coverage', headers: { authorization: `Bearer ${coverageToken}` },
    payload: { service_type: 'a_domicilio', direction: 'destination' },
  });
  assert.equal(coverage.statusCode, 200, coverage.body);
  assert.equal(coverage.json().service_type, 'a_domicilio');
  assert.equal(coverage.json().direction, 'destination');
  assert.equal(coverage.json().country_id, 'CL');
  assert.equal(coverage.json().country_name, 'Chile');
  assert.equal(coverage.json().coverage.length, 2);

  const agencyToken = await token(app, 'agencies');
  const agencies = await app.inject({ method: 'POST', url: '/agencies', headers: { authorization: `Bearer ${agencyToken}` }, payload: { country_id: 'CL' } });
  assert.equal(agencies.statusCode, 200, agencies.body);
  assert.deepEqual(Object.keys(agencies.json()), ['agencies']);
  assert.equal(agencies.json().agencies[0].agency_id, 'MST001');
  assert.ok(agencies.json().agencies[0].open_hours);

  const wrongCountry = await app.inject({ method: 'POST', url: '/agencies', headers: { authorization: `Bearer ${agencyToken}` }, payload: { country_id: 'AR' } });
  assert.equal(wrongCountry.statusCode, 400);
  await app.close();
});

test('domestic authorization is idempotent, cancelable and regenerates tracking only after cancel', async () => {
  const app = buildMercadoEnviosCarrierHarness(baseOptions());
  const authToken = await token(app, 'authorizations');
  const payload = authorizationPayload();
  const headers = { authorization: `Bearer ${authToken}` };

  const empty = await app.inject({ method: 'POST', url: `/shipments/${payload.id}/authorization`, headers: { ...headers, 'content-type': 'application/json' }, payload: '' });
  assert.equal(empty.statusCode, 400, empty.body);
  assert.equal(empty.json().status, 'FAILED');

  const first = await app.inject({ method: 'POST', url: `/shipments/${payload.id}/authorization`, headers, payload });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().status, 'AUTHORIZED');
  assert.equal(first.json().status_message, 'OK');
  assert.equal(first.json().id, String(payload.id));
  assert.equal(typeof first.json().tracking_number, 'string');
  assert.ok(first.json().authorization_information?.date);
  assert.equal(typeof first.json().authorization_information?.custom_data, 'object');

  const duplicate = await app.inject({ method: 'POST', url: `/shipments/${payload.id}/authorization`, headers, payload });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.deepEqual(duplicate.json(), first.json());

  const changedPayload = structuredClone(payload);
  changedPayload.shipment_information.package.amount += 1;
  const conflict = await app.inject({ method: 'POST', url: `/shipments/${payload.id}/authorization`, headers, payload: changedPayload });
  assert.equal(conflict.statusCode, 409);

  const cancel = await app.inject({ method: 'PUT', url: `/shipments/${payload.id}/authorization`, headers, payload: { status: 'CANCEL', tracking_number: first.json().tracking_number } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().status, 'CANCELLED');
  assert.equal(cancel.json().status_message, '');

  const reauthorized = await app.inject({ method: 'POST', url: `/shipments/${payload.id}/authorization`, headers, payload });
  assert.equal(reauthorized.statusCode, 200, reauthorized.body);
  assert.notEqual(reauthorized.json().tracking_number, first.json().tracking_number);

  const blocked = await app.inject({ method: 'PUT', url: `/shipments/${payload.id}/delivery-block`, headers, payload: { status: 'CANCEL', tracking_number: reauthorized.json().tracking_number } });
  assert.equal(blocked.statusCode, 200, blocked.body);
  assert.equal(blocked.json().status, 'CANCELLED');
  assert.equal(blocked.json().status_message, 'BLOCKED');
  assert.equal(blocked.json().tracking_number, reauthorized.json().tracking_number);
  await app.close();
});

test('tracking pull returns explicit Mercado Envíos events and never accepts post-final events', async () => {
  const app = buildMercadoEnviosCarrierHarness(baseOptions());
  const trackingToken = await token(app, 'tracking-pull');
  const response = await app.inject({
    method: 'POST', url: '/tracking', headers: { authorization: `Bearer ${trackingToken}` },
    payload: [{ id: 10111075223, tracking_number: 'CIT-10111075223-1' }],
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.ok(Array.isArray(body));
  assert.equal(body[0].id, 10111075223);
  assert.equal(body[0].tracking_number, 'CIT-10111075223-1');
  assert.deepEqual(body[0].events.map((event: { code: string }) => event.code), ['0204', '0271', '0273', '0211', '0227', '0401']);
  for (const event of body[0].events) {
    assert.equal(typeof event.carrier_code, 'string');
    assert.ok(event.payload.date);
    assert.ok(event.payload.location);
  }
  await app.close();

  const original = baseOptions();
  const invalid = {
    ...original,
    tracking: [{
      ...original.tracking[0],
      events: [...original.tracking[0].events, {
        code: '0211',
        carrier_code: 'IMPOSSIBLE_AFTER_DELIVERY',
        payload: { date: '2026-08-26T16:00:00-04:00', location: { city: 'Viña Del Mar', state: 'Valparaíso', country: 'Chile' } },
      }],
    }],
  };
  assert.throws(() => buildMercadoEnviosCarrierHarness(invalid), /final.*event|event.*final/i);
});

test('official last-mile required nodes fail closed for hub/out-for-delivery/delivery events', () => {
  const original = baseOptions();
  const withoutFacility = structuredClone(original) as any;
  delete withoutFacility.tracking[0].events[1].payload.location.facility;
  assert.throws(() => buildMercadoEnviosCarrierHarness(withoutFacility), /0271.*facility|facility.*0271/i);

  const withoutPod = structuredClone(original) as any;
  delete withoutPod.tracking[0].events[5].payload.proof_of_delivery;
  assert.throws(() => buildMercadoEnviosCarrierHarness(withoutPod), /0401.*proof|proof.*0401/i);
});

test('conciliation event 0260 requires explicit cost and measured dimensions', () => {
  const original = baseOptions();
  const invalid = {
    ...original,
    tracking: [{
      ...original.tracking[0],
      events: [
        original.tracking[0].events[0],
        {
          code: '0260',
          carrier_code: 'CONCILIATION',
          payload: { date: '2026-08-26T10:30:00-04:00', location: { city: 'Santiago', state: 'Metropolitana', country: 'Chile' } },
        },
        ...original.tracking[0].events.slice(1),
      ],
    }],
  };
  assert.throws(() => buildMercadoEnviosCarrierHarness(invalid), /0260.*cost|conciliation.*dimension/i);
});
