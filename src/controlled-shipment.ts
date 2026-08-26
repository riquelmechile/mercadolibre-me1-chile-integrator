import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError, type CarrierProvider, type ShipmentCreateInput } from './domain.js';

interface ControlledWindow {
  tenantId: string;
  provider: CarrierProvider;
  secretSha256: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ControlledShipmentPreview extends ControlledWindow {
  previewId: string;
}

export interface ControlledShipmentApproval extends ControlledWindow {
  approvalId: string;
  payloadSha256: string;
}

export interface ControlledShipmentObservation extends ControlledWindow {
  observationId: string;
  shipmentId: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_WINDOW_TTL_MS = 60 * 60 * 1000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function denied(): AppError {
  return new AppError('controlled_approval_denied', 'Controlled shipment authorization rejected', 403);
}

function validateWindow(value: ControlledWindow, label: string): void {
  if (!value.tenantId.trim()) throw new Error(`${label} tenantId is required`);
  if (!value.provider) throw new Error(`${label} provider is required`);
  if (!SHA256_HEX.test(value.secretSha256)) throw new Error(`${label} secretSha256 must be a lowercase SHA-256 hex digest`);
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (Number.isNaN(issuedAt)) throw new Error(`${label} issuedAt must be a valid timestamp`);
  if (Number.isNaN(expiresAt)) throw new Error(`${label} expiresAt must be a valid timestamp`);
  if (expiresAt <= issuedAt) throw new Error(`${label} expiry must be after issuance`);
  if (expiresAt - issuedAt > MAX_WINDOW_TTL_MS) throw new Error(`${label} TTL must not exceed 60 minutes`);
}

function assertWindow(value: ControlledWindow, tenantId: string, provider: CarrierProvider, secret: string | undefined, now: number): void {
  if (now < Date.parse(value.issuedAt) || now >= Date.parse(value.expiresAt)) throw denied();
  if (tenantId !== value.tenantId || provider !== value.provider) throw denied();
  if (!secret) throw denied();
  const actual = Buffer.from(sha256(secret), 'hex');
  const expected = Buffer.from(value.secretSha256, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw denied();
}

export function controlledShipmentPayloadSha256(input: ShipmentCreateInput): string {
  return sha256(JSON.stringify(canonical(input)));
}

export function validateControlledShipmentPreview(value: ControlledShipmentPreview): ControlledShipmentPreview {
  if (!value.previewId.trim()) throw new Error('controlled shipment previewId is required');
  validateWindow(value, 'controlled shipment preview');
  return value;
}

export function validateControlledShipmentObservation(value: ControlledShipmentObservation): ControlledShipmentObservation {
  if (!value.observationId.trim()) throw new Error('controlled shipment observationId is required');
  if (!value.shipmentId.trim()) throw new Error('controlled shipment observation shipmentId is required');
  validateWindow(value, 'controlled shipment observation');
  return value;
}

export function validateControlledShipmentApproval(value: ControlledShipmentApproval): ControlledShipmentApproval {
  if (!value.approvalId.trim()) throw new Error('controlled shipment approvalId is required');
  validateWindow(value, 'controlled shipment approval');
  if (!SHA256_HEX.test(value.payloadSha256)) throw new Error('controlled shipment payloadSha256 must be a lowercase SHA-256 hex digest');
  return value;
}

export class ControlledShipmentPreviewGate {
  readonly preview: ControlledShipmentPreview;

  constructor(preview: ControlledShipmentPreview) {
    this.preview = validateControlledShipmentPreview(preview);
  }

  assertScope(tenantId: string, provider: CarrierProvider, secret: string | undefined, now = Date.now()): void {
    assertWindow(this.preview, tenantId, provider, secret, now);
  }
}

export class ControlledShipmentGate {
  readonly approval: ControlledShipmentApproval;

  constructor(approval: ControlledShipmentApproval) {
    this.approval = validateControlledShipmentApproval(approval);
  }

  assertShipment(input: ShipmentCreateInput, secret: string | undefined, now = Date.now()): void {
    assertWindow(this.approval, input.tenantId, input.provider, secret, now);
    const actual = Buffer.from(controlledShipmentPayloadSha256(input), 'hex');
    const expected = Buffer.from(this.approval.payloadSha256, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw denied();
  }
}


export class ControlledShipmentObservationGate {
  readonly observation: ControlledShipmentObservation;

  constructor(observation: ControlledShipmentObservation) {
    this.observation = validateControlledShipmentObservation(observation);
  }

  assertScope(tenantId: string, provider: CarrierProvider, shipmentId: string, secret: string | undefined, now = Date.now()): void {
    assertWindow(this.observation, tenantId, provider, secret, now);
    if (shipmentId !== this.observation.shipmentId) throw denied();
  }
}
