import { createHash } from 'node:crypto';
import {
  FINAL_SHIPMENT_STATUSES,
  IntegrationGatedError,
  UnsupportedCapabilityError,
  type CanonicalShipmentStatus,
  type CarrierCapability,
  type CarrierConnection,
  type DeliveryMode,
  type PaymentMode,
  type ProviderShipmentResult,
  type QuoteInput,
  type QuoteResult,
  type Shipment,
  type ShipmentCreateInput,
  type TrackingEventInput,
} from './domain.js';
import type { CourierAdapter, SecretProvider } from './ports.js';

type JsonRecord = Record<string, unknown>;

const OFFICIAL_PROTOCOL = 'starken-plugin-gateway-v1';
const OFFICIAL_BASE_URL = 'https://gateway.starken.cl/externo/integracion';
const SUPPORTED_CAPABILITIES = new Set<CarrierCapability>(['quote', 'create_shipment', 'tracking']);
const CANONICAL_STATUSES = new Set<CanonicalShipmentStatus>([
  'created', 'label_ready', 'pickup_scheduled', 'picked_up', 'in_transit', 'at_branch', 'out_for_delivery',
  'delivery_attempt_failed', 'address_issue', 'receiver_absent', 'returning_to_sender', 'delivered',
  'not_delivered', 'cancelled',
]);

function gated(message: string, details?: JsonRecord): IntegrationGatedError {
  return new IntegrationGatedError(message, { provider: 'starken', protocol: OFFICIAL_PROTOCOL, ...details });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw gated(`Starken field ${field} must be a non-empty scalar`);
}

function finiteNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw gated(`Starken field ${field} must be numeric`);
  return parsed;
}

function positiveProviderCode(value: unknown, field: string): number {
  const parsed = Number(scalar(value, field));
  if (!Number.isInteger(parsed) || parsed <= 0) throw gated(`Starken field ${field} must be a positive DLS code`);
  return parsed;
}

function optionalConfigString(connection: CarrierConnection, key: string): string | undefined {
  const value = connection.config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.endsWith('.localhost');
}

function baseUrlFor(connection: CarrierConnection): URL {
  const override = optionalConfigString(connection, 'testBaseUrl');
  if (!override) return new URL(OFFICIAL_BASE_URL);
  let url: URL;
  try { url = new URL(override); } catch { throw gated('Starken testBaseUrl is invalid'); }
  if (url.username || url.password) throw gated('Starken testBaseUrl cannot contain credentials');
  if (!isLoopback(url.hostname)) throw gated('Starken testBaseUrl is only allowed on loopback test environments');
  return url;
}

