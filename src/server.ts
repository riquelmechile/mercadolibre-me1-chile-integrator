import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { AdapterRegistry } from './adapters.js';
import { assertNoInlineSecrets, type AppConfig } from './config.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  newId,
  nowIso,
  type CarrierProvider,
  type CanonicalShipmentStatus,
  type DeliveryMode,
  type DeliveryPreference,
  type PaymentMode,
  type QuoteInput,
  type PackagingProfile,
  type PackagingMatchType,
  type PackingMode,
  type PackagingQuantityRule,
  type AutomaticOrderItem,
  type ShipmentCreateInput,
  type TariffRule,
  type TrackingEventInput,
} from './domain.js';
import { LogisticsService } from './services.js';
import { AutomaticShippingService, PackagingResolver } from './packaging.js';
import { CarrierRoutingResolver, StarkenCatalogSyncService } from './starken-catalog.js';
import type { SecretProvider, Store } from './ports.js';

const providers = new Set<CarrierProvider>(['mock', 'starken', 'blueexpress', 'chilexpress']);
const packagingMatchTypes = new Set<PackagingMatchType>(['sku', 'family', 'default']);
const packingModes = new Set<PackingMode>(['fixed', 'scale_weight_only', 'stack_height', 'stack_length', 'stack_width', 'threshold_growth']);
const deliveryModes = new Set<DeliveryMode>(['home', 'agency']);
const deliveryPreferences = new Set<DeliveryPreference>(['home', 'agency', 'any']);
const paymentModes = new Set<PaymentMode>(['sender_prepaid', 'recipient_pay']);

const statuses = new Set<CanonicalShipmentStatus>([
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

function objectBody(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new AppError('invalid_request', 'JSON object body is required', 400);
  }
  return request.body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('invalid_request', `${key} must be a non-empty string`, 400);
  }
  return value.trim();
}

function requiredObject(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('invalid_request', `${key} must be an object`, 400);
  }
  return value as Record<string, unknown>;
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = Number(body[key]);
  if (!Number.isFinite(value)) throw new AppError('invalid_request', `${key} must be numeric`, 400);
  return value;
}


function optionalEnum<T extends string>(body: Record<string, unknown>, key: string, allowed: ReadonlySet<T>): T | undefined {
  if (body[key] == null) return undefined;
  const value = requiredString(body, key) as T;
  if (!allowed.has(value)) throw new AppError('invalid_request', `${key} is invalid`, 400);
  return value;
}

function optionalNonNegativeNumber(body: Record<string, unknown>, key: string): number | undefined {
  if (body[key] == null) return undefined;
  const value = requiredNumber(body, key);
  if (value < 0) throw new AppError('invalid_request', `${key} cannot be negative`, 400);
  return value;
}

