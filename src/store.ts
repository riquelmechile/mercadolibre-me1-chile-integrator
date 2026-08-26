import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AuditEvent,
  CarrierConnection,
  CarrierLocationCatalogSnapshot,
  CarrierProvider,
  IdempotencyRecord,
  PackagingProfile,
  PackingMode,
  PackagingMatchType,
  SellerConnection,
  Shipment,
  TariffSnapshot,
  Tenant,
  TrackingEvent,
} from './domain.js';
import { ConflictError, NotFoundError } from './domain.js';
import type { Store } from './ports.js';

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function asBool(value: unknown): boolean {
  return Number(value) === 1;
}

export class SqliteStore implements Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS carrier_connections (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        credential_ref TEXT,
        enabled INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, provider)
      );

      CREATE TABLE IF NOT EXISTS carrier_location_catalog_snapshots (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        version TEXT NOT NULL,
        active INTEGER NOT NULL,
        regions_json TEXT NOT NULL,
        cities_json TEXT NOT NULL,
        communes_json TEXT NOT NULL,
        agencies_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, provider, version)
      );
      CREATE INDEX IF NOT EXISTS idx_carrier_catalog_active
        ON carrier_location_catalog_snapshots(tenant_id, provider, active);

      CREATE TABLE IF NOT EXISTS seller_connections (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        marketplace TEXT NOT NULL,
        seller_id TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, marketplace, seller_id)
      );

      CREATE TABLE IF NOT EXISTS packaging_profiles (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        match_type TEXT NOT NULL,
        match_value TEXT,
        priority INTEGER NOT NULL,
        active INTEGER NOT NULL,
        package_json TEXT NOT NULL,
        packing_mode TEXT NOT NULL,
        max_quantity INTEGER NOT NULL,
        quantity_rule_json TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_packaging_lookup
        ON packaging_profiles(tenant_id, active, match_type, match_value, priority DESC);

      CREATE TABLE IF NOT EXISTS tariff_snapshots (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        version TEXT NOT NULL,
        active INTEGER NOT NULL,
        rules_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, provider, version)
      );
      CREATE INDEX IF NOT EXISTS idx_tariff_active
        ON tariff_snapshots(tenant_id, provider, active);

      CREATE TABLE IF NOT EXISTS shipments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        external_order_id TEXT NOT NULL,
        marketplace_shipment_id TEXT,
        provider_shipment_ref TEXT NOT NULL,
        tracking_number TEXT,
        status TEXT NOT NULL,
        service_code TEXT,
        idempotency_key TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_shipments_tenant_status
        ON shipments(tenant_id, status);

      CREATE TABLE IF NOT EXISTS tracking_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
        provider_event_id TEXT NOT NULL,
        canonical_status TEXT NOT NULL,
        canonical_substatus TEXT,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        raw_status_code TEXT,
        location TEXT,
        comment TEXT,
        final INTEGER NOT NULL,
        UNIQUE(tenant_id, shipment_id, provider_event_id)
      );

      CREATE TABLE IF NOT EXISTS idempotency_records (
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        state TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, key)
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        result TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_tenant_created
        ON audit_events(tenant_id, created_at DESC);
    `);

    const packagingColumns = this.db.prepare('PRAGMA table_info(packaging_profiles)').all() as Record<string, unknown>[];
    if (!packagingColumns.some((column) => String(column.name) === 'quantity_rule_json')) {
      this.db.exec('ALTER TABLE packaging_profiles ADD COLUMN quantity_rule_json TEXT;');
    }
  }

  createTenant(tenant: Tenant): Tenant {
    this.db.prepare('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)').run(
      tenant.id,
      tenant.name,
      tenant.createdAt,
    );
    return tenant;
  }

  getTenant(tenantId: string): Tenant | null {
    const row = this.db.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId) as
      | Record<string, unknown>
      | undefined;
    return row ? { id: String(row.id), name: String(row.name), createdAt: String(row.created_at) } : null;
  }

  createCarrierConnection(connection: CarrierConnection): CarrierConnection {
    this.db
      .prepare(
        'INSERT INTO carrier_connections(id,tenant_id,provider,credential_ref,enabled,config_json,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        connection.id,
        connection.tenantId,
        connection.provider,
        connection.credentialRef,
        connection.enabled ? 1 : 0,
        JSON.stringify(connection.config),
        connection.createdAt,
      );
    return connection;
  }

  getCarrierConnection(tenantId: string, provider: CarrierProvider): CarrierConnection | null {
    const row = this.db
      .prepare('SELECT * FROM carrier_connections WHERE tenant_id=? AND provider=?')
      .get(tenantId, provider) as Record<string, unknown> | undefined;
    return row ? this.mapCarrier(row) : null;
  }

  listCarrierConnections(tenantId: string): CarrierConnection[] {
    return (this.db
      .prepare('SELECT * FROM carrier_connections WHERE tenant_id=? ORDER BY created_at')
      .all(tenantId) as Record<string, unknown>[]).map((row) => this.mapCarrier(row));
  }

  private mapCarrier(row: Record<string, unknown>): CarrierConnection {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      provider: String(row.provider) as CarrierProvider,
      credentialRef: row.credential_ref == null ? null : String(row.credential_ref),
      enabled: asBool(row.enabled),
      config: parseJson<Record<string, unknown>>(row.config_json),
      createdAt: String(row.created_at),
    };
  }

  createCarrierLocationCatalog(snapshot: CarrierLocationCatalogSnapshot): CarrierLocationCatalogSnapshot {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (snapshot.active) {
        this.db.prepare('UPDATE carrier_location_catalog_snapshots SET active=0 WHERE tenant_id=? AND provider=?')
          .run(snapshot.tenantId, snapshot.provider);
      }
      const existing = this.db.prepare(
        'SELECT * FROM carrier_location_catalog_snapshots WHERE tenant_id=? AND provider=? AND version=?',
      ).get(snapshot.tenantId, snapshot.provider, snapshot.version) as Record<string, unknown> | undefined;
      if (existing) {
        if (snapshot.active) {
          this.db.prepare('UPDATE carrier_location_catalog_snapshots SET active=1 WHERE id=?').run(String(existing.id));
        }
        this.db.exec('COMMIT;');
        return this.mapCarrierLocationCatalog({ ...existing, active: snapshot.active ? 1 : existing.active });
      }
      this.db.prepare(
        'INSERT INTO carrier_location_catalog_snapshots(id,tenant_id,provider,version,active,regions_json,cities_json,communes_json,agencies_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        snapshot.id, snapshot.tenantId, snapshot.provider, snapshot.version, snapshot.active ? 1 : 0,
        JSON.stringify(snapshot.regions), JSON.stringify(snapshot.cities), JSON.stringify(snapshot.communes), JSON.stringify(snapshot.agencies), snapshot.createdAt,
      );
      this.db.exec('COMMIT;');
      return snapshot;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  getActiveCarrierLocationCatalog(tenantId: string, provider: CarrierProvider): CarrierLocationCatalogSnapshot | null {
    const row = this.db.prepare(
      'SELECT * FROM carrier_location_catalog_snapshots WHERE tenant_id=? AND provider=? AND active=1 ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId, provider) as Record<string, unknown> | undefined;
    return row ? this.mapCarrierLocationCatalog(row) : null;
  }

  private mapCarrierLocationCatalog(row: Record<string, unknown>): CarrierLocationCatalogSnapshot {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      provider: String(row.provider) as CarrierProvider,
      version: String(row.version),
      active: asBool(row.active),
      regions: parseJson<CarrierLocationCatalogSnapshot['regions']>(row.regions_json),
      cities: parseJson<CarrierLocationCatalogSnapshot['cities']>(row.cities_json),
      communes: parseJson<CarrierLocationCatalogSnapshot['communes']>(row.communes_json),
      agencies: parseJson<CarrierLocationCatalogSnapshot['agencies']>(row.agencies_json),
      createdAt: String(row.created_at),
    };
  }

  createSellerConnection(connection: SellerConnection): SellerConnection {
    this.db
      .prepare(
        'INSERT INTO seller_connections(id,tenant_id,marketplace,seller_id,credential_ref,enabled,config_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        connection.id,
        connection.tenantId,
        connection.marketplace,
        connection.sellerId,
        connection.credentialRef,
        connection.enabled ? 1 : 0,
        JSON.stringify(connection.config),
        connection.createdAt,
      );
    return connection;
  }

  getSellerConnection(tenantId: string, sellerId: string): SellerConnection | null {
    const row = this.db
      .prepare('SELECT * FROM seller_connections WHERE tenant_id=? AND marketplace=? AND seller_id=?')
      .get(tenantId, 'mercadolibre', sellerId) as Record<string, unknown> | undefined;
    return row ? this.mapSeller(row) : null;
  }

  listSellerConnections(tenantId: string): SellerConnection[] {
    return (this.db
      .prepare('SELECT * FROM seller_connections WHERE tenant_id=? ORDER BY created_at')
      .all(tenantId) as Record<string, unknown>[]).map((row) => this.mapSeller(row));
  }

  private mapSeller(row: Record<string, unknown>): SellerConnection {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      marketplace: 'mercadolibre',
      sellerId: String(row.seller_id),
      credentialRef: String(row.credential_ref),
      enabled: asBool(row.enabled),
      config: parseJson<Record<string, unknown>>(row.config_json),
      createdAt: String(row.created_at),
    };
  }

  createPackagingProfile(profile: PackagingProfile): PackagingProfile {
    this.db
      .prepare(
        'INSERT INTO packaging_profiles(id,tenant_id,name,match_type,match_value,priority,active,package_json,packing_mode,max_quantity,quantity_rule_json,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        profile.id,
        profile.tenantId,
        profile.name,
        profile.matchType,
        profile.matchValue,
        profile.priority,
        profile.active ? 1 : 0,
        JSON.stringify(profile.package),
        profile.packingMode,
        profile.maxQuantity,
        profile.quantityRule == null ? null : JSON.stringify(profile.quantityRule),
        JSON.stringify(profile.metadata),
        profile.createdAt,
      );
    return profile;
  }

  listPackagingProfiles(tenantId: string): PackagingProfile[] {
    return (this.db
      .prepare('SELECT * FROM packaging_profiles WHERE tenant_id=? ORDER BY active DESC, priority DESC, created_at')
      .all(tenantId) as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        name: String(row.name),
        matchType: String(row.match_type) as PackagingMatchType,
        matchValue: row.match_value == null ? null : String(row.match_value),
        priority: Number(row.priority),
        active: asBool(row.active),
        package: parseJson<PackagingProfile['package']>(row.package_json),
        packingMode: String(row.packing_mode) as PackingMode,
        maxQuantity: Number(row.max_quantity),
        quantityRule: row.quantity_rule_json == null ? null : parseJson<NonNullable<PackagingProfile['quantityRule']>>(row.quantity_rule_json),
        metadata: parseJson<Record<string, unknown>>(row.metadata_json),
        createdAt: String(row.created_at),
      }));
  }

  createTariffSnapshot(snapshot: TariffSnapshot): TariffSnapshot {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (snapshot.active) {
        this.db
          .prepare('UPDATE tariff_snapshots SET active=0 WHERE tenant_id=? AND provider=?')
          .run(snapshot.tenantId, snapshot.provider);
      }
      this.db
        .prepare(
          'INSERT INTO tariff_snapshots(id,tenant_id,provider,version,active,rules_json,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          snapshot.id,
          snapshot.tenantId,
          snapshot.provider,
          snapshot.version,
          snapshot.active ? 1 : 0,
          JSON.stringify(snapshot.rules),
          snapshot.createdAt,
        );
      this.db.exec('COMMIT;');
      return snapshot;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  getActiveTariffSnapshot(tenantId: string, provider: CarrierProvider): TariffSnapshot | null {
    const row = this.db
      .prepare(
        'SELECT * FROM tariff_snapshots WHERE tenant_id=? AND provider=? AND active=1 ORDER BY created_at DESC LIMIT 1',
      )
      .get(tenantId, provider) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      provider: String(row.provider) as CarrierProvider,
      version: String(row.version),
      active: true,
      rules: parseJson<TariffSnapshot['rules']>(row.rules_json),
      createdAt: String(row.created_at),
    };
  }

  createShipment(shipment: Shipment): Shipment {
    this.db
      .prepare(
        'INSERT INTO shipments(id,tenant_id,provider,external_order_id,marketplace_shipment_id,provider_shipment_ref,tracking_number,status,service_code,idempotency_key,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        shipment.id,
        shipment.tenantId,
        shipment.provider,
        shipment.externalOrderId,
        shipment.marketplaceShipmentId,
        shipment.providerShipmentRef,
        shipment.trackingNumber,
        shipment.status,
        shipment.serviceCode,
        shipment.idempotencyKey,
        JSON.stringify(shipment.metadata),
        shipment.createdAt,
        shipment.updatedAt,
      );
    return shipment;
  }

  getShipment(tenantId: string, shipmentId: string): Shipment | null {
    const row = this.db
      .prepare('SELECT * FROM shipments WHERE tenant_id=? AND id=?')
      .get(tenantId, shipmentId) as Record<string, unknown> | undefined;
    return row ? this.mapShipment(row) : null;
  }

  updateShipmentStatus(tenantId: string, shipmentId: string, status: Shipment['status'], updatedAt: string): Shipment {
    const result = this.db
      .prepare('UPDATE shipments SET status=?,updated_at=? WHERE tenant_id=? AND id=?')
      .run(status, updatedAt, tenantId, shipmentId);
    if (Number(result.changes) !== 1) throw new NotFoundError('Shipment not found', { tenantId, shipmentId });
    return this.getShipment(tenantId, shipmentId)!;
  }

  private mapShipment(row: Record<string, unknown>): Shipment {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      provider: String(row.provider) as CarrierProvider,
      externalOrderId: String(row.external_order_id),
      marketplaceShipmentId: row.marketplace_shipment_id == null ? null : String(row.marketplace_shipment_id),
      providerShipmentRef: String(row.provider_shipment_ref),
      trackingNumber: row.tracking_number == null ? null : String(row.tracking_number),
      status: String(row.status) as Shipment['status'],
      serviceCode: row.service_code == null ? null : String(row.service_code),
      idempotencyKey: String(row.idempotency_key),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  getTrackingEventByProviderId(tenantId: string, shipmentId: string, providerEventId: string): TrackingEvent | null {
    const row = this.db
      .prepare('SELECT * FROM tracking_events WHERE tenant_id=? AND shipment_id=? AND provider_event_id=?')
      .get(tenantId, shipmentId, providerEventId) as Record<string, unknown> | undefined;
    return row ? this.mapTracking(row) : null;
  }

  appendTrackingEvent(event: TrackingEvent): TrackingEvent {
    this.db
      .prepare(
        'INSERT INTO tracking_events(id,tenant_id,shipment_id,provider_event_id,canonical_status,canonical_substatus,occurred_at,received_at,raw_status_code,location,comment,final) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        event.id,
        event.tenantId,
        event.shipmentId,
        event.providerEventId,
        event.canonicalStatus,
        event.canonicalSubstatus ?? null,
        event.occurredAt,
        event.receivedAt,
        event.rawStatusCode ?? null,
        event.location ?? null,
        event.comment ?? null,
        event.final ? 1 : 0,
      );
    return event;
  }

  listTrackingEvents(tenantId: string, shipmentId: string): TrackingEvent[] {
    return (this.db
      .prepare('SELECT * FROM tracking_events WHERE tenant_id=? AND shipment_id=? ORDER BY occurred_at,received_at')
      .all(tenantId, shipmentId) as Record<string, unknown>[]).map((row) => this.mapTracking(row));
  }

  private mapTracking(row: Record<string, unknown>): TrackingEvent {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      shipmentId: String(row.shipment_id),
      providerEventId: String(row.provider_event_id),
      canonicalStatus: String(row.canonical_status) as TrackingEvent['canonicalStatus'],
      canonicalSubstatus: row.canonical_substatus == null ? null : String(row.canonical_substatus),
      occurredAt: String(row.occurred_at),
      receivedAt: String(row.received_at),
      rawStatusCode: row.raw_status_code == null ? null : String(row.raw_status_code),
      location: row.location == null ? null : String(row.location),
      comment: row.comment == null ? null : String(row.comment),
      final: asBool(row.final),
    };
  }

  getIdempotency(tenantId: string, key: string): IdempotencyRecord | null {
    const row = this.db
      .prepare('SELECT * FROM idempotency_records WHERE tenant_id=? AND key=?')
      .get(tenantId, key) as Record<string, unknown> | undefined;
    return row ? this.mapIdempotency(row) : null;
  }

  reserveIdempotency(tenantId: string, key: string, now: string): IdempotencyRecord {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO idempotency_records(tenant_id,key,state,response_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(tenantId, key, 'pending', null, now, now);
    return this.getIdempotency(tenantId, key)!;
  }

  completeIdempotency(tenantId: string, key: string, response: Record<string, unknown>, now: string): IdempotencyRecord {
    const result = this.db
      .prepare('UPDATE idempotency_records SET state=?,response_json=?,updated_at=? WHERE tenant_id=? AND key=?')
      .run('completed', JSON.stringify(response), now, tenantId, key);
    if (Number(result.changes) !== 1) throw new ConflictError('Idempotency record was not reserved');
    return this.getIdempotency(tenantId, key)!;
  }

  failIdempotency(tenantId: string, key: string, now: string): IdempotencyRecord {
    const result = this.db
      .prepare('UPDATE idempotency_records SET state=?,updated_at=? WHERE tenant_id=? AND key=?')
      .run('failed', now, tenantId, key);
    if (Number(result.changes) !== 1) throw new ConflictError('Idempotency record was not reserved');
    return this.getIdempotency(tenantId, key)!;
  }

  private mapIdempotency(row: Record<string, unknown>): IdempotencyRecord {
    return {
      tenantId: String(row.tenant_id),
      key: String(row.key),
      state: String(row.state) as IdempotencyRecord['state'],
      response: row.response_json == null ? null : parseJson<Record<string, unknown>>(row.response_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  appendAudit(event: AuditEvent): AuditEvent {
    this.db
      .prepare(
        'INSERT INTO audit_events(id,tenant_id,actor,action,resource_type,resource_id,result,correlation_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        event.id,
        event.tenantId,
        event.actor,
        event.action,
        event.resourceType,
        event.resourceId,
        event.result,
        event.correlationId,
        JSON.stringify(event.metadata),
        event.createdAt,
      );
    return event;
  }

  listAudit(tenantId: string, limit = 100): AuditEvent[] {
    const bounded = Math.min(Math.max(limit, 1), 500);
    return (this.db
      .prepare('SELECT * FROM audit_events WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?')
      .all(tenantId, bounded) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      actor: String(row.actor),
      action: String(row.action),
      resourceType: String(row.resource_type),
      resourceId: String(row.resource_id),
      result: String(row.result) as AuditEvent['result'],
      correlationId: String(row.correlation_id),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json),
      createdAt: String(row.created_at),
    }));
  }
}
