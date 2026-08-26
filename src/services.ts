import {
  AppError,
  ConflictError,
  FINAL_SHIPMENT_STATUSES,
  NotFoundError,
  UnsupportedCapabilityError,
  newId,
  nowIso,
  type AuditEvent,
  type CarrierConnection,
  type CarrierProvider,
  type QuoteInput,
  type QuoteResult,
  type Shipment,
  type ShipmentCreateInput,
  type TariffRule,
  type TrackingEvent,
  type TrackingEventInput,
} from './domain.js';
import { AdapterRegistry } from './adapters.js';
import { controlledShipmentPayloadSha256 } from './controlled-shipment.js';
import type { Store } from './ports.js';

function sameText(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().toLocaleLowerCase('es-CL') === right.trim().toLocaleLowerCase('es-CL');
}

function ruleSpecificity(rule: TariffRule, input: QuoteInput): number {
  let location = 1;
  if (rule.commune && sameText(rule.commune, input.destination.commune)) location = 3;
  else if (rule.commune) return -1;
  else if (rule.region && sameText(rule.region, input.destination.region)) location = 2;
  else if (rule.region) return -1;

  if (rule.deliveryMode && input.deliveryPreference && input.deliveryPreference !== 'any' && rule.deliveryMode !== input.deliveryPreference) return -1;
  if (rule.paymentMode && input.paymentMode && rule.paymentMode !== input.paymentMode) return -1;
  const deliveryBonus = rule.deliveryMode && input.deliveryPreference === rule.deliveryMode ? 2 : 0;
  const paymentBonus = rule.paymentMode && input.paymentMode === rule.paymentMode ? 1 : 0;
  return location * 10 + deliveryBonus + paymentBonus;
}

function chargeableWeight(input: QuoteInput, divisor = 4000): number {
  const volumetric = (input.package.lengthCm * input.package.widthCm * input.package.heightCm) / divisor;
  return Math.max(input.package.weightKg, volumetric);
}

export class LogisticsService {
  constructor(
    private readonly store: Store,
    private readonly adapters: AdapterRegistry,
  ) {}