function packagingProfileFromBody(tenantId: string, body: Record<string, unknown>): PackagingProfile {
  const matchTypeRaw = requiredString(body, 'matchType') as PackagingMatchType;
  if (!packagingMatchTypes.has(matchTypeRaw)) throw new AppError('invalid_request', 'matchType is invalid', 400);
  const packingModeRaw = requiredString(body, 'packingMode') as PackingMode;
  if (!packingModes.has(packingModeRaw)) throw new AppError('invalid_request', 'packingMode is invalid', 400);
  const packageSpec = packageOf(body.package);
  const priority = body.priority == null ? 0 : requiredNumber(body, 'priority');
  const maxQuantity = body.maxQuantity == null ? 1 : requiredNumber(body, 'maxQuantity');
  if (!Number.isInteger(priority)) throw new AppError('invalid_request', 'priority must be an integer', 400);
  if (!Number.isInteger(maxQuantity) || maxQuantity <= 0) throw new AppError('invalid_request', 'maxQuantity must be a positive integer', 400);
  let quantityRule: PackagingQuantityRule | null = null;
  if (packingModeRaw === 'threshold_growth') {
    const rawRule = requiredObject(body, 'quantityRule');
    const threshold = requiredNumber(rawRule, 'threshold');
    const fixedLengthCm = requiredNumber(rawRule, 'fixedLengthCm');
    const baseWidthCm = requiredNumber(rawRule, 'baseWidthCm');
    const baseHeightCm = requiredNumber(rawRule, 'baseHeightCm');
    const widthIncrementCm = requiredNumber(rawRule, 'widthIncrementCm');
    const heightIncrementCm = requiredNumber(rawRule, 'heightIncrementCm');
    if (!Number.isInteger(threshold) || threshold < 2) throw new AppError('invalid_request', 'quantityRule.threshold must be an integer >= 2', 400);
    if ([fixedLengthCm, baseWidthCm, baseHeightCm].some((value) => value <= 0)) throw new AppError('invalid_request', 'quantityRule base dimensions must be positive', 400);
    if ([widthIncrementCm, heightIncrementCm].some((value) => value < 0)) throw new AppError('invalid_request', 'quantityRule increments cannot be negative', 400);
    quantityRule = { threshold, fixedLengthCm, baseWidthCm, baseHeightCm, widthIncrementCm, heightIncrementCm };
  } else if (body.quantityRule != null) {
    throw new AppError('invalid_request', 'quantityRule is only valid with threshold_growth', 400);
  }
  const metadata = body.metadata == null ? {} : requiredObject(body, 'metadata');
  try { assertNoInlineSecrets(metadata); } catch (error) {
    throw new AppError('inline_secret_rejected', error instanceof Error ? error.message : 'Inline secret rejected', 400);
  }
  const matchValue = matchTypeRaw === 'default' ? null : requiredString(body, 'matchValue');
  return {
    id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : newId(),
    tenantId,
    name: requiredString(body, 'name'),
    matchType: matchTypeRaw,
    matchValue,
    priority,
    active: body.active !== false,
    package: packageSpec,
    packingMode: packingModeRaw,
    maxQuantity,
    quantityRule,
    metadata,
    createdAt: nowIso(),
  };
}

function providerOf(value: unknown): CarrierProvider {
  if (typeof value !== 'string' || !providers.has(value as CarrierProvider)) {
    throw new AppError('invalid_request', 'provider is invalid', 400);
  }
  return value as CarrierProvider;
}

function addressOf(value: unknown, field: string): QuoteInput['origin'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('invalid_request', `${field} must be an object`, 400);
  }
  const body = value as Record<string, unknown>;
  return {
    region: requiredString(body, 'region'),
    commune: requiredString(body, 'commune'),
    ...(typeof body.postalCode === 'string' ? { postalCode: body.postalCode } : {}),
    ...(body.providerLocationId != null ? { providerLocationId: requiredString(body, 'providerLocationId') } : {}),
    ...(body.providerCityCode != null ? { providerCityCode: requiredString(body, 'providerCityCode') } : {}),
    ...(body.providerCommuneCode != null ? { providerCommuneCode: requiredString(body, 'providerCommuneCode') } : {}),
    ...(body.providerAgencyCode != null ? { providerAgencyCode: requiredString(body, 'providerAgencyCode') } : {}),
    ...(body.street != null ? { street: requiredString(body, 'street') } : {}),
    ...(body.number != null ? { number: requiredString(body, 'number') } : {}),
    ...(body.unit != null ? { unit: requiredString(body, 'unit') } : {}),
  };
}


function recipientOf(value: unknown): import('./domain.js').ShipmentRecipient {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('invalid_request', 'recipient must be an object', 400);
  }
  const body = value as Record<string, unknown>;
  return {
    ...(body.taxId != null ? { taxId: requiredString(body, 'taxId') } : {}),
    firstName: requiredString(body, 'firstName'),
    lastName: requiredString(body, 'lastName'),
    phone: requiredString(body, 'phone'),
    email: requiredString(body, 'email'),
    ...(body.contactName != null ? { contactName: requiredString(body, 'contactName') } : {}),
  };
}

function packageOf(value: unknown): QuoteInput['package'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('invalid_request', 'package must be an object', 400);
  }
  const body = value as Record<string, unknown>;
  const result = {
    weightKg: requiredNumber(body, 'weightKg'),
    lengthCm: requiredNumber(body, 'lengthCm'),
    widthCm: requiredNumber(body, 'widthCm'),
    heightCm: requiredNumber(body, 'heightCm'),
  };
  if (Object.values(result).some((v) => v <= 0)) {
    throw new AppError('invalid_request', 'package dimensions and weight must be positive', 400);
  }
  return result;
}

