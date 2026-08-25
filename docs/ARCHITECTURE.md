# Architecture — Mercado Libre Chile multi-courier logistics integrator

**Status:** design baseline, 25 August 2026

## Goals

Build a provider-neutral logistics core that can serve multiple Mercado Libre sellers and multiple carriers without coupling channel logic to any one courier.

Primary product paths:

1. **Custom Shipping automation** for immediate operational use.
2. **ME1 Dynamic Freight** after certification/homologation.
3. Optional future **Mercado Libre Flex courier** integration.

## Core principles

1. **Provider isolation** — Mercado Libre logic never calls Starken/Blue/Chilexpress-specific code directly.
2. **Tenant isolation** — every seller/carrier credential and operation is scoped to one tenant.
3. **Fast quote path** — ME1 quotes should resolve from synchronized tariff/coverage snapshots where possible, not from a blocking live carrier request.
4. **Event-driven shipment lifecycle** — provider events are normalized before being published to Mercado Libre.
5. **Idempotency everywhere** — every create/update/callback path must be safe against retries and duplicate notifications.
6. **Evidence-based adapters** — no undocumented production endpoint is committed.
7. **Privacy by design** — buyer PII is minimized, encrypted, masked and deleted according to retention rules.

---

## Logical components

```text
┌────────────────────────────────────────────────────────────┐
│                        API Gateway                         │
└───────────────┬───────────────────────────────┬────────────┘
                │                               │
        Seller / Admin API                Provider callbacks
                │                               │
                ▼                               ▼
┌──────────────────────┐             ┌──────────────────────┐
│ Tenant / Auth Core   │             │ Webhook Ingress      │
│ - seller OAuth       │             │ - verify signature   │
│ - RBAC               │             │ - replay protection  │
│ - credential refs    │             │ - dedupe             │
└──────────┬───────────┘             └──────────┬───────────┘
           │                                    │
           └────────────────┬───────────────────┘
                            ▼
                 ┌──────────────────────┐
                 │   Event / Audit Bus  │
                 └───────┬──────┬──────┘
                         │      │
             ┌───────────┘      └──────────────┐
             ▼                                  ▼
┌─────────────────────────┐        ┌────────────────────────┐
│ Quote Engine            │        │ Shipment Orchestrator  │
│ - tariff snapshots      │        │ - create               │
│ - coverage rules        │        │ - label                │
│ - dimensions/weight     │        │ - pickup               │
│ - service constraints   │        │ - cancel/return        │
│ - contingencies         │        │ - reconciliation       │
└───────────┬─────────────┘        └───────────┬────────────┘
            │                                  │
            ▼                                  ▼
┌─────────────────────────┐        ┌────────────────────────┐
│ MercadoLibreAdapter     │        │ CourierAdapter registry │
│ - orders/shipments      │        │ Starken                │
│ - Custom                │        │ Blue Express           │
│ - ME1 quote             │        │ Chilexpress            │
│ - seller_notifications  │        │ CorreosChile           │
│ - OAuth                 │        │ Shipit (optional)       │
└─────────────────────────┘        └────────────────────────┘
```

---

## Tenant model

A tenant represents one commercial customer/seller organization.

Suggested entities:

```text
Tenant
SellerConnection
CarrierConnection
WarehouseOrigin
ShippingPolicy
TariffSnapshot
Shipment
ShipmentPackage
TrackingEvent
LabelArtifact
WebhookReceipt
AuditEvent
CredentialReference
```

Rules:

- one tenant can have multiple Mercado Libre seller accounts;
- one tenant can have multiple carrier contracts;
- credentials are referenced by vault identifiers, never stored directly in normal domain tables;
- every row/event carries tenant scope;
- cross-tenant queries are denied at both application and data-access layers.

---

## Mercado Libre adapter

### Custom path

1. receive order/shipment notification;
2. resolve paid order and destination data;
3. resolve SKU packaging dimensions/weight;
4. select configured carrier/service;
5. create provider shipment/transport order;
6. obtain label/tracking number;
7. persist canonical shipment + provider reference;
8. update Mercado Libre Custom shipment/tracking as supported;
9. normalize provider tracking events;
10. close on delivered/not-delivered according to channel rules.

### ME1 Dynamic Freight path

Dynamic Freight quote handling should be separated from shipment execution.

Request path:

```text
Mercado Libre quote request
    -> validate tenant/seller/item context
    -> resolve packaging + origin
    -> local coverage/tariff snapshot
    -> shipping policy/rules
    -> contingency check
    -> deterministic quote response
```

Never make the normal quote response dependent on a synchronous carrier API request if a valid tariff snapshot exists.

Background synchronization path:

```text
Carrier tariff/coverage source
    -> provider sync job
    -> normalize services/constraints
    -> versioned TariffSnapshot
    -> publish active snapshot atomically
```

Each quote response should be traceable to a snapshot/version for later reconciliation.

### ME1 tracking V2

Use:

`POST /v2/shipments/{shipment_id}/seller_notifications`

Canonical publisher rules:

- always include `status` and `substatus`;
- use JSON `null` when substatus is absent;
- send `tracking_number` and `tracking_url` together or omit both;
- never send `delivered` before provider evidence is final;
- never reuse a final state transition;
- maintain an idempotency record for every outbound event.

