import {
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
import type { Store } from './ports.js';

function sameText(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().toLocaleLowerCase('es-CL') === right.trim().toLocaleLowerCase('es-CL');
}

function ruleSpecificity(rule: TariffRule, input: QuoteInput): number {
  if (rule.commune && sameText(rule.commune, input.destination.commune)) return 3;
  if (rule.commune) return -1;
  if (rule.region && sameText(rule.region, input.destination.region)) return 2;
  if (rule.region) return -1;
  return 1;
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

  private requireCarrier(tenantId: string, provider: CarrierProvider): CarrierConnection {
    this.requireTenant(tenantId);
    const connection = this.store.getCarrierConnection(tenantId, provider);
    if (!connection || !connection.enabled) {
      throw new NotFoundError('Enabled carrier connection not found', { tenantId, provider });
    }
    return connection;
  }

  quote(input: QuoteInput): Promise<QuoteResult> {
    const connection = this.requireCarrier(input.tenantId, input.provider);
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
    const idemKey = `shipment:create:${input.idempotencyKey}`;
    const existing = this.store.getIdempotency(input.tenantId, idemKey);
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

    this.store.reserveIdempotency(input.tenantId, idemKey, nowIso());
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
      this.store.completeIdempotency(input.tenantId, idemKey, { shipmentId: shipment.id }, now);
      this.audit({
        tenantId: input.tenantId,
        actor,
        action: 'shipment.create',
        resourceType: 'shipment',
        resourceId: shipment.id,
        result: 'ok',
        correlationId,
        metadata: { provider: input.provider },
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