  private requireTenant(tenantId: string): void {
    if (!this.store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
  }

  private requireExistingCarrier(tenantId: string, provider: CarrierProvider): CarrierConnection {
    this.requireTenant(tenantId);
    const connection = this.store.getCarrierConnection(tenantId, provider);
    if (!connection) throw new NotFoundError('Carrier connection not found', { tenantId, provider });
    return connection;
  }

  private requireCarrier(tenantId: string, provider: CarrierProvider): CarrierConnection {
    const connection = this.requireExistingCarrier(tenantId, provider);
    if (!connection.enabled) {
      throw new NotFoundError('Enabled carrier connection not found', { tenantId, provider });
    }
    return connection;
  }

  private requireControlledCarrier(tenantId: string, provider: CarrierProvider): CarrierConnection {
    const connection = this.requireExistingCarrier(tenantId, provider);
    if (connection.enabled) {
      throw new ConflictError('Controlled shipment path requires a disabled carrier connection', { tenantId, provider });
    }
    return connection;
  }

  quote(input: QuoteInput): Promise<QuoteResult> {
    const connection = this.requireCarrier(input.tenantId, input.provider);
    return this.quoteWithConnection(input, connection);
  }

  quoteControlled(input: QuoteInput): Promise<QuoteResult> {
    const connection = this.requireControlledCarrier(input.tenantId, input.provider);
    if (input.allowLive !== true) {
      throw new AppError('invalid_request', 'Controlled quote requires allowLive=true', 400);
    }
    const adapter = this.adapters.get(input.provider);
    if (!adapter.capabilities(connection).has('quote')) {
      throw new UnsupportedCapabilityError(input.provider, 'quote');
    }
    return adapter.quote(input, connection);
  }

  private quoteWithConnection(input: QuoteInput, connection: CarrierConnection): Promise<QuoteResult> {
    const snapshot = this.store.getActiveTariffSnapshot(input.tenantId, input.provider);
    if (snapshot) {
      const candidates = snapshot.rules
        .map((rule) => {
          const weight = chargeableWeight(input, rule.volumetricDivisor ?? 4000);
          return { rule, weight, specificity: ruleSpecificity(rule, input) };
        })
        .filter(({ rule, weight, specificity }) =>
          specificity > 0 && weight >= rule.minWeightKg && weight <= rule.maxWeightKg,
        )
        .sort((a, b) => b.specificity - a.specificity || a.rule.amount - b.rule.amount);

      const match = candidates[0];
      if (match) {
        return Promise.resolve({
          provider: input.provider,
          serviceCode: match.rule.serviceCode,
          serviceName: match.rule.serviceName,
          currency: match.rule.currency,
          amount: match.rule.amount,
          estimatedBusinessDays: match.rule.estimatedBusinessDays,
          chargeableWeightKg: match.weight,
          snapshotVersion: snapshot.version,
          source: 'snapshot',
          ...(match.rule.deliveryMode ? { deliveryMode: match.rule.deliveryMode } : {}),
        });
      }
    }

    if (input.allowLive !== true) {
      throw new NotFoundError('No matching tariff snapshot and live quotes are disabled', {
        tenantId: input.tenantId,
        provider: input.provider,
      });
    }

    const adapter = this.adapters.get(input.provider);
    if (!adapter.capabilities(connection).has('quote')) {
      throw new UnsupportedCapabilityError(input.provider, 'quote');
    }
    return adapter.quote(input, connection);
  }

  async createShipment(input: ShipmentCreateInput, actor = 'api', correlationId = newId()): Promise<Shipment> {
    const connection = this.requireCarrier(input.tenantId, input.provider);
    return this.createShipmentWithConnection(input, connection, actor, correlationId, 'shipment.create');
  }

  async createControlledShipment(
    input: ShipmentCreateInput,
    approvalId: string,
    actor = 'controlled-api',
    correlationId = newId(),
  ): Promise<Shipment> {
    const connection = this.requireControlledCarrier(input.tenantId, input.provider);
    return this.createShipmentWithConnection(
      input,
      connection,
      actor,
      correlationId,
      'shipment.create.controlled',
      { approvalId },
      true,
    );
  }

  private async createShipmentWithConnection(
    input: ShipmentCreateInput,
    connection: CarrierConnection,
    actor: string,
    correlationId: string,
    auditAction: string,
    auditMetadata: Record<string, unknown> = {},
    strictFingerprint = false,
  ): Promise<Shipment> {
    const idemKey = `shipment:create:${input.idempotencyKey}`;
    const requestSha256 = controlledShipmentPayloadSha256(input);
    const assertFingerprint = (record: ReturnType<Store['getIdempotency']>): void => {
      if (!record) return;
      const stored = record.response?.requestSha256;
      if (typeof stored === 'string' && stored !== requestSha256) {
        throw new ConflictError('Idempotency key was already used with a different shipment payload');
      }
      if (strictFingerprint && stored == null) {
        throw new ConflictError('Controlled shipment cannot reuse a legacy idempotency record without a request fingerprint');
      }
    };
    const existing = this.store.getIdempotency(input.tenantId, idemKey);
    assertFingerprint(existing);
    if (existing?.state === 'completed' && existing.response?.shipmentId) {
      const shipment = this.store.getShipment(input.tenantId, String(existing.response.shipmentId));
      if (shipment) return shipment;
    }
    if (existing?.state === 'pending') {
      throw new ConflictError('Shipment creation with this idempotency key is already pending');
    }
    if (existing?.state === 'failed') {
      throw new ConflictError('Previous attempt failed; reconcile provider state before reusing this idempotency key');
    }

    const reservedAt = nowIso();
    if (!this.store.claimIdempotency(input.tenantId, idemKey, reservedAt, { requestSha256 })) {
      const claimed = this.store.getIdempotency(input.tenantId, idemKey);
      assertFingerprint(claimed);
      if (claimed?.state === 'completed' && claimed.response?.shipmentId) {
        const shipment = this.store.getShipment(input.tenantId, String(claimed.response.shipmentId));
        if (shipment) return shipment;
      }
      if (claimed?.state === 'failed') {
        throw new ConflictError('Previous attempt failed; reconcile provider state before reusing this idempotency key');
      }
      throw new ConflictError('Shipment creation with this idempotency key is already pending');
    }

    const adapter = this.adapters.get(input.provider);
    if (!adapter.capabilities(connection).has('create_shipment')) {
      this.store.failIdempotency(input.tenantId, idemKey, nowIso());
      throw new UnsupportedCapabilityError(input.provider, 'create_shipment');
    }

    try {
      const providerResult = await adapter.createShipment(input, connection);
      const now = nowIso();
      const shipment: Shipment = {
        id: newId(),
        tenantId: input.tenantId,
        provider: input.provider,
        externalOrderId: input.externalOrderId,
        marketplaceShipmentId: input.marketplaceShipmentId ?? null,
        providerShipmentRef: providerResult.providerShipmentRef,
        trackingNumber: providerResult.trackingNumber,
        status: providerResult.status,
        serviceCode: input.serviceCode ?? null,
        idempotencyKey: input.idempotencyKey,
        metadata: { ...(input.metadata ?? {}), ...(providerResult.metadata ?? {}) },
        createdAt: now,
        updatedAt: now,
      };
      this.store.createShipment(shipment);
      this.store.completeIdempotency(input.tenantId, idemKey, { shipmentId: shipment.id, requestSha256 }, now);
      this.audit({
        tenantId: input.tenantId,
        actor,
        action: auditAction,
        resourceType: 'shipment',
        resourceId: shipment.id,
        result: 'ok',
        correlationId,
        metadata: { provider: input.provider, ...auditMetadata },
      });
      return shipment;
    } catch (error) {
      this.store.failIdempotency(input.tenantId, idemKey, nowIso());
      throw error;
    }
  }

  ingestTracking(input: TrackingEventInput, actor = 'provider', correlationId = newId()): TrackingEvent {
    const shipment = this.store.getShipment(input.tenantId, input.shipmentId);
    if (!shipment) throw new NotFoundError('Shipment not found', { shipmentId: input.shipmentId });

    const existing = this.store.getTrackingEventByProviderId(
      input.tenantId,
      input.shipmentId,
      input.providerEventId,
    );
    if (existing) return existing;

    if (FINAL_SHIPMENT_STATUSES.has(shipment.status) && input.canonicalStatus !== shipment.status) {
      throw new ConflictError('Final shipment status is monotonic and cannot transition to a different state', {
        current: shipment.status,
        requested: input.canonicalStatus,
      });
    }

    const event: TrackingEvent = {
      ...input,
      id: newId(),
      receivedAt: nowIso(),
      final: input.final ?? FINAL_SHIPMENT_STATUSES.has(input.canonicalStatus),
    };
    this.store.appendTrackingEvent(event);
    this.store.updateShipmentStatus(input.tenantId, input.shipmentId, input.canonicalStatus, event.receivedAt);
    this.audit({
      tenantId: input.tenantId,
      actor,
      action: 'tracking.ingest',
      resourceType: 'shipment',
      resourceId: input.shipmentId,
      result: 'ok',
      correlationId,
      metadata: {
        canonicalStatus: input.canonicalStatus,
        providerEventId: input.providerEventId,
      },
    });
    return event;
  }

  private audit(input: Omit<AuditEvent, 'id' | 'createdAt'>): void {
    this.store.appendAudit({ ...input, id: newId(), createdAt: nowIso() });
  }
}
