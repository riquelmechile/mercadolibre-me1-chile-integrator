import { createHash } from 'node:crypto';
import { CarrierContractHttpError } from './meli-carrier-auth.js';

export interface MercadoEnviosCoverageCity {
  city_id: string;
  city_name: string;
  state_id: string;
  state_name: string;
}

export interface MercadoEnviosAgencyOpenHour {
  from: string;
  to: string;
}

export interface MercadoEnviosAgency {
  agency_id: string;
  agency_name: string;
  business_name?: string;
  agency_type?: 'agency' | 'pickup_point' | 'place';
  is_movable?: boolean;
  phone?: string;
  package_reception: boolean;
  pickup_availability: boolean;
  unlabeled_package_reception?: boolean;
  chain_of_custody?: boolean;
  status: 'active' | 'inactive';
  activation_date?: string;
  deactivation_date?: string;
  volumetric_capacity?: number;
  package_capacity?: number;
  location: {
    country_name: 'Chile';
    state_name: string;
    city_name: string;
    city_id?: string;
    neighborhood_name?: string;
    street_name: string;
    street_number: string;
    other_info?: string;
    zip_code?: string;
    geo_location: { latitude: number; longitude: number };
  };
  open_hours: Record<string, readonly MercadoEnviosAgencyOpenHour[] | null>;
  maximum_package_dimensions?: { length?: number; height?: number; width?: number; weight?: number };
}

export interface MercadoEnviosTrackingEvent {
  code: string;
  carrier_code: string;
  payload: {
    date: string;
    location: Record<string, unknown>;
    cost?: number;
    dimensions?: { weight?: number; height?: number; width?: number; length?: number };
    [key: string]: unknown;
  };
}

export interface MercadoEnviosTrackingRecord {
  id: string | number;
  tracking_number: string;
  events: readonly MercadoEnviosTrackingEvent[];
}

export interface MercadoEnviosAuthorizationResponse {
  id: string;
  status: 'AUTHORIZED';
  status_message: 'OK';
  tracking_number: string;
  authorization_information: {
    date: string;
    custom_data: Record<string, unknown>;
  };
}

interface AuthorizationRecord {
  fingerprint: string;
  generation: number;
  cancelled: boolean;
  blocked: boolean;
  response: MercadoEnviosAuthorizationResponse;
}

const FINAL_EVENT_CODES = new Set(['0401', '0607', '0609', '0617', '0619', '0623', '0631']);

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

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CarrierContractHttpError(400, 'bad_request', `${label} is required`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CarrierContractHttpError(400, 'bad_request', `${label} is required`);
  return value.trim();
}

function validateAuthorizationPayload(shipmentId: string, value: unknown): Record<string, unknown> {
  const body = requiredObject(value, 'authorization payload');
  if (body.id == null || String(body.id) !== shipmentId) {
    throw new CarrierContractHttpError(400, 'bad_request', 'authorization id must match shipment id');
  }
  requiredText(body.transport_order_id, 'transport_order_id');
  const shipment = requiredObject(body.shipment_information, 'shipment_information');
  requiredObject(shipment.sender, 'shipment_information.sender');
  requiredObject(shipment.receiver, 'shipment_information.receiver');
  const packageNode = requiredObject(shipment.package, 'shipment_information.package');
  requiredObject(packageNode.dimensions, 'shipment_information.package.dimensions');
  if (!Array.isArray(packageNode.items)) throw new CarrierContractHttpError(400, 'bad_request', 'shipment_information.package.items is required');
  return body;
}

function validateOpenHours(openHours: MercadoEnviosAgency['open_hours']): void {
  if (!openHours || typeof openHours !== 'object') throw new Error('Carrier agency open_hours is required');
  for (const [day, windows] of Object.entries(openHours)) {
    if (windows == null) continue;
    if (!Array.isArray(windows)) throw new Error(`Carrier agency open_hours.${day} must be an array or null`);
    for (const window of windows) {
      if (!/^\d{2}:\d{2}$/.test(window.from) || !/^\d{2}:\d{2}$/.test(window.to) || window.to <= window.from) {
        throw new Error(`Carrier agency open_hours.${day} contains an invalid window`);
      }
    }
  }
}

