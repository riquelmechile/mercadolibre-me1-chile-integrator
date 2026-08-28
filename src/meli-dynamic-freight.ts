import { createHash } from 'node:crypto';
import { IntegrationGatedError } from './domain.js';

export interface DynamicFreightDimensions {
  length: number;
  width: number;
  height: number;
  weight: number;
}

export interface DynamicFreightItem {
  id: string;
  variation_id: string | number;
  category_id?: string;
  price?: number;
  quantity: number;
  sku: string;
  store_id?: string | number;
  dimensions: DynamicFreightDimensions;
}

export interface DynamicFreightCityLocation {
  type: 'city';
  value: string;
}

export interface DynamicFreightRequest {
  seller_id: string | number;
  buyer_id?: string | number;
  declared_value?: number;
  items: [DynamicFreightItem];
  origin?: DynamicFreightCityLocation;
  destination: DynamicFreightCityLocation;
}

export interface DynamicFreightQuotation {
  price: number;
  handling_time: number;
  shipping_time: number;
  promise: number;
  service: number;
}

export interface DynamicFreightQuoteResponse {
  destinations: string[];
  packages: Array<{
    dimensions: DynamicFreightDimensions;
    items: Array<{
      id: string;
      variation_id: string | number;
      quantity: number;
      dimensions: DynamicFreightDimensions;
    }>;
    quotations: DynamicFreightQuotation[];
  }>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntegrationGatedError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new IntegrationGatedError(`${label} is required`);
  return value.trim();
}

function id(value: unknown, label: string): string | number {
  if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))) return value as string | number;
  throw new IntegrationGatedError(`${label} is required`);
}

function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new IntegrationGatedError(`${label} must be a positive number`);
  }
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new IntegrationGatedError(`${label} must be a non-negative number`);
  }
  return value;
}

function dimensions(value: unknown, label: string): DynamicFreightDimensions {
  const body = record(value, label);
  const result = {
    length: positive(body.length, `${label}.length`),
    width: positive(body.width, `${label}.width`),
    height: positive(body.height, `${label}.height`),
    weight: positive(body.weight, `${label}.weight`),
  };
  if (![result.length, result.width, result.height, result.weight].every(Number.isInteger)) {
    throw new IntegrationGatedError(`${label} must use integer centimeters and integer grams`);
  }
  return result;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  return text(value, label);
}

export function validateDynamicFreightRequest(value: unknown): DynamicFreightRequest {
  const body = record(value, 'dynamic freight request');
  const sellerId = id(body.seller_id, 'seller_id');
  if (!Array.isArray(body.items) || body.items.length !== 1) {
    throw new IntegrationGatedError('Dynamic Freight request must contain exactly one seller item');
  }
  const rawItem = record(body.items[0], 'items[0]');
  const quantity = positive(rawItem.quantity, 'items[0].quantity');
  if (!Number.isInteger(quantity)) throw new IntegrationGatedError('items[0].quantity must be an integer');
  const item: DynamicFreightItem = {
    id: text(rawItem.id, 'items[0].id'),
    variation_id: id(rawItem.variation_id, 'items[0].variation_id'),
    quantity,
    sku: text(rawItem.sku, 'items[0].sku'),
    dimensions: dimensions(rawItem.dimensions, 'items[0].dimensions'),
    ...(optionalText(rawItem.category_id, 'items[0].category_id') ? { category_id: optionalText(rawItem.category_id, 'items[0].category_id')! } : {}),
    ...(rawItem.store_id != null ? { store_id: id(rawItem.store_id, 'items[0].store_id') } : {}),
    ...(rawItem.price != null ? { price: nonNegative(rawItem.price, 'items[0].price') } : {}),
  };
  const cityLocation = (value: unknown, label: string): DynamicFreightCityLocation => {
    const location = record(value, label);
    if (location.type !== 'city') throw new IntegrationGatedError(`${label}.type must be city for MLC`);
    const cityValue = text(location.value, `${label}.value`);
    const separator = cityValue.indexOf('/');
    if (separator <= 0 || separator >= cityValue.length - 1 || cityValue.indexOf('/', separator + 1) !== -1) {
      throw new IntegrationGatedError(`${label}.value must use Region/Commune format`);
    }
    const region = cityValue.slice(0, separator).trim();
    const commune = cityValue.slice(separator + 1).trim();
    if (!region || !commune) throw new IntegrationGatedError(`${label}.value must include both region and commune`);
    return { type: 'city', value: `${region}/${commune}` };
  };
  const destination = cityLocation(body.destination, 'destination');
  return {
    seller_id: sellerId,
    ...(body.buyer_id != null ? { buyer_id: id(body.buyer_id, 'buyer_id') } : {}),
    ...(body.declared_value != null ? { declared_value: positive(body.declared_value, 'declared_value') } : {}),
    items: [item],
    ...(body.origin != null ? { origin: cityLocation(body.origin, 'origin') } : {}),
    destination,
  };
}

