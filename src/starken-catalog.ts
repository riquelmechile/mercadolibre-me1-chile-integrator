import { createHash } from 'node:crypto';
import {
  AppError,
  IntegrationGatedError,
  NotFoundError,
  newId,
  nowIso,
  type CarrierCatalogAgency,
  type CarrierCatalogCity,
  type CarrierCatalogCommune,
  type CarrierCatalogRegion,
  type CarrierConnection,
  type CarrierLocationCatalogSnapshot,
  type CarrierRoutingResolution,
  type CarrierRoutingResolveInput,
} from './domain.js';
import type { SecretProvider, Store } from './ports.js';
import {
  STARKEN_OFFICIAL_PROTOCOL,
  starkenOfficialBaseUrlFor,
  starkenOfficialEndpointUrl,
} from './starken-official.js';

type JsonRecord = Record<string, unknown>;

const CATALOG_PATHS = {
  regions: '/agency/region',
  cities: '/agency/city',
  communes: '/agency/comuna',
  agencies: '/agency/agency',
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new IntegrationGatedError(`Starken catalog field ${field} must be a scalar`, { provider: 'starken' });
}

function providerCode(value: unknown, field: string): string {
  const code = scalar(value, field);
  const parsed = Number(code);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new IntegrationGatedError(`Starken catalog field ${field} must be a positive DLS code`, { provider: 'starken' });
  }
  return String(parsed);
}

function optionalSourceId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new IntegrationGatedError(`Starken catalog field ${field} must be an object`, { provider: 'starken' });
  return value;
}

function requiredArray(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new IntegrationGatedError(`Starken ${label} catalog must be a non-empty array`, { provider: 'starken' });
  }
  return value.map((entry, index) => requiredRecord(entry, `${label}[${index}]`));
}

function sortByCode<T extends { providerCode: string; name: string }>(items: T[]): T[] {
  return items.sort((a, b) => Number(a.providerCode) - Number(b.providerCode) || a.name.localeCompare(b.name, 'es'));
}

function normalizeRegions(raw: JsonRecord[]): CarrierCatalogRegion[] {
  return sortByCode(raw.map((entry) => ({
    ...(optionalSourceId(entry.id) ? { sourceId: optionalSourceId(entry.id)! } : {}),
    providerCode: providerCode(entry.code_dls, 'region.code_dls'),
    name: scalar(entry.name, 'region.name'),
    ...(typeof entry.retiro_habilitado === 'boolean' ? { pickupEnabled: entry.retiro_habilitado } : {}),
  })));
}

function normalizeCities(raw: JsonRecord[]): CarrierCatalogCity[] {
  return sortByCode(raw.map((entry) => {
    const region = requiredRecord(entry.region, 'city.region');
    return {
      ...(optionalSourceId(entry.id) ? { sourceId: optionalSourceId(entry.id)! } : {}),
      providerCode: providerCode(entry.code_dls, 'city.code_dls'),
      name: scalar(entry.name, 'city.name'),
      regionCode: providerCode(region.code_dls, 'city.region.code_dls'),
      regionName: scalar(region.name, 'city.region.name'),
      ...(typeof entry.retiro_habilitado === 'boolean' ? { pickupEnabled: entry.retiro_habilitado } : {}),
      ...(typeof entry.destino_indirecto === 'boolean' ? { indirectDestination: entry.destino_indirecto } : {}),
    };
  }));
}

function normalizeCommunes(raw: JsonRecord[]): CarrierCatalogCommune[] {
  return sortByCode(raw.map((entry) => {
    const city = requiredRecord(entry.city, 'commune.city');
    return {
      ...(optionalSourceId(entry.id) ? { sourceId: optionalSourceId(entry.id)! } : {}),
      providerCode: providerCode(entry.code_dls, 'commune.code_dls'),
      name: scalar(entry.name, 'commune.name'),
      cityCode: providerCode(city.code_dls, 'commune.city.code_dls'),
      cityName: scalar(city.name, 'commune.city.name'),
      ...(typeof entry.retiro_habilitado === 'boolean' ? { pickupEnabled: entry.retiro_habilitado } : {}),
    };
  }));
}

