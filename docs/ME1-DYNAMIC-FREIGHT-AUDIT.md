# ME1 + Dynamic Freight Chile — contract audit

Audit cut: **2026-08-28**  
Official source revisions observed: **ME1 order states 2026-08-19** · **Dynamic Freight 2026-08-24**

This audit separates three contracts that are easy to conflate:

```text
A. Seller ME1 / Dynamic Freight
   Mercado Libre checkout -> integrator quote endpoint -> buyer sees price + promise

B. Seller ME1 tracking
   seller/integrator -> Mercado Libre seller_notifications -> buyer sees shipment state + optional external tracking

C. Mercado Envíos Carrier Integration
   Mercado Libre -> carrier coverage/authorization/tracking APIs
```

Passing or implementing one boundary does **not** activate another one.

## ME1 activation: current official-source conflict

The public documentation currently exposes two different descriptions of the account-activation workflow:

- the developer ME1 page says the seller can request ME1 through a KAM/commercial advisor **or a direct-request channel**;
- the seller learning-center guide lists a certified Dynamic Freight integrator as a requirement and says that integrator requests activation.

Therefore the safe conclusion is **not** “ME1 can definitely be self-activated without an integrator.” The safe conclusion is that a direct request channel exists, while the integrator requirement remains present in current seller-facing guidance. The seller/account-specific result has to be verified against Mercado Libre rather than inferred from OAuth or API access.

Dynamic Freight is clearer: its endpoint homologation is explicitly reserved to integrators in the certification process.

## The buyer checkout flow

Dynamic Freight is the ME1 component that solves the buyer-price problem directly. Mercado Libre calls a homologated external integrator endpoint in real time before purchase. The response carries one or more shipping quotations; Mercado Libre uses those results to show the shipping cost and delivery promise to the buyer.

```text
buyer chooses quantity + destination
              ↓
Mercado Libre builds one-item quote request
              ↓
GET homologated integrator endpoint
              ↓
price + handling_time + shipping_time + promise + service
              ↓
Mercado Libre checkout shows shipping option
              ↓
buyer pays purchase + selected shipping cost
```

That is different from manually charging shipping after the sale.

### Current homologation gate

The current official Dynamic Freight documentation states that homologation is reserved to integrators that are in the certification process. A homologation package includes at least:

- external endpoint URL;
- required communication headers;
- request/body contract;
- application name and ID;
- demonstration video;
- technical/security validation;
- load/latency validation;
- contingency support.

The target response time is **below 400 ms**, and the current Mercado Libre Dynamic Freight infrastructure is documented in **US East / Virginia**.

A technically compatible endpoint is therefore not enough to claim activation. This repository prepares the contract but keeps production Dynamic Freight gated.

## Dynamic Freight request — invariants for Chile

The quote request carries exactly **one item of one seller**. Relevant fields include:

| Field | Contract |
|---|---|
| `seller_id` | required |
| `buyer_id` | optional |
| `declared_value` | optional |
| `items[].id` | required |
| `items[].variation_id` | required |
| `items[].quantity` | required |
| `items[].sku` | required |
| `items[].dimensions` | required |
| `origin` | optional |
| `destination` | required |

For Chile, the wire shape is `destination: { type: "city", value: "Región/Comuna" }` (and `origin`, when present, follows the same city form). A stale object with separate `region` / `commune` fields is rejected. The current homologation contract types `length`, `width`, `height` and `weight` as integers (centimeters / grams); the local validator rejects fractional request dimensions at this boundary. `variation_id=0` is accepted, matching the current official no-variation example.

### The quantity rule that matters for dimension tables

When quantity is greater than one, **Mercado Libre consolidates the package dimensions itself** and sends the consolidated result in the Dynamic Freight request. The integrator must use those dimensions as received and **must not multiply them again**.

That gives the runtime an explicit boundary:

```text
before Mercado Libre sends a Dynamic Freight request
  internal packaging/profile logic can help prepare listing/contingency data

inside the Dynamic Freight endpoint
  MELI request dimensions are authoritative
  quantity > 1 does NOT trigger a second local dimension calculation
```

This prevents double-counting package growth.

## Dynamic Freight response

The response contains destinations and packages. Every package carries dimensions/items and at least one quotation.

Each quotation must contain:

```text
price
handling_time
shipping_time
promise
service
```

The core now guards:

```text
promise = handling_time + shipping_time
service = integer 0..99
>= 1 quotation
non-negative price/times
```

`service` belongs to the seller/integrator. Mercado Libre transmits it and later encodes the carrier/service identity into the shipment shipping option. Sending more than two digits is explicitly unsafe because the carrier code can fall back to `00`.

## Cache contract

Dynamic Freight uses HTTP GET and defines a real cache/revalidation contract.

For cacheable responses:

```text
ETag: required
Cache-Control: private; max-age=N
Age: >= 0
```

`must-revalidate` is optional. Mercado Libre can send `If-None-Match`; if the representation is still valid, the integrator may return HTTP `304` without a new body. If a quotation must never be cached, `Cache-Control: no-store` is allowed.

The local contract module derives an ETag from a canonical quote representation and never mixes cache identity across different response bodies.

## Error and contingency behavior

The current Dynamic Freight contract distinguishes failures that can use contingency from failures that must stop the quote.

| Error | Meaning | HTTP | Contingency behavior |
|---|---|---:|---|
| `-1` | integrator/internal failure | 500 | Mercado Libre may use contingency |
| `1` | item unavailable | 500 | item/quote failure |
| `2` | invalid destination | documented quote error | do not use contingency |
| `3` | no coverage | **400** | do not use contingency |
| `4` | item not found | 500 | item/quote failure |

