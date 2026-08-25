import { randomUUID } from 'node:crypto';

export type CarrierProvider = 'mock' | 'starken' | 'blueexpress' | 'chilexpress';
export type MarketplaceProvider = 'mercadolibre';
export type CarrierCapability =
  | 'quote'
  | 'create_shipment'
  | 'tracking'
  | 'label'
  | 'cancel'
  | 'pickup'
  | 'return'
  | 'pod';

export type CanonicalShipmentStatus =
  | 'created'
  | 'label_ready'
  | 'pickup_scheduled'
  | 'picked_up'
  | 'in_transit'
  | 'at_branch'
  | 'out_for_delivery'
  | 'delivery_attempt_failed'
  | 'address_issue'
  | 'receiver_absent'
  | 'returning_to_sender'
  | 'delivered'
  | 'not_delivered'
  | 'cancelled';

export const FINAL_SHIPMENT_STATUSES = new Set<CanonicalShipmentStatus>([
  'delivered',
  'not_delivered',
  'cancelled',
]);

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}

export interface CarrierConnection {
  id: string;
  tenantId: string;
  provider: CarrierProvider;
  credentialRef: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
}

export interface SellerConnection {
  id: string;
  tenantId: string;
  marketplace: MarketplaceProvider;
  sellerId: string;
  credentialRef: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
}

export interface AddressPoint {
  region: string;
  commune: string;
  postalCode?: string;
}

export interface PackageSpec {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export type PackagingMatchType = 'sku' | 'family' | 'default';
export type PackingMode = 'fixed' | 'scale_weight_only' | 'stack_height' | 'stack_length' | 'stack_width' | 'threshold_growth';

export interface PackagingQuantityRule {
  threshold: number;
  fixedLengthCm: number;
  baseWidthCm: number;
  baseHeightCm: number;
  widthIncrementCm: number;
  heightIncrementCm: number;
}

export interface PackagingProfile {
  id: string;
  tenantId: string;
  name: string;
  matchType: PackagingMatchType;
  matchValue: string | null;
  priority: number;
  active: boolean;
  package: PackageSpec;
  packingMode: PackingMode;
  maxQuantity: number;
  quantityRule?: PackagingQuantityRule | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AutomaticOrderItem {
  sku: string;
  family?: string;
  quantity: number;
}

export interface AutomaticShipmentRequest {
  tenantId: string;
  sellerId: string;
  externalOrderId: string;
  marketplaceShipmentId?: string;
  origin: AddressPoint;
  destination: AddressPoint;
  items: AutomaticOrderItem[];
  preferredProvider?: CarrierProvider;
  idempotencyKey: string;
}

export interface PackagingResolutionItem {
  sku: string;
  family: string | null;
  quantity: number;
  profileId: string;
  profileName: string;
  package: PackageSpec;
}

export interface PackagingResolution {
  package: PackageSpec;
  items: PackagingResolutionItem[];
  profileIds: string[];
}

export interface TariffRule {
  id: string;
  serviceCode: string;
  serviceName: string;
  currency: 'CLP';
  amount: number;
  region?: string;
  commune?: string;
  minWeightKg: number;
  maxWeightKg: number;
  estimatedBusinessDays: number;
  volumetricDivisor?: number;
}

export interface TariffSnapshot {
  id: string;
  tenantId: string;
  provider: CarrierProvider;
  version: string;
  active: boolean;
  rules: TariffRule[];
  createdAt: string;
}

export interface QuoteInput {
  tenantId: string;
  provider: CarrierProvider;
  origin: AddressPoint;
  destination: AddressPoint;
  package: PackageSpec;
  allowLive?: boolean;
}

export interface QuoteResult {
  provider: CarrierProvider;
  serviceCode: string;
  serviceName: string;
  currency: 'CLP';
  amount: number;
  estimatedBusinessDays: number;
  chargeableWeightKg: number;
  snapshotVersion: string | null;
  source: 'snapshot' | 'live' | 'contingency';
}

export interface ShipmentCreateInput {
  tenantId: string;
  provider: CarrierProvider;
  externalOrderId: string;
  marketplaceShipmentId?: string;
  origin: AddressPoint;
  destination: AddressPoint;
  package: PackageSpec;
  serviceCode?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderShipmentResult {
  providerShipmentRef: string;
  trackingNumber: string | null;
  status: CanonicalShipmentStatus;
  labelUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface Shipment {
  id: string;
  tenantId: string;
  provider: CarrierProvider;
  externalOrderId: string;
  marketplaceShipmentId: string | null;
  providerShipmentRef: string;
  trackingNumber: string | null;
  status: CanonicalShipmentStatus;
  serviceCode: string | null;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TrackingEventInput {
  tenantId: string;
  shipmentId: string;
  providerEventId: string;
  canonicalStatus: CanonicalShipmentStatus;
  canonicalSubstatus?: string | null;
  occurredAt: string;
  rawStatusCode?: string | null;
  location?: string | null;
  comment?: string | null;
  final?: boolean;
}

export interface TrackingEvent extends TrackingEventInput {
  id: string;
  receivedAt: string;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: 'ok' | 'error';
  correlationId: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface IdempotencyRecord {
  tenantId: string;
  key: string;
  state: 'pending' | 'completed' | 'failed';
  response: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('not_found', message, 404, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('conflict', message, 409, details);
  }
}

export class IntegrationGatedError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('integration_gated', message, 503, details);
  }
}

export class UnsupportedCapabilityError extends AppError {
  constructor(provider: CarrierProvider, capability: CarrierCapability) {
    super('unsupported_capability', `${provider} does not expose capability ${capability}`, 422, {
      provider,
      capability,
    });
  }
}