function normalizeAgencies(raw: JsonRecord[], communeByCode: Map<string, CarrierCatalogCommune>): CarrierCatalogAgency[] {
  return sortByCode(raw.map((entry) => {
    const communeRaw = requiredRecord(entry.comuna, 'agency.comuna');
    const communeCode = providerCode(communeRaw.code_dls, 'agency.comuna.code_dls');
    const commune = communeByCode.get(communeCode);
    if (!commune) throw new IntegrationGatedError('Starken agency references an unknown commune', { provider: 'starken', communeCode });
    const weightRestriction = optionalString(entry.weight_restriction);
    return {
      ...(optionalSourceId(entry.id) ? { sourceId: optionalSourceId(entry.id)! } : {}),
      providerCode: providerCode(entry.code_dls, 'agency.code_dls'),
      name: scalar(entry.name, 'agency.name'),
      communeCode,
      communeName: commune.name,
      cityCode: commune.cityCode,
      ...(optionalString(entry.address) ? { address: optionalString(entry.address)! } : {}),
      ...(optionalFiniteNumber(entry.latitude) != null ? { latitude: optionalFiniteNumber(entry.latitude)! } : {}),
      ...(optionalFiniteNumber(entry.longitude) != null ? { longitude: optionalFiniteNumber(entry.longitude)! } : {}),
      active: typeof entry.status === 'string' && entry.status.trim().toUpperCase() === 'ACTIVE',
      shipping: entry.shipping === true,
      delivery: entry.delivery === true,
      ...(optionalPositiveNumber(entry.largo_max_agencia) != null ? { maxLengthCm: optionalPositiveNumber(entry.largo_max_agencia)! } : {}),
      ...(optionalPositiveNumber(entry.ancho_max_agencia) != null ? { maxWidthCm: optionalPositiveNumber(entry.ancho_max_agencia)! } : {}),
      ...(optionalPositiveNumber(entry.alto_max_agencia) != null ? { maxHeightCm: optionalPositiveNumber(entry.alto_max_agencia)! } : {}),
      ...(optionalPositiveNumber(entry.valor_max_agencia) != null ? { maxDeclaredValueClp: optionalPositiveNumber(entry.valor_max_agencia)! } : {}),
      ...(weightRestriction ? { weightRestriction } : {}),
    };
  }));
}

function verifyRelations(
  regions: CarrierCatalogRegion[],
  cities: CarrierCatalogCity[],
  communes: CarrierCatalogCommune[],
): void {
  const regionCodes = new Set(regions.map((item) => item.providerCode));
  const cityCodes = new Set(cities.map((item) => item.providerCode));
  for (const city of cities) {
    if (!regionCodes.has(city.regionCode)) {
      throw new IntegrationGatedError('Starken city references an unknown region', { provider: 'starken', cityCode: city.providerCode, regionCode: city.regionCode });
    }
  }
  for (const commune of communes) {
    if (!cityCodes.has(commune.cityCode)) {
      throw new IntegrationGatedError('Starken commune references an unknown city', { provider: 'starken', communeCode: commune.providerCode, cityCode: commune.cityCode });
    }
  }
}

function catalogVersion(catalog: Pick<CarrierLocationCatalogSnapshot, 'regions' | 'cities' | 'communes' | 'agencies'>): string {
  const digest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  return `sha256:${digest}`;
}

function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function normalizeRegionName(value: string): string {
  let result = normalizeName(value).replace(/^REGION\s+/, '');
  result = result.replace(/^(DE|DEL|LA|LAS|LOS)\s+/, '');
  return result;
}

function regionsCompatible(left: string, right: string): boolean {
  const a = normalizeRegionName(left);
  const b = normalizeRegionName(right);
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

function validateAgencyLimits(input: CarrierRoutingResolveInput, agency: CarrierCatalogAgency): void {
  const pkg = input.package;
  if (pkg) {
    const exceeded = [
      agency.maxLengthCm != null && pkg.lengthCm > agency.maxLengthCm ? ['lengthCm', pkg.lengthCm, agency.maxLengthCm] : null,
      agency.maxWidthCm != null && pkg.widthCm > agency.maxWidthCm ? ['widthCm', pkg.widthCm, agency.maxWidthCm] : null,
      agency.maxHeightCm != null && pkg.heightCm > agency.maxHeightCm ? ['heightCm', pkg.heightCm, agency.maxHeightCm] : null,
    ].filter(Boolean) as Array<[string, number, number]>;
    if (exceeded.length > 0) {
      throw new AppError('agency_package_limit_exceeded', 'Carrier agency package limit exceeded', 422, {
        provider: input.provider,
        agencyCode: agency.providerCode,
        exceeded: exceeded.map(([dimension, actual, limit]) => ({ dimension, actual, limit })),
      });
    }
  }
  if (input.declaredValueClp != null && agency.maxDeclaredValueClp != null && input.declaredValueClp > agency.maxDeclaredValueClp) {
    throw new AppError('agency_declared_value_exceeded', 'Carrier agency declared value limit exceeded', 422, {
      provider: input.provider,
      agencyCode: agency.providerCode,
      declaredValueClp: input.declaredValueClp,
      maxDeclaredValueClp: agency.maxDeclaredValueClp,
    });
  }
}

export class StarkenCatalogSyncService {
  constructor(private readonly store: Store, private readonly secrets: SecretProvider) {}

  async sync(connection: CarrierConnection): Promise<CarrierLocationCatalogSnapshot> {
    if (connection.provider !== 'starken') throw new AppError('invalid_provider', 'Starken catalog sync requires a Starken connection', 400);
    if (connection.config.protocol !== STARKEN_OFFICIAL_PROTOCOL) {
      throw new IntegrationGatedError('Starken catalog sync requires the verified official protocol', { provider: 'starken' });
    }
    if (!connection.credentialRef) throw new IntegrationGatedError('Starken catalog sync requires credentialRef', { provider: 'starken' });
    const secret = await this.secrets.resolve(connection.credentialRef);
    const [regionRaw, cityRaw, communeRaw, agencyRaw] = await Promise.all([
      this.get(connection, CATALOG_PATHS.regions, secret),
      this.get(connection, CATALOG_PATHS.cities, secret),
      this.get(connection, CATALOG_PATHS.communes, secret),
      this.get(connection, CATALOG_PATHS.agencies, secret),
    ]);
    const regions = normalizeRegions(requiredArray(regionRaw, 'region'));
    const cities = normalizeCities(requiredArray(cityRaw, 'city'));
    const communes = normalizeCommunes(requiredArray(communeRaw, 'commune'));
    verifyRelations(regions, cities, communes);
    const communeByCode = new Map(communes.map((item) => [item.providerCode, item]));
    const agencies = normalizeAgencies(requiredArray(agencyRaw, 'agency'), communeByCode);
    const normalized = { regions, cities, communes, agencies };
    const snapshot: CarrierLocationCatalogSnapshot = {
      id: newId(),
      tenantId: connection.tenantId,
      provider: 'starken',
      version: catalogVersion(normalized),
      active: true,
      ...normalized,
      createdAt: nowIso(),
    };
    return this.store.createCarrierLocationCatalog(snapshot);
  }

  private async get(connection: CarrierConnection, path: string, secret: string): Promise<unknown> {
    const base = starkenOfficialBaseUrlFor(connection);
    const url = starkenOfficialEndpointUrl(base, path);
    if (url.origin !== base.origin) throw new IntegrationGatedError('Starken catalog request escaped its fixed origin', { provider: 'starken' });
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${secret}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network';
      throw new IntegrationGatedError('Starken catalog request failed before a response was received', { provider: 'starken', path, reason });
    }
    if (!response.ok) throw new IntegrationGatedError('Starken catalog request returned a non-success status', { provider: 'starken', path, status: response.status });
    try { return await response.json(); } catch { throw new IntegrationGatedError('Starken catalog response was not valid JSON', { provider: 'starken', path }); }
  }
}

