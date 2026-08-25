import type {
  AuditEvent,
  CarrierCapability,
  CarrierConnection,
  CarrierProvider,
  IdempotencyRecord,
  PackagingProfile,
  ProviderShipmentResult,
  QuoteInput,
  QuoteResult,
  SellerConnection,
  Shipment,
  ShipmentCreateInput,
  TariffSnapshot,
  Tenant,
  TrackingEvent,
  TrackingEventInput,
} from './domain.js';

export interface SecretProvider {
  resolve(reference: string): Promise<string>;
}

export interface CourierAdapter {
  readonly provider: CarrierProvider;
  capabilities(connection: CarrierConnection): ReadonlySet<CarrierCapability>;
  quote(input: QuoteInput, connection: CarrierConnection): Promise<QuoteResult>;
  createShipment(
    input: ShipmentCreateInput,
    connection: CarrierConnection,
  ): Promise<ProviderShipmentResult>;
  tracking?(shipment: Shipment, connection: CarrierConnection): Promise<TrackingEventInput[]>;
}

export interface MarketplaceAdapter {
  readonly provider: 'mercadolibre';
  fetchOrder(connection: SellerConnection, orderId: string): Promise<Record<string, unknown>>;
  publishCustomTracking(
    connection: SellerConnection,
    shipmentId: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
  publishMe1Tracking(
    connection: SellerConnection,
    shipmentId: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export interface Store {
  close(): void;

  createTenant(tenant: Tenant): Tenant;
  getTenant(tenantId: string): Tenant | null;

  createCarrierConnection(connection: CarrierConnection): CarrierConnection;
  getCarrierConnection(tenantId: string, provider: CarrierProvider): CarrierConnection | null;
  listCarrierConnections(tenantId: string): CarrierConnection[];

  createSellerConnection(connection: SellerConnection): SellerConnection;
  getSellerConnection(tenantId: string, sellerId: string): SellerConnection | null;
  listSellerConnections(tenantId: string): SellerConnection[];

  createPackagingProfile(profile: PackagingProfile): PackagingProfile;
  listPackagingProfiles(tenantId: string): PackagingProfile[];

  createTariffSnapshot(snapshot: TariffSnapshot): TariffSnapshot;
  getActiveTariffSnapshot(tenantId: string, provider: CarrierProvider): TariffSnapshot | null;

  createShipment(shipment: Shipment): Shipment;
  getShipment(tenantId: string, shipmentId: string): Shipment | null;
  updateShipmentStatus(
    tenantId: string,
    shipmentId: string,
    status: Shipment['status'],
    updatedAt: string,
  ): Shipment;

  getTrackingEventByProviderId(
    tenantId: string,
    shipmentId: string,
    providerEventId: string,
  ): TrackingEvent | null;
  appendTrackingEvent(event: TrackingEvent): TrackingEvent;
  listTrackingEvents(tenantId: string, shipmentId: string): TrackingEvent[];

  getIdempotency(tenantId: string, key: string): IdempotencyRecord | null;
  reserveIdempotency(tenantId: string, key: string, now: string): IdempotencyRecord;
  completeIdempotency(
    tenantId: string,
    key: string,
    response: Record<string, unknown>,
    now: string,
  ): IdempotencyRecord;
  failIdempotency(tenantId: string, key: string, now: string): IdempotencyRecord;

  appendAudit(event: AuditEvent): AuditEvent;
  listAudit(tenantId: string, limit?: number): AuditEvent[];
}
