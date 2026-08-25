import {
  FINAL_SHIPMENT_STATUSES,
  IntegrationGatedError,
  UnsupportedCapabilityError,
  type CanonicalShipmentStatus,
  type CarrierCapability,
  type CarrierConnection,
  type ProviderShipmentResult,
  type QuoteInput,
  type QuoteResult,
  type Shipment,
  type ShipmentCreateInput,
  type TrackingEventInput,
} from './domain.js';
import type { CourierAdapter, SecretProvider } from './ports.js';

type JsonRecord = Record<string, unknown>;
type HttpMethod = 'GET' | 'POST' | 'PUT';
type AuthMode = 'bearer' | 'basic' | 'header';

type OperationName = 'quote' | 'createShipment' | 'tracking';

interface ContractAuth {
  mode: AuthMode;
  headerName?: string;
  prefix?: string;
}

interface ContractOperation {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  queryTemplate: Record<string, string>;
  bodyTemplate?: unknown;
  response: JsonRecord;
}

interface StarkenContract {
  version: string;
  baseUrl: URL;
  allowedHosts: Set<string>;
  auth: ContractAuth;
  timeoutMs: number;
  statusMap: Map<string, CanonicalShipmentStatus>;
  operations: Partial<Record<OperationName, ContractOperation>>;
}

const canonicalStatuses = new Set<CanonicalShipmentStatus>([
  'created',
  'label_ready',
  'pickup_scheduled',
  'picked_up',
  'in_transit',
  'at_branch',
  'out_for_delivery',
  'delivery_attempt_failed',
  'address_issue',
  'receiver_absent',
  'returning_to_sender',
  'delivered',
  'not_delivered',
  'cancelled',
]);