function validateQuotation(value: DynamicFreightQuotation, index: number): DynamicFreightQuotation {
  const price = nonNegative(value.price, `quotations[${index}].price`);
  const handling = nonNegative(value.handling_time, `quotations[${index}].handling_time`);
  const shipping = nonNegative(value.shipping_time, `quotations[${index}].shipping_time`);
  const promise = nonNegative(value.promise, `quotations[${index}].promise`);
  if (![handling, shipping, promise].every(Number.isInteger)) {
    throw new IntegrationGatedError(`quotations[${index}] times must be integer business days`);
  }
  if (promise !== handling + shipping) {
    throw new IntegrationGatedError(`quotations[${index}].promise must equal handling_time + shipping_time`);
  }
  if (!Number.isInteger(value.service) || value.service < 0 || value.service > 99) {
    throw new IntegrationGatedError(`quotations[${index}].service must be an integer in range 0..99`);
  }
  return { price, handling_time: handling, shipping_time: shipping, promise, service: value.service };
}

export function buildDynamicFreightQuoteResponse(
  request: DynamicFreightRequest,
  input: { destinations: string[]; quotations: DynamicFreightQuotation[] },
): DynamicFreightQuoteResponse {
  if (!Array.isArray(input.destinations) || input.destinations.length === 0 || input.destinations.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new IntegrationGatedError('At least one Dynamic Freight destination is required');
  }
  if (!Array.isArray(input.quotations) || input.quotations.length === 0) {
    throw new IntegrationGatedError('At least one Dynamic Freight quotation is required');
  }
  const item = request.items[0];
  const quoteDimensions = structuredClone(item.dimensions);
  return {
    destinations: [...new Set(input.destinations.map((entry) => entry.trim()))],
    packages: [{
      // Mercado Libre explicitly requires the integrator to use the consolidated dimensions received in the request.
      // Quantity must therefore never trigger local multiplication/repacking in this contract boundary.
      dimensions: quoteDimensions,
      items: [{
        id: item.id,
        variation_id: item.variation_id,
        quantity: item.quantity,
        dimensions: structuredClone(item.dimensions),
      }],
      quotations: input.quotations.map(validateQuotation),
    }],
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function dynamicFreightCacheHeaders(
  body: DynamicFreightQuoteResponse,
  options: { noStore?: boolean; maxAgeSeconds?: number; ageSeconds?: number },
): Record<'Cache-Control' | 'Age' | 'ETag', string> {
  const etag = `"${createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')}"`;
  if (options.noStore === true) return { 'Cache-Control': 'no-store', Age: '0', ETag: etag };
  const maxAge = options.maxAgeSeconds;
  const age = options.ageSeconds ?? 0;
  if (!Number.isInteger(maxAge) || (maxAge ?? -1) < 0) throw new IntegrationGatedError('Dynamic Freight maxAgeSeconds must be a non-negative integer');
  if (!Number.isInteger(age) || age < 0) throw new IntegrationGatedError('Dynamic Freight ageSeconds must be a non-negative integer');
  return { 'Cache-Control': `private;max-age=${maxAge}`, Age: String(age), ETag: etag };
}

export function dynamicFreightConditionalStatus(etag: string, ifNoneMatch: string | undefined): 200 | 304 {
  return ifNoneMatch === etag ? 304 : 200;
}

export function dynamicFreightErrorResponse(
  errorCode: number,
  message: string,
): { statusCode: 400 | 500; body: { message: string; error_code: number } } {
  if (!Number.isInteger(errorCode)) throw new IntegrationGatedError('Dynamic Freight error_code must be an integer');
  const cleanMessage = text(message, 'message');
  return { statusCode: errorCode === 3 ? 400 : 500, body: { message: cleanMessage, error_code: errorCode } };
}