export interface BuildServerOptions {
  store: Store;
  adapters: AdapterRegistry;
  config: AppConfig;
  secrets?: SecretProvider;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const { store, adapters, config, secrets } = options;
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!loopbackHosts.has(config.host) && !config.apiKey) {
    throw new Error('APP_API_KEY is required when binding outside loopback');
  }
  const logistics = new LogisticsService(store, adapters);
  const packaging = new PackagingResolver(store);
  const routing = new CarrierRoutingResolver(store);
  const automaticShipping = new AutomaticShippingService(store, logistics, packaging, routing);
  const starkenCatalogSync = secrets ? new StarkenCatalogSyncService(store, secrets) : null;
  const app = Fastify({
    logger: { level: config.logLevel, redact: ['req.headers.authorization', '*.token', '*.secret', '*.password'] },
    genReqId: (request) => String(request.headers['x-correlation-id'] ?? newId()),
    bodyLimit: 512 * 1024,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    if (!config.apiKey) return;
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${config.apiKey}`) {
      return reply.status(401).send({ error: 'unauthorized', correlationId: request.id });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        details: error.details,
        correlationId: request.id,
      });
    }
    request.log.error({ err: error }, 'unhandled request error');
    return reply.status(500).send({ error: 'internal_error', correlationId: request.id });
  });

  app.get('/healthz', async () => ({
    ok: true,
    service: 'mercadolibre-me1-chile-integrator',
    version: '0.7.3',
    providers: adapters.providers(),
  }));

  app.get('/readyz', async () => ({ ok: true, me1Certified: config.me1Certified }));

  app.post('/v1/tenants', async (request, reply) => {
    const body = objectBody(request);
    const tenant = store.createTenant({ id: newId(), name: requiredString(body, 'name'), createdAt: nowIso() });
    return reply.status(201).send(tenant);
  });

  app.get('/v1/tenants/:tenantId', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const tenant = store.getTenant(tenantId);
    if (!tenant) throw new NotFoundError('Tenant not found', { tenantId });
    return tenant;
  });

  app.post('/v1/tenants/:tenantId/carriers', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
    const body = objectBody(request);
    const provider = providerOf(body.provider);
    const configValue = body.config == null ? {} : requiredObject(body, 'config');
    try {
      assertNoInlineSecrets(configValue);
    } catch (error) {
      throw new AppError('inline_secret_rejected', error instanceof Error ? error.message : 'Inline secret rejected', 400);
    }
    const connection = store.createCarrierConnection({
      id: newId(),
      tenantId,
      provider,
      credentialRef: typeof body.credentialRef === 'string' ? body.credentialRef : null,
      enabled: body.enabled !== false,
      config: configValue,
      createdAt: nowIso(),
    });
    return reply.status(201).send(connection);
  });

  app.get('/v1/tenants/:tenantId/carriers', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
    return store.listCarrierConnections(tenantId);
  });

  app.post('/v1/tenants/:tenantId/carriers/:provider/catalog/sync', async (request, reply) => {
    const { tenantId, provider: rawProvider } = request.params as { tenantId: string; provider: string };
    const provider = providerOf(rawProvider);
    if (provider !== 'starken') throw new AppError('catalog_sync_not_implemented', 'Catalog sync is not implemented for this provider', 422, { provider });
    const connection = store.getCarrierConnection(tenantId, provider);
    if (!connection) throw new NotFoundError('Carrier connection not found', { tenantId, provider });
    if (!starkenCatalogSync) throw new AppError('integration_gated', 'Runtime secret provider is required for catalog sync', 503, { provider });
    const snapshot = await starkenCatalogSync.sync(connection);
    return reply.status(201).send({
      provider: snapshot.provider,
      version: snapshot.version,
      active: snapshot.active,
      counts: { regions: snapshot.regions.length, cities: snapshot.cities.length, communes: snapshot.communes.length, agencies: snapshot.agencies.length },
      createdAt: snapshot.createdAt,
    });
  });

  app.get('/v1/tenants/:tenantId/carriers/:provider/catalog', async (request) => {
    const { tenantId, provider: rawProvider } = request.params as { tenantId: string; provider: string };
    const provider = providerOf(rawProvider);
    const snapshot = store.getActiveCarrierLocationCatalog(tenantId, provider);
    if (!snapshot) throw new NotFoundError('No active carrier location catalog', { tenantId, provider });
    return {
      provider: snapshot.provider,
      version: snapshot.version,
      active: snapshot.active,
      counts: { regions: snapshot.regions.length, cities: snapshot.cities.length, communes: snapshot.communes.length, agencies: snapshot.agencies.length },
      createdAt: snapshot.createdAt,
    };
  });

  app.post('/v1/tenants/:tenantId/carriers/:provider/routing/resolve', async (request) => {
    const { tenantId, provider: rawProvider } = request.params as { tenantId: string; provider: string };
    const provider = providerOf(rawProvider);
    const body = objectBody(request);
    return routing.resolve({
      tenantId,
      provider,
      address: addressOf(body.address, 'address'),
      ...(optionalEnum(body, 'deliveryMode', deliveryModes) ? { deliveryMode: optionalEnum(body, 'deliveryMode', deliveryModes)! } : {}),
      ...(typeof body.agencyName === 'string' && body.agencyName.trim() ? { agencyName: body.agencyName.trim() } : {}),
      ...(typeof body.agencyCode === 'string' && body.agencyCode.trim() ? { agencyCode: body.agencyCode.trim() } : {}),
      ...(body.package != null ? { package: packageOf(body.package) } : {}),
      ...(body.declaredValueClp != null ? { declaredValueClp: optionalNonNegativeNumber(body, 'declaredValueClp')! } : {}),
    });
  });

  app.post('/v1/tenants/:tenantId/sellers', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
    const body = objectBody(request);
    if (body.marketplace !== 'mercadolibre') {
      throw new AppError('invalid_request', 'Only mercadolibre marketplace is supported in MVP', 400);
    }
    const configValue = body.config == null ? {} : requiredObject(body, 'config');
    try {
      assertNoInlineSecrets(configValue);
    } catch (error) {
      throw new AppError('inline_secret_rejected', error instanceof Error ? error.message : 'Inline secret rejected', 400);
    }
    const seller = store.createSellerConnection({
      id: newId(),
      tenantId,
      marketplace: 'mercadolibre',
      sellerId: requiredString(body, 'sellerId'),
      credentialRef: requiredString(body, 'credentialRef'),
      enabled: body.enabled !== false,
      config: configValue,
      createdAt: nowIso(),
    });
    return reply.status(201).send(seller);
  });

  app.get('/v1/tenants/:tenantId/sellers', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
    return store.listSellerConnections(tenantId);
  });

  app.post('/v1/tenants/:tenantId/packaging-profiles', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
    const profile = packagingProfileFromBody(tenantId, objectBody(request));
    return reply.status(201).send(store.createPackagingProfile(profile));
  });

  app.post('/v1/tenants/:tenantId/packaging-profiles/import', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
    const body = objectBody(request);
    if (!Array.isArray(body.profiles) || body.profiles.length === 0) {
      throw new AppError('invalid_request', 'profiles must be a non-empty array', 400);
    }
    const validated = body.profiles.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('invalid_request', `profiles[${index}] must be an object`, 400);
      return packagingProfileFromBody(tenantId, raw as Record<string, unknown>);
    });
    const created = validated.map((profile) => store.createPackagingProfile(profile));
    return reply.status(201).send({ count: created.length, profiles: created });
  });

  app.get('/v1/tenants/:tenantId/packaging-profiles', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
    return store.listPackagingProfiles(tenantId);
  });

  app.post('/v1/tenants/:tenantId/tariff-snapshots', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
    const body = objectBody(request);
    const provider = providerOf(body.provider);
    const rawRules = body.rules;
    if (!Array.isArray(rawRules) || rawRules.length === 0) {
      throw new AppError('invalid_request', 'rules must be a non-empty array', 400);
    }
    const rules: TariffRule[] = rawRules.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new AppError('invalid_request', `rules[${index}] must be an object`, 400);
      }
      const rule = raw as Record<string, unknown>;
      const currency = requiredString(rule, 'currency');
      if (currency !== 'CLP') throw new AppError('invalid_request', 'MVP tariff currency must be CLP', 400);
      return {
        id: typeof rule.id === 'string' ? rule.id : newId(),
        serviceCode: requiredString(rule, 'serviceCode'),
        serviceName: requiredString(rule, 'serviceName'),
        currency: 'CLP',
        amount: requiredNumber(rule, 'amount'),
        minWeightKg: requiredNumber(rule, 'minWeightKg'),
        maxWeightKg: requiredNumber(rule, 'maxWeightKg'),
        estimatedBusinessDays: requiredNumber(rule, 'estimatedBusinessDays'),
        ...(typeof rule.region === 'string' ? { region: rule.region } : {}),
        ...(typeof rule.commune === 'string' ? { commune: rule.commune } : {}),
        ...(rule.volumetricDivisor != null ? { volumetricDivisor: requiredNumber(rule, 'volumetricDivisor') } : {}),
        ...(optionalEnum(rule, 'deliveryMode', deliveryModes) ? { deliveryMode: optionalEnum(rule, 'deliveryMode', deliveryModes)! } : {}),
        ...(optionalEnum(rule, 'paymentMode', paymentModes) ? { paymentMode: optionalEnum(rule, 'paymentMode', paymentModes)! } : {}),
      };
    });
    const snapshot = store.createTariffSnapshot({
      id: newId(),
      tenantId,
      provider,
      version: requiredString(body, 'version'),
      active: body.active !== false,
      rules,
      createdAt: nowIso(),
    });
    return reply.status(201).send(snapshot);
  });

  app.post('/v1/quotes', async (request) => {
    const body = objectBody(request);
    return logistics.quote({
      tenantId: requiredString(body, 'tenantId'),
      provider: providerOf(body.provider),
      origin: addressOf(body.origin, 'origin'),
      destination: addressOf(body.destination, 'destination'),
      package: packageOf(body.package),
      allowLive: body.allowLive === true,
      ...(optionalEnum(body, 'deliveryPreference', deliveryPreferences) ? { deliveryPreference: optionalEnum(body, 'deliveryPreference', deliveryPreferences)! } : {}),
      ...(optionalEnum(body, 'paymentMode', paymentModes) ? { paymentMode: optionalEnum(body, 'paymentMode', paymentModes)! } : {}),
      ...(body.declaredValueClp != null ? { declaredValueClp: optionalNonNegativeNumber(body, 'declaredValueClp')! } : {}),
    });
  });

  app.post('/v1/automatic-shipments', async (request, reply) => {
    const body = objectBody(request);
    if (!Array.isArray(body.items) || body.items.length === 0) throw new AppError('invalid_request', 'items must be a non-empty array', 400);
    const items: AutomaticOrderItem[] = body.items.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('invalid_request', `items[${index}] must be an object`, 400);
      const item = raw as Record<string, unknown>;
      const quantity = requiredNumber(item, 'quantity');
      if (!Number.isInteger(quantity) || quantity <= 0) throw new AppError('invalid_request', `items[${index}].quantity must be a positive integer`, 400);
      return {
        sku: requiredString(item, 'sku'),
        quantity,
        ...(typeof item.family === 'string' && item.family.trim() ? { family: item.family.trim() } : {}),
      };
    });
    const result = await automaticShipping.create({
      tenantId: requiredString(body, 'tenantId'),
      sellerId: requiredString(body, 'sellerId'),
      externalOrderId: requiredString(body, 'externalOrderId'),
      origin: addressOf(body.origin, 'origin'),
      destination: addressOf(body.destination, 'destination'),
      items,
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      ...(typeof body.marketplaceShipmentId === 'string' ? { marketplaceShipmentId: body.marketplaceShipmentId } : {}),
      ...(body.preferredProvider != null ? { preferredProvider: providerOf(body.preferredProvider) } : {}),
      ...(optionalEnum(body, 'deliveryPreference', deliveryPreferences) ? { deliveryPreference: optionalEnum(body, 'deliveryPreference', deliveryPreferences)! } : {}),
      ...(optionalEnum(body, 'paymentMode', paymentModes) ? { paymentMode: optionalEnum(body, 'paymentMode', paymentModes)! } : {}),
      ...(body.declaredValueClp != null ? { declaredValueClp: optionalNonNegativeNumber(body, 'declaredValueClp')! } : {}),
      ...(body.recipient != null ? { recipient: recipientOf(body.recipient) } : {}),
      ...(typeof body.allowLiveQuotes === 'boolean' ? { allowLiveQuotes: body.allowLiveQuotes } : {}),
      ...(typeof body.routeWithCatalog === 'boolean' ? { routeWithCatalog: body.routeWithCatalog } : {}),
    }, 'automatic', request.id);
    return reply.status(201).send(result);
  });

  app.post('/v1/shipments', async (request, reply) => {
    const body = objectBody(request);
    const input: ShipmentCreateInput = {
      tenantId: requiredString(body, 'tenantId'),
      provider: providerOf(body.provider),
      externalOrderId: requiredString(body, 'externalOrderId'),
      origin: addressOf(body.origin, 'origin'),
      destination: addressOf(body.destination, 'destination'),
      package: packageOf(body.package),
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      ...(typeof body.marketplaceShipmentId === 'string' ? { marketplaceShipmentId: body.marketplaceShipmentId } : {}),
      ...(typeof body.serviceCode === 'string' ? { serviceCode: body.serviceCode } : {}),
      ...(optionalEnum(body, 'deliveryMode', deliveryModes) ? { deliveryMode: optionalEnum(body, 'deliveryMode', deliveryModes)! } : {}),
      ...(optionalEnum(body, 'paymentMode', paymentModes) ? { paymentMode: optionalEnum(body, 'paymentMode', paymentModes)! } : {}),
      ...(body.declaredValueClp != null ? { declaredValueClp: optionalNonNegativeNumber(body, 'declaredValueClp')! } : {}),
      ...(body.recipient != null ? { recipient: recipientOf(body.recipient) } : {}),
    };
    const shipment = await logistics.createShipment(input, 'api', request.id);
    return reply.status(201).send(shipment);
  });

  app.get('/v1/tenants/:tenantId/shipments/:shipmentId', async (request) => {
    const { tenantId, shipmentId } = request.params as { tenantId: string; shipmentId: string };
    const shipment = store.getShipment(tenantId, shipmentId);
    if (!shipment) throw new NotFoundError('Shipment not found', { tenantId, shipmentId });
    return shipment;
  });

  app.post('/v1/tenants/:tenantId/shipments/:shipmentId/tracking-events', async (request, reply) => {
    const { tenantId, shipmentId } = request.params as { tenantId: string; shipmentId: string };
    const body = objectBody(request);
    const status = requiredString(body, 'canonicalStatus') as CanonicalShipmentStatus;
    if (!statuses.has(status)) throw new AppError('invalid_request', 'canonicalStatus is invalid', 400);
    const input: TrackingEventInput = {
      tenantId,
      shipmentId,
      providerEventId: requiredString(body, 'providerEventId'),
      canonicalStatus: status,
      occurredAt: requiredString(body, 'occurredAt'),
      ...(typeof body.canonicalSubstatus === 'string' ? { canonicalSubstatus: body.canonicalSubstatus } : {}),
      ...(typeof body.rawStatusCode === 'string' ? { rawStatusCode: body.rawStatusCode } : {}),
      ...(typeof body.location === 'string' ? { location: body.location } : {}),
      ...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
      ...(typeof body.final === 'boolean' ? { final: body.final } : {}),
    };
    const event = logistics.ingestTracking(input, 'provider', request.id);
    return reply.status(201).send(event);
  });

  app.get('/v1/tenants/:tenantId/shipments/:shipmentId/tracking-events', async (request) => {
    const { tenantId, shipmentId } = request.params as { tenantId: string; shipmentId: string };
    if (!store.getShipment(tenantId, shipmentId)) throw new NotFoundError('Shipment not found', { tenantId, shipmentId });
    return store.listTrackingEvents(tenantId, shipmentId);
  });

  app.get('/v1/tenants/:tenantId/audit', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
    const limit = Number((request.query as { limit?: string }).limit ?? 100);
    return store.listAudit(tenantId, Number.isFinite(limit) ? limit : 100);
  });

  if (config.enableDevRoutes) {
    app.get('/v1/dev/safety', async () => ({
      me1Certified: config.me1Certified,
      liveCarrierMappingsInstalled: false,
      productionCallsInDefaultConfig: false,
    }));
  }

  app.addHook('onClose', async () => {
    store.close();
  });

  return app;
}