const unavailableSecrets: SecretProvider = {
  async resolve(reference: string): Promise<string> {
    throw new IntegrationGatedError('Starken credential provider is not configured in this runtime', {
      credentialRef: reference,
    });
  },
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw gated(`Starken contract field ${field} must be an object`);
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw gated(`Starken contract field ${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  return asString(value, field);
}

function gated(message: string, details?: JsonRecord): IntegrationGatedError {
  return new IntegrationGatedError(message, { provider: 'starken', ...details });
}

function parseCapabilities(connection: CarrierConnection): ReadonlySet<CarrierCapability> {
  const raw = connection.config.capabilities;
  if (!Array.isArray(raw)) return new Set();
  const known = new Set<CarrierCapability>(['quote', 'create_shipment', 'tracking']);
  return new Set(raw.filter((value): value is CarrierCapability => typeof value === 'string' && known.has(value as CarrierCapability)));
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.endsWith('.localhost');
}

function safeHeaderName(value: string): string {
  const header = value.trim();
  if (!/^[A-Za-z0-9-]+$/.test(header)) throw gated('Starken auth/header name is invalid');
  const lower = header.toLowerCase();
  if (['cookie', 'set-cookie', 'host', 'content-length', 'proxy-authorization'].includes(lower)) {
    throw gated('Starken contract attempted to configure a forbidden header', { header });
  }
  return header;
}

function parseStringMap(value: unknown, field: string): Record<string, string> {
  if (value == null) return {};
  const raw = asRecord(value, field);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item !== 'string') throw gated(`Starken contract ${field}.${key} must be a string`);
    result[key] = item;
  }
  return result;
}

function parseOperation(value: unknown, name: OperationName): ContractOperation {
  const raw = asRecord(value, `operations.${name}`);
  const methodRaw = asString(raw.method, `operations.${name}.method`).toUpperCase();
  if (!['GET', 'POST', 'PUT'].includes(methodRaw)) throw gated(`Starken ${name} method is not allowed`);
  const path = asString(raw.path, `operations.${name}.path`);
  if (!path.startsWith('/')) throw gated(`Starken ${name} path must be relative to the configured base URL`);
  const headers = parseStringMap(raw.headers, `operations.${name}.headers`);
  for (const key of Object.keys(headers)) {
    const lower = safeHeaderName(key).toLowerCase();
    if (['authorization', 'x-api-key', 'api-key'].includes(lower)) {
      throw gated('Starken operation headers cannot carry authentication secrets');
    }
  }
  const queryTemplate = parseStringMap(raw.queryTemplate, `operations.${name}.queryTemplate`);
  return {
    method: methodRaw as HttpMethod,
    path,
    headers,
    queryTemplate,
    bodyTemplate: raw.bodyTemplate,
    response: asRecord(raw.response, `operations.${name}.response`),
  };
}

function parseContract(connection: CarrierConnection): StarkenContract {
  const raw = asRecord(connection.config.contract, 'contract');
  const version = asString(raw.version, 'contract.version');
  const baseUrlText = asString(raw.baseUrl, 'contract.baseUrl');
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlText);
  } catch {
    throw gated('Starken contract baseUrl is invalid');
  }
  if (baseUrl.username || baseUrl.password) throw gated('Starken contract baseUrl cannot contain credentials');
  if (baseUrl.protocol !== 'https:' && !isLoopback(baseUrl.hostname)) {
    throw gated('Starken contract requires HTTPS outside loopback test environments');
  }

  if (!Array.isArray(raw.allowedHosts) || raw.allowedHosts.length === 0) {
    throw gated('Starken contract allowedHosts must contain at least one host');
  }
  const allowedHosts = new Set(raw.allowedHosts.map((value, index) => asString(value, `contract.allowedHosts[${index}]`).toLowerCase()));
  if (!allowedHosts.has(baseUrl.hostname.toLowerCase())) {
    throw gated('Starken contract baseUrl host is not present in allowedHosts', { host: baseUrl.hostname });
  }

  const authRaw = asRecord(raw.auth, 'contract.auth');
  const mode = asString(authRaw.mode, 'contract.auth.mode') as AuthMode;
  if (!['bearer', 'basic', 'header'].includes(mode)) throw gated('Starken contract auth mode is unsupported');
  const headerName = optionalString(authRaw.headerName, 'contract.auth.headerName');
  if (mode === 'header' && !headerName) throw gated('Starken header auth requires headerName');
  if (headerName) safeHeaderName(headerName);
  const prefix = authRaw.prefix == null ? undefined : String(authRaw.prefix);
  if (prefix && /[\r\n]/.test(prefix)) throw gated('Starken auth prefix is invalid');

  const timeoutRaw = raw.timeoutMs == null ? 10_000 : Number(raw.timeoutMs);
  if (!Number.isInteger(timeoutRaw) || timeoutRaw < 100 || timeoutRaw > 30_000) {
    throw gated('Starken contract timeoutMs must be an integer between 100 and 30000');
  }

  const statusMap = new Map<string, CanonicalShipmentStatus>();
  if (raw.statusMap != null) {
    for (const [providerStatus, canonical] of Object.entries(asRecord(raw.statusMap, 'contract.statusMap'))) {
      if (typeof canonical !== 'string' || !canonicalStatuses.has(canonical as CanonicalShipmentStatus)) {
        throw gated('Starken contract statusMap contains an invalid canonical status', { providerStatus });
      }
      statusMap.set(providerStatus, canonical as CanonicalShipmentStatus);
    }
  }

  const operationsRaw = asRecord(raw.operations, 'contract.operations');
  const operations: Partial<Record<OperationName, ContractOperation>> = {};
  for (const name of ['quote', 'createShipment', 'tracking'] as const) {
    if (operationsRaw[name] != null) operations[name] = parseOperation(operationsRaw[name], name);
  }

  return {
    version,
    baseUrl,
    allowedHosts,
    auth: { mode, headerName, prefix },
    timeoutMs: timeoutRaw,
    statusMap,
    operations,
  };
}

function safePathSegments(path: string): string[] {
  if (path === '') return [];
  const segments = path.split('.');
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment) || ['__proto__', 'prototype', 'constructor'].includes(segment)) {
      throw gated('Starken response mapping path is invalid', { path });
    }
  }
  return segments;
}

function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of safePathSegments(path)) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as JsonRecord)[segment];
  }
  return current;
}

function contextValue(context: JsonRecord, path: string): unknown {
  const value = getPath(context, path);
  if (value === undefined) throw gated('Starken request template references unavailable normalized data', { path });
  return value;
}

const exactPlaceholder = /^\{\{([A-Za-z0-9_.-]+)\}\}$/;
const embeddedPlaceholder = /\{\{([A-Za-z0-9_.-]+)\}\}/g;

function renderTemplate(value: unknown, context: JsonRecord): unknown {
  if (typeof value === 'string') {
    const exact = value.match(exactPlaceholder);
    if (exact) return contextValue(context, exact[1]!);
    if (value.includes('{{')) throw gated('Starken JSON body placeholders must occupy the entire string value');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, context));
  if (isRecord(value)) {
    const rendered: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) rendered[key] = renderTemplate(item, context);
    return rendered;
  }
  return value;
}

function renderPath(value: string, context: JsonRecord): string {
  const rendered = value.replace(embeddedPlaceholder, (_match, key: string) => {
    const resolved = contextValue(context, key);
    if (!['string', 'number', 'boolean'].includes(typeof resolved)) throw gated('Starken URL placeholder must resolve to a scalar', { key });
    return encodeURIComponent(String(resolved));
  });
  if (rendered.includes('{{')) throw gated('Starken URL contains an invalid placeholder');
  return rendered;
}

function scalarString(value: unknown, field: string): string {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw gated(`Starken response field ${field} must be a string or finite number`);
}

function finiteNumber(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw gated(`Starken response field ${field} must be numeric`);
  return number;
}

function mappedPath(mapping: JsonRecord, field: string): string {
  return asString(mapping[field], `response.${field}`);
}

function optionalMappedPath(mapping: JsonRecord, field: string): string | undefined {
  return mapping[field] == null ? undefined : asString(mapping[field], `response.${field}`);
}

function canonicalStatus(contract: StarkenContract, rawStatus: string): CanonicalShipmentStatus {
  const canonical = contract.statusMap.get(rawStatus);
  if (!canonical) throw gated(`Unknown Starken tracking status: ${rawStatus}`, { rawStatus });
  return canonical;
}

function normalizedQuoteContext(input: QuoteInput): JsonRecord {
  return {
    tenantId: input.tenantId,
    origin: input.origin as unknown as JsonRecord,
    destination: input.destination as unknown as JsonRecord,
    package: input.package as unknown as JsonRecord,
  };
}

function normalizedShipmentContext(input: ShipmentCreateInput): JsonRecord {
  return {
    tenantId: input.tenantId,
    externalOrderId: input.externalOrderId,
    marketplaceShipmentId: input.marketplaceShipmentId ?? null,
    origin: input.origin as unknown as JsonRecord,
    destination: input.destination as unknown as JsonRecord,
    package: input.package as unknown as JsonRecord,
    serviceCode: input.serviceCode ?? null,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata ?? {},
  };
}

function normalizedTrackingContext(shipment: Shipment): JsonRecord {
  return {
    tenantId: shipment.tenantId,
    shipmentId: shipment.id,
    externalOrderId: shipment.externalOrderId,
    marketplaceShipmentId: shipment.marketplaceShipmentId,
    providerShipmentRef: shipment.providerShipmentRef,
    trackingNumber: shipment.trackingNumber,
    serviceCode: shipment.serviceCode,
    metadata: shipment.metadata,
  };
}

export class ContractDrivenStarkenAdapter implements CourierAdapter {
  readonly provider = 'starken' as const;

  constructor(private readonly secrets: SecretProvider = unavailableSecrets) {}

  capabilities(connection: CarrierConnection): ReadonlySet<CarrierCapability> {
    return parseCapabilities(connection);
  }

  async quote(input: QuoteInput, connection: CarrierConnection): Promise<QuoteResult> {
    this.requireCapability(connection, 'quote');
    const contract = parseContract(connection);
    const operation = this.requireOperation(contract, 'quote');
    const response = await this.request(connection, contract, operation, normalizedQuoteContext(input), 'quote');
    const mapping = operation.response;
    const items = getPath(response, mappedPath(mapping, 'itemsPath'));
    if (!Array.isArray(items) || items.length === 0) throw gated('Starken quote response contains no services');

    const quotes = items.map((item, index): QuoteResult => {
      if (!isRecord(item)) throw gated('Starken quote service item must be an object', { index });
      const currencyPath = optionalMappedPath(mapping, 'currencyPath');
      const currency = currencyPath ? scalarString(getPath(item, currencyPath), 'currency') : 'CLP';
      if (currency !== 'CLP') throw gated('Starken quote returned an unsupported currency', { currency });
      const serviceCode = scalarString(getPath(item, mappedPath(mapping, 'serviceCodePath')), 'serviceCode');
      const serviceNamePath = optionalMappedPath(mapping, 'serviceNamePath');
      const serviceName = serviceNamePath ? scalarString(getPath(item, serviceNamePath), 'serviceName') : serviceCode;
      const amount = finiteNumber(getPath(item, mappedPath(mapping, 'amountPath')), 'amount');
      const estimatedBusinessDays = finiteNumber(getPath(item, mappedPath(mapping, 'estimatedBusinessDaysPath')), 'estimatedBusinessDays');
      if (amount < 0 || estimatedBusinessDays < 0) throw gated('Starken quote contains negative values');
      const chargeablePath = optionalMappedPath(mapping, 'chargeableWeightKgPath');
      const chargeableWeightKg = chargeablePath ? finiteNumber(getPath(item, chargeablePath), 'chargeableWeightKg') : input.package.weightKg;
      return {
        provider: 'starken',
        serviceCode,
        serviceName,
        currency: 'CLP',
        amount,
        estimatedBusinessDays,
        chargeableWeightKg,
        snapshotVersion: null,
        source: 'live',
      };
    });
    quotes.sort((a, b) => a.amount - b.amount || a.estimatedBusinessDays - b.estimatedBusinessDays || a.serviceCode.localeCompare(b.serviceCode));
    return quotes[0]!;
  }

  async createShipment(input: ShipmentCreateInput, connection: CarrierConnection): Promise<ProviderShipmentResult> {
    this.requireCapability(connection, 'create_shipment');
    const contract = parseContract(connection);
    const operation = this.requireOperation(contract, 'createShipment');
    const response = await this.request(connection, contract, operation, normalizedShipmentContext(input), 'createShipment');
    const mapping = operation.response;
    const providerShipmentRef = scalarString(getPath(response, mappedPath(mapping, 'providerShipmentRefPath')), 'providerShipmentRef');
    const trackingPath = optionalMappedPath(mapping, 'trackingNumberPath');
    const trackingValue = trackingPath ? getPath(response, trackingPath) : null;
    const trackingNumber = trackingValue == null ? null : scalarString(trackingValue, 'trackingNumber');
    const labelPath = optionalMappedPath(mapping, 'labelUrlPath');
    const labelValue = labelPath ? getPath(response, labelPath) : null;
    const labelUrl = labelValue == null ? undefined : scalarString(labelValue, 'labelUrl');
    const statusPath = optionalMappedPath(mapping, 'statusCodePath');
    const status = statusPath ? canonicalStatus(contract, scalarString(getPath(response, statusPath), 'statusCode')) : 'created';
    return {
      providerShipmentRef,
      trackingNumber,
      status,
      ...(labelUrl ? { labelUrl } : {}),
      metadata: { contractVersion: contract.version },
    };
  }

  async tracking(shipment: Shipment, connection: CarrierConnection): Promise<TrackingEventInput[]> {
    this.requireCapability(connection, 'tracking');
    const contract = parseContract(connection);
    const operation = this.requireOperation(contract, 'tracking');
    const response = await this.request(connection, contract, operation, normalizedTrackingContext(shipment), 'tracking');
    const mapping = operation.response;
    const events = getPath(response, mappedPath(mapping, 'eventsPath'));
    if (!Array.isArray(events)) throw gated('Starken tracking response events must be an array');
    return events.map((event, index): TrackingEventInput => {
      if (!isRecord(event)) throw gated('Starken tracking event must be an object', { index });
      const providerEventId = scalarString(getPath(event, mappedPath(mapping, 'providerEventIdPath')), 'providerEventId');
      const rawStatusCode = scalarString(getPath(event, mappedPath(mapping, 'statusCodePath')), 'statusCode');
      const canonical = canonicalStatus(contract, rawStatusCode);
      const occurredAt = scalarString(getPath(event, mappedPath(mapping, 'occurredAtPath')), 'occurredAt');
      if (Number.isNaN(Date.parse(occurredAt))) throw gated('Starken tracking occurredAt is not a valid date');
      const locationPath = optionalMappedPath(mapping, 'locationPath');
      const commentPath = optionalMappedPath(mapping, 'commentPath');
      const locationValue = locationPath ? getPath(event, locationPath) : null;
      const commentValue = commentPath ? getPath(event, commentPath) : null;
      return {
        tenantId: shipment.tenantId,
        shipmentId: shipment.id,
        providerEventId,
        canonicalStatus: canonical,
        occurredAt,
        rawStatusCode,
        location: locationValue == null ? null : scalarString(locationValue, 'location'),
        comment: commentValue == null ? null : scalarString(commentValue, 'comment'),
        final: FINAL_SHIPMENT_STATUSES.has(canonical),
      };
    });
  }

  private requireCapability(connection: CarrierConnection, capability: CarrierCapability): void {
    if (!this.capabilities(connection).has(capability)) throw new UnsupportedCapabilityError('starken', capability);
  }

  private requireOperation(contract: StarkenContract, operation: OperationName): ContractOperation {
    const configured = contract.operations[operation];
    if (!configured) throw gated(`Starken contract does not configure operation ${operation}`);
    return configured;
  }

  private async request(
    connection: CarrierConnection,
    contract: StarkenContract,
    operation: ContractOperation,
    context: JsonRecord,
    operationName: OperationName,
  ): Promise<unknown> {
    if (!connection.credentialRef) throw gated('Starken connection requires credentialRef before network access');

    const renderedPath = renderPath(operation.path, context);
    const url = new URL(renderedPath, contract.baseUrl);
    if (url.origin !== contract.baseUrl.origin || !contract.allowedHosts.has(url.hostname.toLowerCase())) {
      throw gated('Starken operation URL escaped the configured origin/host allowlist');
    }
    for (const [key, template] of Object.entries(operation.queryTemplate)) {
      const rendered = renderTemplate(template, context);
      if (!['string', 'number', 'boolean'].includes(typeof rendered)) throw gated('Starken query template must resolve to scalar values', { key });
      url.searchParams.set(key, String(rendered));
    }

    const secret = await this.secrets.resolve(connection.credentialRef);
    const headers: Record<string, string> = { accept: 'application/json', ...operation.headers };
    switch (contract.auth.mode) {
      case 'bearer':
        headers.authorization = `Bearer ${secret}`;
        break;
      case 'basic':
        headers.authorization = `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`;
        break;
      case 'header':
        headers[contract.auth.headerName!] = `${contract.auth.prefix ?? ''}${secret}`;
        break;
    }

    let body: string | undefined;
    if (operation.bodyTemplate !== undefined) {
      const renderedBody = renderTemplate(operation.bodyTemplate, context);
      body = JSON.stringify(renderedBody);
      headers['content-type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: operation.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(contract.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network';
      throw gated('Starken request failed before a response was received', { operation: operationName, reason });
    }
    if (!response.ok) {
      throw gated('Starken request returned a non-success status', { operation: operationName, status: response.status });
    }
    try {
      return await response.json();
    } catch {
      throw gated('Starken response was not valid JSON', { operation: operationName });
    }
  }
}
