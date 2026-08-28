# Architecture — Mercado Libre Chile multi-courier logistics integrator

**Status:** current implementation + target architecture, 28 August 2026

## Goals

Build a provider-neutral logistics core that can serve multiple Mercado Libre sellers and multiple carriers without coupling channel logic to any one courier.

Primary product paths:

1. **Custom Shipping automation** for immediate operational use.
2. **ME1 seller tracking + Dynamic Freight** after activation/certification/homologation.
3. Separate **Mercado Envíos Carrier Integration** readiness for a future carrier onboarding path.
4. Optional future **Mercado Libre Flex courier** integration.

## Current runtime boundary — v0.10.0

The executable core already implements the reusable control-plane foundation: tenant/carrier connections, secret references, packaging profiles, versioned tariff and location snapshots, local routing, snapshot-first quotes, atomic shipment idempotency, audit events, tracking normalization and a current official Starken adapter.

A first-production shipment can be exercised without enabling normal carrier automation through three mutually exclusive loopback-only modes:

```text
preview-only → explicit exact-payload approval/create → observation-only
```

The observation path can reconcile a provider issuance to a freight order, preserve label evidence and ingest deduplicated/monotonic tracking while the carrier remains disabled. Blue Express and Chilexpress remain contract-gated shells. ME1 Dynamic Freight publication remains certification-gated.

The rest of this document describes both this implemented foundation and the architecture it grows into; future-only components are not implied to exist in v0.10.0.

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
    -> validate seller + exactly-one-item context
    -> accept MELI-provided dimensions as authoritative
    -> resolve Chile Región/Comuna coverage + tariff policy
    -> choose service/price/promise
    -> emit deterministic cacheable quote response
```

Never make the normal quote response dependent on a synchronous carrier API request if a valid tariff snapshot exists. When `quantity > 1`, Mercado Libre already consolidates dimensions; the Dynamic Freight boundary must not multiply or repack the dimensions it receives.

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

### Mercado Envíos Carrier Integration boundary

Carrier Integration is a different trust boundary from seller ME1. The local certification harness exposes Mercado Envíos-shaped OAuth, coverage, agencies, domestic authorization and tracking **without** depending on `CourierAdapter` or production credentials. Selected current official Docker-suite scenarios pass locally, but production remains gated on Mercado Libre-assigned Carrier ID, SERVICE_ID, contract and onboarding permissions.

```text
Seller ME1 / Dynamic Freight  !=  Carrier Integration  !=  physical courier adapter
```

Never treat seller OAuth, Dynamic Freight certification, carrier onboarding or a courier credential as interchangeable authority. See `MERCADO-ENVIOS-CARRIER-GAP.md`.


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

A dedicated mapping layer converts provider status + context into Mercado Libre V2 `status/substatus`. Internal labels such as `returning_to_sender` are **not wire values**: current ME1 V2 final `not_delivered` uses `returned` or `refused_delivery`, and the publisher rejects the obsolete V1-era wire value `returning_to_sender`.

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

## Current implementation boundary and next milestones

### Implemented in v0.10.0

- tenant and seller/carrier connection skeletons with credential references;
- packaging profiles and deterministic package resolution;
- versioned tariff and carrier-location snapshots;
- local provider routing resolution;
- snapshot-first quotes and explicit live-quote opt-in;
- atomic, fingerprinted shipment idempotency;
- canonical tracking persistence, dedupe and monotonic final states;
- official Starken plugin-gateway quote/create/tracking integration;
- Mercado Libre seller/category/item shipping capability discovery plus dry-run seller-owned Custom Shipping planning;
- strict current ME1 V2 seller-notification planning and MLC `city_to` item-option reads;
- Dynamic Freight request/quote/cache/error contract guards with MELI-supplied dimensions authoritative;
- loopback-only Mercado Envíos Carrier certification harness with selected official-suite flows green;
- controlled preview, exact-payload create and shipment-scoped observation while the carrier remains disabled;
- audit foundations and public/private configuration boundaries.

### Deliberately not implied by the current MVP

- general production automation for a carrier until a tenant explicitly enables it after pilot evidence;
- finished Blue Express / Chilexpress productive contracts;
- production ME1 Dynamic Freight publication before DPP/certification prerequisites;
- complete webhook/queue/DLQ/SLO infrastructure described in the target architecture;
- final multi-seller SaaS operations, support and billing layers.

These gaps are product milestones, not permission to bypass current safety gates.