export class CarrierRoutingResolver {
  constructor(private readonly store: Store) {}

  resolve(input: CarrierRoutingResolveInput): CarrierRoutingResolution {
    const catalog = this.store.getActiveCarrierLocationCatalog(input.tenantId, input.provider);
    if (!catalog) throw new NotFoundError('No active carrier location catalog', { tenantId: input.tenantId, provider: input.provider });
    const communeName = normalizeName(input.address.commune);
    const communeCandidates = catalog.communes.filter((item) => normalizeName(item.name) === communeName);
    let candidates = communeCandidates;
    if (input.address.region.trim()) {
      candidates = communeCandidates.filter((commune) => {
        const city = catalog.cities.find((item) => item.providerCode === commune.cityCode);
        return city ? regionsCompatible(input.address.region, city.regionName) : false;
      });
    }
    if (candidates.length === 0) {
      throw new NotFoundError('Carrier routing commune was not found in active catalog', {
        provider: input.provider,
        region: input.address.region,
        commune: input.address.commune,
      });
    }
    if (candidates.length > 1) {
      throw new AppError('ambiguous_location', 'Carrier routing commune is ambiguous', 422, {
        provider: input.provider,
        commune: input.address.commune,
        matches: candidates.map((item) => item.providerCode),
      });
    }
    const commune = candidates[0]!;
    const city = catalog.cities.find((item) => item.providerCode === commune.cityCode);
    if (!city) throw new AppError('catalog_inconsistent', 'Carrier routing catalog is missing the commune city', 500, { provider: input.provider, communeCode: commune.providerCode });
    const address = {
      ...input.address,
      providerCityCode: city.providerCode,
      providerCommuneCode: commune.providerCode,
    };
    if (input.deliveryMode !== 'agency') {
      if (input.deliveryMode === 'home') {
        delete address.providerAgencyCode;
        delete address.providerLocationId;
      }
      return { catalogVersion: catalog.version, address };
    }
    let agencies = catalog.agencies.filter((item) => item.communeCode === commune.providerCode && item.active && item.delivery);
    const explicitCode = input.agencyCode ?? input.address.providerAgencyCode ?? input.address.providerLocationId;
    if (explicitCode) agencies = agencies.filter((item) => item.providerCode === String(explicitCode));
    if (input.agencyName) {
      const agencyName = normalizeName(input.agencyName);
      agencies = agencies.filter((item) => normalizeName(item.name) === agencyName);
    }
    if (agencies.length === 0) {
      throw new NotFoundError('No eligible carrier agency matches routing request', { provider: input.provider, communeCode: commune.providerCode });
    }
    if (agencies.length > 1) {
      throw new AppError('ambiguous_agency', 'Carrier routing has ambiguous agency selection', 422, {
        provider: input.provider,
        communeCode: commune.providerCode,
        matches: agencies.map((item) => ({ providerCode: item.providerCode, name: item.name })),
      });
    }
    const agency = agencies[0]!;
    validateAgencyLimits(input, agency);
    address.providerAgencyCode = agency.providerCode;
    address.providerLocationId = agency.providerCode;
    return { catalogVersion: catalog.version, address, agency };
  }
}