The public contract helper has a hard guard for the explicitly documented `error_code=3 -> HTTP 400`; other quote/internal codes use HTTP 500 in the homologation boundary.

## Dynamic Freight quality metrics are partner-only observability

The 2026 contract also exposes Mercado Libre's partner-side quality metrics:

```text
GET /shipping/me1/sites/{site_id}/metrics
```

It reports latency, uptime, cache use, contingency percentage, revalidation percentage and error breakdown, optionally filtered by seller. `MLC` is an allowed site, but the resource is explicitly **exclusive to Dynamic Freight integrators**.

This repository does not fake or proxy that resource before certification. Once Maustian has the partner authorization, it should be consumed as an external SLO/quality signal and reconciled with our own endpoint telemetry.

## Contingency table is a fallback, not an activation bypass

Mercado Libre calls the fallback file **Tabla de Contingencia / Tabla Axado**. For Chile its geography is Región / Comuna. The current documentation says non-Brazil carrier/service tables use standard code `17`.

The 2026 API now exposes:

```text
GET  /shipping/me1/v1/tariff/template
POST /shipping/me1/v1/tariff/update
GET  /shipping/me1/v1/tariff/{resource_id}
POST /shipping/me1/v1/quotation/simulate
```

But `POST /shipping/me1/v1/tariff/update` explicitly requires the authenticated seller to **already have ME1 enabled**. Its callback must be a public HTTPS URL, not localhost/private IP.

Therefore:

> uploading a contingency table through the API cannot be used as a bootstrap trick to activate ME1 on an inactive seller.

It is management infrastructure for an existing ME1 seller/integrator relationship.

## `shipping_options` is not the live Dynamic Freight oracle

For ME1 items, Mercado Libre documents that:

```text
GET /items/{item_id}/shipping_options
```

returns the **contingency-table price**, not a fresh call to the external Dynamic Freight partner. That is intentional to avoid repeated partner requests.

The public runtime therefore treats `shipping_options` as useful read-only evidence, but never uses it to prove what the live Dynamic Freight endpoint would return.

For Chile the runtime now supports `city_to` instead of assuming a postal code.

## ME1 V2 order states and buyer tracking

Current status notifications use:

```text
POST /v2/shipments/{shipment_id}/seller_notifications
```

The old V1 route is scheduled for discontinuation on **2026-10-31**. The current V2 buyer experience rollout milestone in the official docs is **2026-09-14**.

For Chile:

```text
payload.service_id = 282578
```

The payload date is ISO-8601 with timezone. `substatus` is always present; use JSON `null` when there is no substatus. The string `"null"` is invalid. `tracking_number` and `tracking_url` are optional, but they form an inseparable pair.

### Current V2 status/substatus allowlist

`shipped` is non-final and can carry:

```text
null
out_for_delivery
soon_deliver
at_the_door
receiver_absent
bad_address
dangerous_area
unauthorized_receiver
impassable_zone
not_visited
documentation_issue
taxes_issue
fiscalization_issue
```

`delivered + null` is final and irreversible.

`not_delivered` is also final and irreversible and currently uses:

```text
refused_delivery
returned
```

The older `returning_to_sender` value is intentionally rejected by the current V2 planner.

### Buyer absent is not immediately a failed purchase

A failed delivery visit such as `shipped + receiver_absent` is a **non-final tracking event**. It tells Mercado Libre and the buyer that the visit failed, but it does not finalize the shipment.

Only when there will be no more delivery attempts should the flow move to final `not_delivered` (for example `returned`, depending on the actual outcome). That final state triggers the Marketplace return/refund lifecycle and must not be emitted casually.

## What the current core now implements

| Contract | State |
|---|---|
| ME1 V2 notification payload validator/planner | **FIT** |
| MLC `service_id=282578` | **FIT** |
| current V2 substatus allowlist | **FIT** |
| JSON-null + tracking pair enforcement | **FIT** |
| low-level ME1 write | **present but double-gated** |
| MLC item options via `city_to` | **FIT** |
| Dynamic Freight request validator | **FIT as homologation-preparation** |
| MELI-consolidated dimensions invariant | **FIT** |
| quotation/promise/service validation | **FIT** |
| ETag/cache helpers | **FIT** |
| error-code contract helper | **FIT** |
| Mercado Libre Dynamic Freight quality metrics consumer | **BLOCKED — partner-only authorization** |
| production Dynamic Freight endpoint | **BLOCKED — homologation/certification** |
| contingency upload for inactive seller | **BLOCKED by official prerequisite** |
| Carrier onboarding | separate track; see `MERCADO-ENVIOS-CARRIER-GAP.md` |

## Unified architecture

```text
                         MERCADO LIBRE
                    ┌─────────┴───────────┐
                    │                     │
          checkout / seller ME1     Carrier Integration
                    │                     │
          Dynamic Freight quote      coverage/auth/tracking
          seller_notifications            │
                    │                     │
                    └─────────┬───────────┘
                              ▼
                    generic logistics core
                    package/routing/tariff
                    idempotency/audit
                              │
                              ▼
                        courier adapter
                              │
                              ▼
                       physical provider
```

The public repository keeps these boundaries separate so that seller permissions, Dynamic Freight certification, Carrier onboarding and courier credentials can never silently substitute for one another.

## Primary official sources

- Mercado Libre Developers — `estados-de-ordenes-me1`, updated 2026-08-19.
- Mercado Libre Developers — `atributos-y-variaciones/flete-dinamico`, updated 2026-08-24.
- Mercado Libre Developers — shipping costs / item shipping options.
- Mercado Libre Developers — Mercado Envíos / ME1 overview.