---

## Courier adapter contract

Conceptual interface:

```text
capabilities(connection) -> CapabilitySet
health(connection) -> ProviderHealth
coverage(input) -> CoverageResult
quote(input) -> QuoteResult
createShipment(input, idempotencyKey) -> ShipmentResult
getLabel(shipmentRef) -> LabelResult
cancelShipment(shipmentRef) -> Result
createPickup(input) -> PickupResult
tracking(shipmentRef) -> TrackingResult
createReturn(input) -> ReturnResult
pod(shipmentRef) -> PodResult
```

Not every provider must implement every operation. Unsupported operations are explicit capabilities, not runtime surprises.

### Canonical quote

```text
provider
service_code
service_name
currency
amount
estimated_business_days
pickup_supported
pudo_supported
constraints
snapshot_version
quote_source = live | snapshot | contingency
```

### Canonical tracking event

```text
provider_event_id
provider_code
occurred_at
received_at
canonical_status
canonical_substatus
raw_status_code
location
comment
final
```

Raw provider payloads should be retained only where necessary and with PII minimization/redaction.

---

## Tracking normalization

Canonical statuses should remain more granular internally than Mercado Libre's top-level ME1 statuses.

Example internal states:

```text
created
label_ready
pickup_scheduled
picked_up
in_transit
at_branch
out_for_delivery
delivery_attempt_failed
address_issue
receiver_absent
returning_to_sender
delivered
not_delivered
cancelled
```

A dedicated mapping layer converts provider status + context into Mercado Libre V2 `status/substatus`.

Provider mappings must be versioned because carrier status taxonomies can change.

---

## Idempotency and replay safety

Required keys:

- inbound Mercado Libre notification id/event tuple;
- inbound carrier webhook event id or payload hash + provider reference;
- shipment creation command id;
- outbound Mercado Libre status event key;
- pickup/return command id.

Rules:

- persist receipt before side effects when possible;
- retries must return the previous successful result;
- a duplicate webhook must not create a new shipment or duplicate a final state;
- final-state transitions require monotonic guards.

---

## Reliability / contingency

### Quote path SLO design

Dynamic Freight homologation explicitly evaluates response-time/reliability concerns. Design for:

- in-memory/edge cache for active tariff snapshot metadata;
- fast indexed lookup by tenant/origin/destination/service/weight-volume band;
- bounded policy evaluation;
- no N+1 provider requests;
- provider health not in the critical path unless no snapshot exists;
- deterministic fallback/contingency table.

### Provider degradation

Provider state:

```text
healthy
degraded
unavailable
auth_failed
contract_expired
rate_limited
```

A provider outage should not corrupt historical quotes or silently route to another paid service without a tenant policy authorizing it.

### Queues / retries

Use retry + dead-letter handling for:

- provider shipment creation after transient failure;
- tracking webhook processing;
- Mercado Libre status publication;
- tariff sync;
- pickup/return operations.

Do not retry irreversible business operations without idempotency guarantees.

---

## Security

### Credentials

- store carrier and Mercado Libre secrets in a dedicated secret manager/vault;
- application DB stores only secret references + metadata;
- rotate credentials without tenant downtime;
- redact Authorization headers and tokens from logs/traces;
- never expose one tenant's provider credentials to another tenant.

### PII

Potential PII includes buyer name, address, phone, email, shipment comments and POD information.

Controls:

- encrypt at rest;
- TLS in transit;
- masked structured logging;
- scoped support access;
- retention policies by data class;
- deletion/export workflows;
- audit every privileged read;
- do not use buyer PII for unrelated analytics/marketing.

Design must be ready for Chile Law 21.719 effective **1 December 2026**.

### Webhooks

- validate provider/Mercado Libre authenticity where supported;
- reject stale/replayed callbacks;
- use bounded request bodies;
- record receipt hash/id before processing;
- rate limit abusive sources;
- never trust provider status text as executable input.

---

## Observability

Per tenant/provider/channel metrics:

```text
quote_latency_ms
quote_error_rate
snapshot_age_seconds
shipment_create_latency_ms
shipment_create_error_rate
tracking_lag_seconds
meli_publish_latency_ms
meli_publish_error_rate
webhook_duplicate_rate
provider_auth_failures
provider_rate_limits
final_delivery_rate
```

Operational dashboards should separate:

- channel failures (Mercado Libre);
- provider failures (carrier);
- our own application failures;
- tenant configuration errors.

---

## Data retention and audit

Audit events should be append-only and small:

```text
actor
tenant
action
resource_type
resource_id
result
timestamp
correlation_id
```

Do not dump raw payloads containing PII into permanent audit logs. Store only the minimal evidence required for troubleshooting/compliance.

---

## Initial implementation boundary

The first runtime milestone should implement only:

- tenant skeleton;
- Mercado Libre seller connection abstraction;
- one carrier adapter contract;
- Starken or another provider only after official credentials/spec are obtained;
- shipment/tracking persistence;
- idempotency/audit foundations;
- no ME1 Dynamic Freight production endpoint before DPP/certification prerequisites are satisfied.
