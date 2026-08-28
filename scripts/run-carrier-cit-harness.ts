import { buildMercadoEnviosCarrierHarness } from '../src/meli-carrier-harness.js';

if (process.env.CARRIER_CIT_ALLOW_FIXTURE_DEFAULTS !== '1') {
  throw new Error('CARRIER_CIT_ALLOW_FIXTURE_DEFAULTS=1 is required; this runner is fixture-only');
}

const port = Number(process.env.CARRIER_CIT_PORT ?? 18787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CARRIER_CIT_PORT is invalid');

const app = buildMercadoEnviosCarrierHarness({
  host: '127.0.0.1',
  clientId: process.env.CARRIER_CIT_CLIENT_ID ?? 'cit-client',
  clientSecret: process.env.CARRIER_CIT_CLIENT_SECRET ?? 'cit-secret',
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
      tracking_number: 'CIT-EFFECTIVE-1',
      events: [
        { code: '0204', carrier_code: 'PICKED_UP', payload: { date: '2026-08-26T10:00:00-04:00', location: { city_name: 'Santiago', state_name: 'Metropolitana', country_id: 'CL' } } },
        { code: '0271', carrier_code: 'HUB_IN', payload: { date: '2026-08-26T11:00:00-04:00', location: { city_name: 'Santiago', state_name: 'Metropolitana', country_id: 'CL', facility: { id: 'HUB-SCL-1', name: 'Fixture Hub' }, geolocation: { geolocation_type: 'ROOFTOP', latitude: -33.45, longitude: -70.66 } } } },
        { code: '0273', carrier_code: 'HUB_OUT', payload: { date: '2026-08-26T12:00:00-04:00', location: { city_name: 'Santiago', state_name: 'Metropolitana', country_id: 'CL', facility: { id: 'HUB-SCL-1', name: 'Fixture Hub' }, geolocation: { geolocation_type: 'ROOFTOP', latitude: -33.45, longitude: -70.66 } } } },
        { code: '0211', carrier_code: 'IN_TRANSIT', payload: { date: '2026-08-26T13:00:00-04:00', location: { city_name: 'Santiago', state_name: 'Metropolitana', country_id: 'CL' } } },
        { code: '0227', carrier_code: 'OUT_FOR_DELIVERY', payload: { date: '2026-08-26T14:00:00-04:00', location: { city_name: 'Viña Del Mar', state_name: 'Valparaíso', country_id: 'CL', geolocation: { geolocation_type: 'APPROXIMATE', latitude: -33.02, longitude: -71.55 } } } },
        { code: '0401', carrier_code: 'DELIVERED', payload: { date: '2026-08-26T15:00:00-04:00', location: { city_name: 'Viña Del Mar', state_name: 'Valparaíso', country_id: 'CL' }, proof_of_delivery: { receiver_document: { type: 'RUT', number: '11111111-1' }, receiver_name: 'Fixture Receiver', receiver_relationship: 'BUYER' } } },
      ],
    },
    {
      id: 10111075224,
      tracking_number: 'CIT-CONCILIATION-1',
      events: [
        {
          code: '0260',
          carrier_code: 'MEASURED',
          payload: {
            date: '2026-08-26T10:30:00-04:00',
            location: { city_name: 'Santiago', state_name: 'Metropolitana', country_id: 'CL' },
            cost: 5730,
            dimensions: { weight: 800, height: 10, width: 20, length: 30 },
          },
        },
      ],
    },
  ],
});

await app.listen({ host: '127.0.0.1', port });
console.log(`Mercado Envíos Carrier CIT fixture harness listening on 127.0.0.1:${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
