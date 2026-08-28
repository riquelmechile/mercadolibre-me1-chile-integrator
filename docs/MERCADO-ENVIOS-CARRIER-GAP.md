# Mercado Envíos Carrier Integration — MLC gap analysis

Audit cut: **2026-08-28**

This document compares the generic runtime in this repository with Mercado Envíos' current official Carrier Integration test suite. It is an engineering-readiness document, **not evidence that this project or any tenant has been onboarded as a Mercado Envíos carrier**.

## External acceptance oracle

Official image:

```text
mercadolibre/carrier-integration-tests:latest
```

Image digest used in this audit:

```text
sha256:106c292ee3ddd12d49dfc5d6e12241ec913d1d5e74cbca0a4040eeb7aae50fae
```

Image metadata at audit time:

- build date: 2026-08-21;
- site under test: `MLC`;
- logistics target: `drop_off`;
- runtime exposed only on loopback;
- all carrier credentials, IDs and shipment data used by our harness are synthetic fixtures;
- no provider OF or Mercado Libre production mutation is performed by the harness.

## Relevant Standard/Atomic flows exposed by the suite

| Integration point | Current suite state | Repository state |
|---|---|---|
| OAuth 2.0 | Available | **FIT** — fixture harness implemented |
| Domestic authorization | Available | **FIT** — fixture ledger + idempotency/cancel/reauthorize |
| Delivery block | Available | **PARTIAL / oracle ambiguity** — see below |
| Tracking Last Mile | Available | **FIT for tested effective-delivery + conciliation scenarios** |
| Tracking Drop Off | Available | **PARTIAL** — event coverage not yet fully exercised |
| Agencies | Available | **FIT** — fixture publisher implemented |
| Coverage City | Available | **FIT** — Chile city coverage implemented |
| Coverage ZIP | Available | Not an MLC priority; Chile carrier coverage uses cities |
| Booking | Coming Soon | **BLOCKED by upstream suite** |
| Handling Unit / ABCD network | Available for broader carrier models | Out of current last-mile/drop-off scope |

## Official-suite results obtained locally

The following are **actual runs of Mercado Libre's current Docker suite against this repository's loopback-only fixture harness**:

| Flow | Result |
|---|---:|
| OAuth 2.0 | **8 / 8 PASS** |
| Coverage — Published Coverage City | **3 / 3 PASS** |
| Agencies — Published Agencies | **3 / 3 PASS** |
| Domestic Authorization | **9 / 9 PASS** |
| Last Mile — Effective Delivery | **7 / 7 PASS** |
| Last Mile — Conciliation 0260 | **1 / 1 PASS** |
| **Verified total** | **31 / 31 PASS** |

These results validate the local contract harness only. They do not replace Mercado Libre onboarding, assigned IDs, commercial approval or an end-to-end homologation environment.

## Bugs found by the external oracle

The official suite caught contract differences that our first internal tests did not catch:

1. Domestic authorization response `id` must be a **string**, even when the request fixture uses a numeric shipment ID.
2. Normal authorization cancellation expects `status_message` to be empty.
3. Empty/malformed authorization JSON must produce a structured HTTP `400` / `FAILED`, not a server `500`.
4. Last-mile events `0271` and `0273` require `location.facility` and `location.geolocation`.
5. Event `0227` requires `location.geolocation`.
6. Delivered event `0401` requires proof-of-delivery data, including receiver document type, receiver name and relationship.
7. Conciliation event `0260` requires explicit cost plus measured weight/height/width/length.

All seven findings are now represented by local regression guards.

## Delivery-block ambiguity in the current suite

The current suite exposes a dedicated **Delivery block** flow, but its generated preview currently sends:

```text
PUT /shipments/{shipment_id}/authorization
{
  "status": "CANCEL",
  "tracking_number": "..."
}
```

That is the same route/payload shape used by the Domestic Authorization cancellation scenarios. However:

- normal cancellation expects `status = CANCELLED` with an empty `status_message`;
- the Delivery Block feature expects `status = CANCELLED` with `status_message = BLOCKED`.

A separate service-layer string in the same suite describes `/shipments/{id}/delivery-block`, but the current generated test preview uses `/authorization`.

The local harness therefore does **not** special-case identical requests just to make both tests green. A dedicated `/shipments/{id}/delivery-block` fixture route exists and returns `BLOCKED`, but production semantics remain **gated pending authoritative clarification** of the exact route/lifecycle discriminator.

## Contract fit by boundary

### OAuth inbound

Implemented for the fixture harness:

- Basic client authentication;
- `client_credentials`;
- official audience allowlist;
- audience-scoped bearer tokens;
- `expires_in = 21600`;
- revocation;
- missing/wrong credentials and audience fail closed.

This is deliberately separate from seller OAuth and from credentials used to call Starken.

### Coverage

Implemented for MLC city coverage:

```text
POST /coverage
```

The generic contract echoes `service_type` and `direction` and returns Chile city/state identifiers. Private tenant destination/tariff data must not be committed to this repository.

### Agencies

Implemented fixture publishing for:

```text
POST /agencies
```

The public fixture is fictional. Real carrier onboarding would need commercial/operational agency definitions accepted by Mercado Libre.

### Domestic Authorization

Implemented fixture contract:

```text
POST /shipments/{id}/authorization
PUT  /shipments/{id}/authorization
```

Current properties:

- request fingerprint;
- identical request → identical authorization;
- same active shipment + different payload → conflict;
- cancellation;
- reauthorization after cancellation → new tracking number;
- no underlying courier mutation from this harness.

The existing logistics core already contains stronger provider-side shipment idempotency. A future provisioned gateway should bridge the Mercado Envíos authorization ledger to that provider operation without weakening either invariant.

### Tracking

The harness now validates and can expose the tested Last Mile contract shape. Important financial/safety fields must never be guessed:

- `0401` is a delivered event and requires proof of delivery;
- `0260` is reconciliation/conciliation and must be based on explicit measured/cost data;
- unknown provider tracking states remain fail-closed;
- final events are monotonic.

## External blockers that code cannot self-provision

The following remain outside this repository and cannot be simulated as production readiness:

- Mercado Envíos **Carrier ID**;
- real `SERVICE_ID` assigned by Mercado Libre;
- carrier contract/account information;
- focal-point / onboarding authorization;
- production credentials and audiences;
- final allowed service/logistics configuration;
- authoritative Delivery Block lifecycle semantics.

`SERVICE_ID=999999` used during local suite startup is a clearly synthetic UI/bootstrap value only. It is not a Mercado Libre assigned service.

## Relationship with ME1 Dynamic Freight

Carrier Integration is **not** the same program as seller-side ME1 Dynamic Freight.

```text
Seller ME1 / Dynamic Freight
Mercado Libre -> integrator quote endpoint -> buyer sees price/promise

Carrier Integration
Mercado Libre -> carrier authorization/coverage/tracking APIs

Courier provider layer
our generic core -> Starken / other provider
```

Do not infer that passing the Carrier Integration test suite activates ME1 for a seller. See [`ME1-DYNAMIC-FREIGHT-AUDIT.md`](ME1-DYNAMIC-FREIGHT-AUDIT.md).
