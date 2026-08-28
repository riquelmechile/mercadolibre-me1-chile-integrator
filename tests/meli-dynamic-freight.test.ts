import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDynamicFreightQuoteResponse,
  dynamicFreightCacheHeaders,
  dynamicFreightConditionalStatus,
  dynamicFreightErrorResponse,
  validateDynamicFreightRequest,
} from '../src/meli-dynamic-freight.js';

function requestFixture() {
  return {
    seller_id: '123456',
    buyer_id: '654321',
    declared_value: 79990,
    items: [
      {
        id: 'MLC123456789',
        variation_id: 0,
        category_id: 'MLC123',
        price: 79990,
        quantity: 3,
        sku: 'FIXTURE-SKU',
        store_id: 231,
        dimensions: { length: 143, width: 5, height: 5, weight: 1800 },
      },
    ],
    origin: { type: 'city', value: 'Metropolitana/Santiago' },
    destination: { type: 'city', value: 'Valparaíso/Viña del Mar' },
  };
}

test('Dynamic Freight accepts one seller item and preserves MELI-consolidated dimensions when quantity > 1', () => {
  const input = requestFixture();
  const normalized = validateDynamicFreightRequest(input);
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].quantity, 3);
  assert.equal(normalized.items[0].store_id, 231);
  assert.deepEqual(normalized.items[0].dimensions, { length: 143, width: 5, height: 5, weight: 1800 });

  const response = buildDynamicFreightQuoteResponse(normalized, {
    destinations: ['CL-VS:VINA_DEL_MAR'],
    quotations: [
      { price: 8990, handling_time: 0, shipping_time: 3, promise: 3, service: 17 },
      { price: 10990, handling_time: 0, shipping_time: 1, promise: 1, service: 18 },
    ],
  });
  assert.deepEqual(response.packages[0].dimensions, input.items[0].dimensions, 'runtime must not multiply or repack MELI dimensions');
  assert.equal(response.packages[0].items[0].quantity, 3);
  assert.equal(response.packages[0].quotations.length, 2);
});

test('Dynamic Freight request rejects fractional dimensions because the current homologation contract uses integer centimeters/grams', () => {
  const fractional = requestFixture();
  fractional.items[0].dimensions.width = 4.5;
  assert.throws(() => validateDynamicFreightRequest(fractional), /dimensions.*integer|width.*integer/i);
});

test('Dynamic Freight request fails closed on multiple item rows or stale/incomplete Chile destination shape', () => {
  const multiple = requestFixture();
  multiple.items.push({ ...multiple.items[0], id: 'MLC2' });
  assert.throws(() => validateDynamicFreightRequest(multiple), /one.*item|single.*item/i);

  const staleShape = requestFixture();
  staleShape.destination = { region: 'Valparaíso', commune: 'Viña del Mar' } as never;
  assert.throws(() => validateDynamicFreightRequest(staleShape), /destination.*type|type.*city/i);

  const incompleteCity = requestFixture();
  incompleteCity.destination = { type: 'city', value: 'Valparaíso' } as never;
  assert.throws(() => validateDynamicFreightRequest(incompleteCity), /region.*commune|city.*value|slash/i);
});

test('Dynamic Freight response enforces quotation service 0..99 and promise arithmetic', () => {
  const input = validateDynamicFreightRequest(requestFixture());
  assert.throws(() => buildDynamicFreightQuoteResponse(input, {
    destinations: ['CL-VS:VINA_DEL_MAR'],
    quotations: [{ price: 8990, handling_time: 1, shipping_time: 2, promise: 4, service: 17 }],
  }), /promise/i);
  assert.throws(() => buildDynamicFreightQuoteResponse(input, {
    destinations: ['CL-VS:VINA_DEL_MAR'],
    quotations: [{ price: 8990, handling_time: 0, shipping_time: 2, promise: 2, service: 123 }],
  }), /service.*0.*99|service.*range/i);
  assert.throws(() => buildDynamicFreightQuoteResponse(input, {
    destinations: ['CL-VS:VINA_DEL_MAR'], quotations: [],
  }), /quotation/i);
});

test('Dynamic Freight cache contract requires ETag and either no-store or private max-age', () => {
  const body = buildDynamicFreightQuoteResponse(validateDynamicFreightRequest(requestFixture()), {
    destinations: ['CL-VS:VINA_DEL_MAR'],
    quotations: [{ price: 8990, handling_time: 0, shipping_time: 3, promise: 3, service: 17 }],
  });
  const cached = dynamicFreightCacheHeaders(body, { maxAgeSeconds: 120, ageSeconds: 0 });
  assert.equal(cached['Cache-Control'], 'private;max-age=120');
  assert.equal(cached.Age, '0');
  assert.match(cached.ETag, /^"[a-f0-9]{64}"$/);
  assert.equal(dynamicFreightConditionalStatus(cached.ETag, cached.ETag), 304);
  assert.equal(dynamicFreightConditionalStatus(cached.ETag, '"different"'), 200);

  const noStore = dynamicFreightCacheHeaders(body, { noStore: true });
  assert.equal(noStore['Cache-Control'], 'no-store');
  assert.equal(noStore.Age, '0');
  assert.ok(noStore.ETag);
});

test('Dynamic Freight documented no-coverage error is HTTP 400 while other quote failures are HTTP 500', () => {
  assert.deepEqual(dynamicFreightErrorResponse(3, 'Sin cobertura'), {
    statusCode: 400,
    body: { message: 'Sin cobertura', error_code: 3 },
  });
  assert.deepEqual(dynamicFreightErrorResponse(1, 'Sin stock'), {
    statusCode: 500,
    body: { message: 'Sin stock', error_code: 1 },
  });
  assert.deepEqual(dynamicFreightErrorResponse(-1, 'Error interno'), {
    statusCode: 500,
    body: { message: 'Error interno', error_code: -1 },
  });
});