function endpointUrl(base: URL, path: string): URL {
  if (!path.startsWith('/')) throw gated('Starken official path must be absolute within the configured base path');
  const url = new URL(base.toString());
  const prefix = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${prefix}${path}`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url;
}

function capabilitiesOf(connection: CarrierConnection): ReadonlySet<CarrierCapability> {
  const raw = connection.config.capabilities;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((value): value is CarrierCapability => typeof value === 'string' && SUPPORTED_CAPABILITIES.has(value as CarrierCapability)));
}

function requireCapability(connection: CarrierConnection, capability: CarrierCapability): void {
  if (!capabilitiesOf(connection).has(capability)) throw new UnsupportedCapabilityError('starken', capability);
}

function deliveryFromProvider(raw: unknown): DeliveryMode {
  const value = scalar(raw, 'alternativas.entrega').toUpperCase();
  if (value === 'DOMICILIO') return 'home';
  if (value === 'AGENCIA' || value === 'SUCURSAL') return 'agency';
  throw gated('Starken quote returned an unknown delivery mode', { rawDeliveryMode: value });
}

function paymentFromProvider(raw: unknown): PaymentMode {
  const code = Number(scalar(raw, 'alternativas.codigo_tipo_pago'));
  if (code === 2) return 'sender_prepaid';
  if (code === 3) return 'recipient_pay';
  throw gated('Starken quote returned an unknown payment mode', { rawPaymentCode: code });
}

function deliveryCode(mode: DeliveryMode): string {
  return mode === 'home' ? '2' : '1';
}

function paymentCode(mode: PaymentMode): number {
  return mode === 'sender_prepaid' ? 2 : 3;
}

function serviceCodeFor(connection: CarrierConnection, serviceCode: string): string {
  const normalized = serviceCode.trim().toUpperCase();
  const configured = connection.config.serviceCodeMap;
  if (isRecord(configured)) {
    const mapped = configured[normalized];
    if (typeof mapped === 'string' && mapped.trim()) return mapped.trim();
    if (typeof mapped === 'number' && Number.isFinite(mapped)) return String(mapped);
  }
  if (normalized === 'NORMAL') return '0';
  throw gated('Starken service code has no verified DLS mapping', { serviceCode: normalized });
}

function trackingStatusMap(connection: CarrierConnection): Map<string, CanonicalShipmentStatus> {
  const raw = connection.config.trackingStatusMap;
  if (!isRecord(raw)) throw gated('Starken tracking requires explicit trackingStatusMap before network access');
  const result = new Map<string, CanonicalShipmentStatus>();
  for (const [providerStatus, canonical] of Object.entries(raw)) {
    if (typeof canonical !== 'string' || !CANONICAL_STATUSES.has(canonical as CanonicalShipmentStatus)) {
      throw gated('Starken trackingStatusMap contains an invalid canonical status', { providerStatus });
    }
    result.set(providerStatus.trim().toUpperCase(), canonical as CanonicalShipmentStatus);
  }
  return result;
}

function requireRecipient(input: ShipmentCreateInput): NonNullable<ShipmentCreateInput['recipient']> {
  const recipient = input.recipient;
  if (!recipient) throw gated('Starken shipment requires recipient data before network access');
  for (const field of ['taxId', 'firstName', 'lastName', 'phone', 'email'] as const) {
    const value = recipient[field];
    if (typeof value !== 'string' || !value.trim()) throw gated(`Starken recipient.${field} is required before network access`);
  }
  return recipient;
}

function requiredAddress(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw gated(`Starken ${field} is required before network access`);
  return value.trim();
}

function issuanceDescription(input: ShipmentCreateInput): string {
  const fromMetadata = isRecord(input.metadata) && typeof input.metadata.contentsDescription === 'string'
    ? input.metadata.contentsDescription.trim()
    : '';
  return (fromMetadata || input.externalOrderId).slice(0, 200);
}

function asOptionalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isOfficialStarkenProtocol(connection: CarrierConnection): boolean {
  return connection.config.protocol === OFFICIAL_PROTOCOL;
}

export class OfficialStarkenPluginAdapter implements CourierAdapter {
  readonly provider = 'starken' as const;

  constructor(private readonly secrets: SecretProvider) {}

  capabilities(connection: CarrierConnection): ReadonlySet<CarrierCapability> {
    return capabilitiesOf(connection);
  }

  async quote(input: QuoteInput, connection: CarrierConnection): Promise<QuoteResult> {
    requireCapability(connection, 'quote');
    const originCode = positiveProviderCode(input.origin.providerCityCode, 'origin.providerCityCode');
    const destinationCode = positiveProviderCode(input.destination.providerCityCode, 'destination.providerCityCode');
    const body: JsonRecord = {
      origen: originCode,
      destino: destinationCode,
      bulto: 'BULTO',
      alto: input.package.heightCm,
      ancho: input.package.widthCm,
      largo: input.package.lengthCm,
      kilos: input.package.weightKg,
      todas_alternativas: true,
    };
    const checkingAccount = optionalConfigString(connection, 'checkingAccount');
    if (checkingAccount) {
      const [number, dv] = checkingAccount.split('-');
      if (number && dv) {
        body.ctacte = number;
        body.ctacte_dv = dv;
      }
    }

    const response = await this.request(connection, '/quote/cotizador-multiple', 'POST', body);
    if (!isRecord(response) || !Array.isArray(response.alternativas)) throw gated('Starken quote response does not contain alternativas[]');
    const candidates: QuoteResult[] = [];
    for (const [index, raw] of response.alternativas.entries()) {
      if (!isRecord(raw)) throw gated('Starken quote alternative must be an object', { index });
      const deliveryMode = deliveryFromProvider(raw.entrega);
      const paymentMode = paymentFromProvider(raw.codigo_tipo_pago);
      if (input.deliveryPreference && input.deliveryPreference !== 'any' && input.deliveryPreference !== deliveryMode) continue;
      if (input.paymentMode && input.paymentMode !== paymentMode) continue;
      const amount = finiteNumber(raw.precio, 'alternativas.precio');
      if (amount < 0) throw gated('Starken quote returned a negative price');
      const serviceCode = scalar(raw.servicio, 'alternativas.servicio').toUpperCase();
      candidates.push({
        provider: 'starken',
        serviceCode,
        serviceName: serviceCode,
        currency: 'CLP',
        amount,
        estimatedBusinessDays: null,
        chargeableWeightKg: input.package.weightKg,
        snapshotVersion: null,
        source: 'live',
        deliveryMode,
        paymentMode,
      });
    }
    candidates.sort((a, b) => a.amount - b.amount || a.serviceCode.localeCompare(b.serviceCode));
    const selected = candidates[0];
    if (!selected) throw gated('Starken quote returned no alternative compatible with requested delivery/payment');
    return selected;
  }

  async createShipment(input: ShipmentCreateInput, connection: CarrierConnection): Promise<ProviderShipmentResult> {
    requireCapability(connection, 'create_shipment');
    const recipient = requireRecipient(input);
    if (!input.deliveryMode) throw gated('Starken shipment requires deliveryMode before network access');
    if (!input.paymentMode) throw gated('Starken shipment requires paymentMode before network access');
    if (!input.serviceCode) throw gated('Starken shipment requires serviceCode before network access');
    if (input.declaredValueClp == null || !Number.isFinite(input.declaredValueClp) || input.declaredValueClp < 0) {
      throw gated('Starken shipment requires a non-negative declaredValueClp before network access');
    }
    const originAgency = requiredAddress(input.origin.providerAgencyCode ?? optionalConfigString(connection, 'originAgencyCode'), 'origin provider agency code');
    const destinationCommune = positiveProviderCode(input.destination.providerCommuneCode, 'destination.providerCommuneCode');
    const destinationAgency = input.deliveryMode === 'agency'
      ? requiredAddress(input.destination.providerAgencyCode, 'destination.providerAgencyCode')
      : undefined;
    const street = requiredAddress(input.destination.street, 'destination.street');
    const number = requiredAddress(input.destination.number, 'destination.number');
    const description = issuanceDescription(input);

    const encargos: JsonRecord[] = [{
      descripcion: description,
      tipo_encargo: 'BULTO',
      kilos: input.package.weightKg,
      alto: input.package.heightCm,
      ancho: input.package.widthCm,
      largo: input.package.lengthCm,
    }];
    if (input.declaredValueClp >= 50_000) {
      encargos.push({
        tipo_documento: { id: 6, codigo_dls: '1686', nombre: 'Orden de compra', descripcion: 'Orden de compra' },
        tipo_encargo: 'DOCUMENTO',
        numero_documento: input.externalOrderId,
        descripcion: description,
      });
    }

    const body: JsonRecord = {
      codigo_agencia_origen: originAgency,
      ...(destinationAgency ? { codigo_agencia_destino: destinationAgency } : {}),
      destinatario_rut: recipient.taxId!.trim(),
      destinatario_nombres: recipient.firstName.trim(),
      destinatario_paterno: recipient.lastName.trim(),
      destinatario_telefono: recipient.phone.trim(),
      destinatario_email: recipient.email.trim(),
      destinatario_contacto: (recipient.contactName || `${recipient.firstName} ${recipient.lastName}`).trim(),
      destinatario_direccion: street,
      destinatario_numeracion: number,
      destinatario_departamento: input.destination.unit?.trim() ?? '',
      destinatario_codigo_comuna: destinationCommune,
      contenido: `#${input.externalOrderId}`,
      valor_declarado: Math.round(input.declaredValueClp),
      tipo_entrega: { codigo_dls: deliveryCode(input.deliveryMode) },
      tipo_pago: { codigo_dls: paymentCode(input.paymentMode) },
      tipo_servicio: { codigo_dls: serviceCodeFor(connection, input.serviceCode) },
      encargos,
    };
    if (input.paymentMode === 'sender_prepaid') {
      const checkingAccount = optionalConfigString(connection, 'checkingAccount');
      const costCenter = optionalConfigString(connection, 'costCenter');
      if (checkingAccount) body.cuenta_corriente = checkingAccount.split('-')[0] || checkingAccount;
      if (costCenter) body.centro_costo = costCenter;
    }

    const response = await this.request(connection, '/emision/emision', 'POST', body);
    if (!isRecord(response)) throw gated('Starken emission response must be an object');
    if ((response.status === 400 || response.status === 500) && typeof response.error === 'string') {
      throw gated('Starken emission was rejected', { providerStatus: response.status });
    }
    const issuanceId = scalar(response.id, 'emision.id');
    const freightRaw = response.orden_flete;
    const freightOrder = freightRaw == null || String(freightRaw) === '0' || String(freightRaw).trim() === '' ? undefined : scalar(freightRaw, 'emision.orden_flete');
    const labelUrl = asOptionalUrl(response.etiqueta);
    const rawState = typeof response.estado === 'string' && response.estado.trim() ? response.estado.trim() : undefined;
    return {
      providerShipmentRef: issuanceId,
      trackingNumber: freightOrder ?? null,
      status: labelUrl ? 'label_ready' : 'created',
      ...(labelUrl ? { labelUrl } : {}),
      metadata: {
        protocol: OFFICIAL_PROTOCOL,
        issuanceId,
        ...(freightOrder ? { freightOrder } : {}),
        ...(rawState ? { rawState } : {}),
      },
    };
  }

  async tracking(shipment: Shipment, connection: CarrierConnection): Promise<TrackingEventInput[]> {
    requireCapability(connection, 'tracking');
    const statusMap = trackingStatusMap(connection);
    let freightOrder = shipment.trackingNumber
      ?? (isRecord(shipment.metadata) && typeof shipment.metadata.freightOrder === 'string' ? shipment.metadata.freightOrder : null);
    if (!freightOrder) {
      const issuance = await this.request(connection, `/emision/consulta/${encodeURIComponent(shipment.providerShipmentRef)}`, 'GET');
      if (!isRecord(issuance)) throw gated('Starken issuance reconciliation response must be an object');
      const raw = issuance.orden_flete;
      if (raw != null && String(raw) !== '0' && String(raw).trim()) freightOrder = scalar(raw, 'consulta.orden_flete');
      if (!freightOrder) return [];
    }

    const response = await this.request(connection, `/tracking/orden-flete/of/${encodeURIComponent(freightOrder)}`, 'GET');
    if (!isRecord(response)) throw gated('Starken tracking response must be an object');
    const history = response.history;
    if (!Array.isArray(history)) return [];
    return history.map((raw, index): TrackingEventInput => {
      if (!isRecord(raw)) throw gated('Starken tracking history item must be an object', { index });
      const rawStatusCode = scalar(raw.status, 'tracking.history.status');
      const canonicalStatus = statusMap.get(rawStatusCode.trim().toUpperCase());
      if (!canonicalStatus) throw gated(`Unknown Starken tracking status: ${rawStatusCode}`, { rawStatusCode });
      const occurredAt = scalar(raw.created_at ?? raw.updated_at, 'tracking.history.created_at');
      if (Number.isNaN(Date.parse(occurredAt))) throw gated('Starken tracking history date is invalid');
      const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null;
      const digest = createHash('sha256')
        .update(`${freightOrder}|${rawStatusCode}|${occurredAt}|${note ?? ''}`)
        .digest('hex')
        .slice(0, 20);
      return {
        tenantId: shipment.tenantId,
        shipmentId: shipment.id,
        providerEventId: `starken:${digest}`,
        canonicalStatus,
        occurredAt,
        rawStatusCode,
        location: null,
        comment: note,
        final: FINAL_SHIPMENT_STATUSES.has(canonicalStatus),
      };
    });
  }

  private async request(connection: CarrierConnection, path: string, method: 'GET' | 'POST', body?: JsonRecord): Promise<unknown> {
    if (!connection.credentialRef) throw gated('Starken connection requires credentialRef before network access');
    const base = baseUrlFor(connection);
    const url = endpointUrl(base, path);
    if (url.origin !== base.origin) throw gated('Starken official request escaped its fixed origin');
    const secret = await this.secrets.resolve(connection.credentialRef);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${secret}`,
          ...(body ? { 'content-type': 'application/json', 'cache-control': 'no-cache' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network';
      throw gated('Starken official request failed before a response was received', { method, path, reason });
    }
    if (!response.ok) throw gated('Starken official request returned a non-success status', { method, path, status: response.status });
    try { return await response.json(); } catch { throw gated('Starken official response was not valid JSON', { method, path }); }
  }
}

export const STARKEN_OFFICIAL_PROTOCOL = OFFICIAL_PROTOCOL;
export const STARKEN_OFFICIAL_BASE_URL = OFFICIAL_BASE_URL;