export function validateMercadoEnviosTracking(records: readonly MercadoEnviosTrackingRecord[]): void {
  for (const record of records) {
    if (record.id == null || !record.tracking_number) throw new Error('Tracking fixture requires id and tracking_number');
    let finalSeen = false;
    let previousTime = -Infinity;
    for (const event of record.events) {
      if (finalSeen) throw new Error('Tracking event exists after a final event');
      if (!event.code || !event.carrier_code || !event.payload || !event.payload.date || !event.payload.location) {
        throw new Error('Tracking fixture event requires code, carrier_code, payload.date and payload.location');
      }
      const occurred = Date.parse(event.payload.date);
      if (!Number.isFinite(occurred)) throw new Error(`Tracking event ${event.code} date is invalid`);
      if (occurred < previousTime) throw new Error('Tracking fixture events must be chronological');
      previousTime = occurred;
      if (event.code === '0260') {
        const dimensions = event.payload.dimensions;
        if (typeof event.payload.cost !== 'number' || !dimensions ||
            !['weight', 'height', 'width', 'length'].every((key) => typeof dimensions[key as keyof typeof dimensions] === 'number')) {
          throw new Error('0260 conciliation requires explicit cost and measured dimensions');
        }
      }
      const location = event.payload.location as Record<string, unknown>;
      const geolocationTypes = new Set(['APPROXIMATE', 'GEOMETRIC_CENTER', 'RANGE_INTERPOLATED', 'ROOFTOP', 'UNKNOWN']);
      const requireGeolocation = (code: string): void => {
        const geo = location.geolocation;
        if (!geo || typeof geo !== 'object' || Array.isArray(geo)) throw new Error(`${code} tracking event requires location.geolocation`);
        const type = (geo as Record<string, unknown>).geolocation_type;
        if (typeof type !== 'string' || !geolocationTypes.has(type)) throw new Error(`${code} tracking event has invalid geolocation_type`);
      };
      if (event.code === '0271' || event.code === '0273') {
        const facility = location.facility;
        if (!facility || typeof facility !== 'object' || Array.isArray(facility) || Object.keys(facility as Record<string, unknown>).length === 0) {
          throw new Error(`${event.code} tracking event requires location.facility`);
        }
        requireGeolocation(event.code);
      }
      if (event.code === '0227') requireGeolocation(event.code);
      if (event.code === '0401') {
        const proof = event.payload.proof_of_delivery;
        if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new Error('0401 tracking event requires proof_of_delivery');
        const proofRecord = proof as Record<string, unknown>;
        const document = proofRecord.receiver_document;
        if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('0401 proof_of_delivery requires receiver_document');
        const documentType = (document as Record<string, unknown>).type;
        const documentTypes = new Set(['CI', 'PASSPORT', 'CPF', 'RG', 'CURP', 'INE_IFE', 'LICENCIA', 'RFC', 'RUT', 'CC', 'DNI']);
        if (typeof documentType !== 'string' || !documentTypes.has(documentType)) throw new Error('0401 proof_of_delivery receiver_document.type is invalid');
        if (typeof proofRecord.receiver_name !== 'string' || !proofRecord.receiver_name.trim()) throw new Error('0401 proof_of_delivery requires receiver_name');
        const relationship = proofRecord.receiver_relationship;
        const relationships = new Set(['BUYER', 'FAMILY', 'NEIGHBOUR', 'DOORMAN', 'RECEPTION', 'FRIEND', 'HOLDER', 'OTHER']);
        if (typeof relationship !== 'string' || !relationships.has(relationship)) throw new Error('0401 proof_of_delivery receiver_relationship is invalid');
      }
      if (FINAL_EVENT_CODES.has(event.code)) finalSeen = true;
    }
  }
}

export class MercadoEnviosCarrierContractState {
  private readonly authorizations = new Map<string, AuthorizationRecord>();
  private readonly tracking = new Map<string, MercadoEnviosTrackingRecord>();

  constructor(
    public readonly carrierCode: string,
    public readonly coverage: readonly MercadoEnviosCoverageCity[],
    public readonly agencies: readonly MercadoEnviosAgency[],
    tracking: readonly MercadoEnviosTrackingRecord[],
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {
    if (!carrierCode) throw new Error('carrierCode is required');
    for (const city of coverage) {
      if (!city.city_id || !city.city_name || !city.state_id || !city.state_name) throw new Error('Coverage city fixture is incomplete');
    }
    for (const agency of agencies) {
      if (!agency.agency_id || !agency.agency_name || !agency.location || agency.location.country_name !== 'Chile') {
        throw new Error('Carrier agency fixture is incomplete');
      }
      validateOpenHours(agency.open_hours);
    }
    validateMercadoEnviosTracking(tracking);
    for (const record of tracking) this.tracking.set(`${record.id}\u0000${record.tracking_number}`, structuredClone(record));
  }

  publishCoverage(bodyValue: unknown): Record<string, unknown> {
    const body = requiredObject(bodyValue, 'coverage payload');
    const serviceType = requiredText(body.service_type, 'service_type');
    const direction = requiredText(body.direction, 'direction');
    if (direction !== 'origin' && direction !== 'destination') {
      throw new CarrierContractHttpError(400, 'bad_request', 'direction must be origin or destination');
    }
    return {
      service_type: serviceType,
      direction,
      country_id: 'CL',
      country_name: 'Chile',
      coverage: structuredClone(this.coverage),
    };
  }

  publishAgencies(bodyValue: unknown): { agencies: MercadoEnviosAgency[] } {
    const body = requiredObject(bodyValue, 'agencies payload');
    if (body.country_id !== 'CL') throw new CarrierContractHttpError(400, 'bad_request', 'country_id must be CL');
    return { agencies: structuredClone(this.agencies) as MercadoEnviosAgency[] };
  }

  authorizeShipment(shipmentId: string, bodyValue: unknown): MercadoEnviosAuthorizationResponse {
    const body = validateAuthorizationPayload(shipmentId, bodyValue);
    const nextFingerprint = fingerprint(body);
    const existing = this.authorizations.get(shipmentId);
    if (existing && !existing.cancelled && !existing.blocked) {
      if (existing.fingerprint !== nextFingerprint) {
        throw new CarrierContractHttpError(409, 'authorization_conflict', 'shipment is already authorized with a different payload');
      }
      return structuredClone(existing.response);
    }

    const generation = existing ? existing.generation + 1 : 1;
    const response: MercadoEnviosAuthorizationResponse = {
      id: String(body.id),
      status: 'AUTHORIZED',
      status_message: 'OK',
      tracking_number: `CIT${shipmentId}G${generation}`,
      authorization_information: {
        date: this.nowIso(),
        custom_data: { fixture: true, generation },
      },
    };
    this.authorizations.set(shipmentId, {
      fingerprint: nextFingerprint,
      generation,
      cancelled: false,
      blocked: false,
      response,
    });
    return structuredClone(response);
  }

  cancelAuthorization(shipmentId: string, bodyValue: unknown): Record<string, unknown> {
    const body = requiredObject(bodyValue, 'cancellation payload');
    if (body.status !== 'CANCEL') throw new CarrierContractHttpError(400, 'bad_request', 'cancellation status must be CANCEL');
    const trackingNumber = requiredText(body.tracking_number, 'tracking_number');
    const existing = this.authorizations.get(shipmentId);
    if (!existing || existing.cancelled || existing.blocked || existing.response.tracking_number !== trackingNumber) {
      throw new CarrierContractHttpError(400, 'bad_request', 'authorization/tracking_number is not active');
    }
    existing.cancelled = true;
    return {
      id: existing.response.id,
      status: 'CANCELLED',
      status_message: '',
      tracking_number: trackingNumber,
      authorization_information: { date: this.nowIso(), custom_data: { fixture: true } },
    };
  }

  blockDelivery(shipmentId: string, bodyValue: unknown): Record<string, unknown> {
    const body = requiredObject(bodyValue, 'delivery block payload');
    if (body.status !== 'CANCEL') throw new CarrierContractHttpError(400, 'bad_request', 'delivery block status must be CANCEL');
    const trackingNumber = requiredText(body.tracking_number, 'tracking_number');
    const existing = this.authorizations.get(shipmentId);
    if (!existing || existing.cancelled || existing.blocked || existing.response.tracking_number !== trackingNumber) {
      throw new CarrierContractHttpError(400, 'bad_request', 'authorization/tracking_number is not active');
    }
    existing.blocked = true;
    return {
      id: existing.response.id,
      status: 'CANCELLED',
      status_message: 'BLOCKED',
      tracking_number: trackingNumber,
      authorization_information: { date: this.nowIso(), custom_data: { fixture: true } },
    };
  }

  pullTracking(bodyValue: unknown): MercadoEnviosTrackingRecord[] {
    if (!Array.isArray(bodyValue)) throw new CarrierContractHttpError(400, 'bad_request', 'tracking payload must be an array');
    return bodyValue.map((request, index) => {
      const input = requiredObject(request, `tracking[${index}]`);
      if (input.id == null) throw new CarrierContractHttpError(400, 'bad_request', `tracking[${index}].id is required`);
      const trackingNumber = requiredText(input.tracking_number, `tracking[${index}].tracking_number`);
      const record = this.tracking.get(`${input.id}\u0000${trackingNumber}`);
      return record
        ? structuredClone(record) as MercadoEnviosTrackingRecord
        : { id: input.id as string | number, tracking_number: trackingNumber, events: [] };
    });
  }
}
