# Mercado Libre ME1 Chile Integrator

Open research and architecture for a **multi-tenant logistics integration platform for Mercado Libre Chile**, with a staged path from Custom shipping automation to a certified Mercado Envíos 1 (ME1) / Dynamic Freight integrator.

> Research cut: **25 August 2026 (Chile)**.
>
> This repository now includes an **executable v0.3.0 MVP runtime** plus the August 2026 research baseline. It contains no production credentials, no private courier endpoints and no live mutations against Mercado Libre or carriers by default.

## Why this project exists

Mercado Libre Chile allows sellers to manage heavy/bulky shipments through **ME1** using their own logistics or third parties. Chilean carriers including **Starken, Blue Express, Chilexpress and CorreosChile** expose integration capabilities that can automate quotes, transport orders/labels and tracking. Today these capabilities are often consumed through paid middleware.

The goal is to build a provider-neutral logistics core that can:

1. automate existing Mercado Libre **Custom** shipments;
2. connect directly to carrier APIs where contractual access is available;
3. onboard external sellers safely;
4. accumulate real seller usage/GMV;
5. qualify for the Mercado Libre **Developer Partner Program (DPP)**;
6. complete **Dynamic Freight homologation** and operate as a certified ME1 integrator.

## Current conclusions

- **ME1 is active in Chile** and is intended for products that are not eligible for ME2 because of size/weight/logistics constraints.
- **Dynamic Freight homologation is restricted to certified integrators**. A technically correct endpoint alone is not enough.
- For Chile, DPP currently requires active sellers using the solution with at least **USD 200,000 monthly GMV** in aggregate and a **Security Assessment score of at least 65%**.
- **ME1 tracking V2 is already in production**. V1 is scheduled to be discontinued on **31 October 2026**.
- Mercado Libre applications must be separated between Mercado Libre and Mercado Pago starting **30 August 2026**.
- Chile's **Law 21.719** on personal data enters into force on **1 December 2026**, which is directly relevant because logistics integrations process buyer names, addresses, phone numbers and shipment history.

## Carrier status

| Provider | Direct integration confirmed | Public capabilities confirmed | Access status |
|---|---:|---|---|
| Starken | Yes | Quote, OF issuance, label/plugin flow, tracking, POD, reverse logistics | API exists; server-to-server credentials/spec are commercially gated |
| Blue Express | Yes | Checkout rates, labels, tracking, pickup/ecommerce flows | API credentials managed through account/KAM; detailed production API is gated |
| Chilexpress | Yes | Address normalization, quote, OT/label, tracking push/pull, coverage, returns | Productive API credentials explicitly requested from Chilexpress |
| CorreosChile | Yes | Services, coverage, tariffs, admission, labels, branches, pickup, tracking | Developer portal is public; productive credentials require client account |
| Shipit | Yes (aggregator) | Multi-courier quote, shipment creation, tracking, coverage, webhooks | Public developer docs; token + account email |

See [`docs/COURIERS.md`](docs/COURIERS.md) for the evidence matrix and unresolved items.

## Target architecture

```text
Mercado Libre
  │
  ├─ OAuth / Orders / Shipments / Custom
  ├─ ME1 Dynamic Freight
  └─ seller_notifications V2
          │
          ▼
┌──────────────────────────────────────────┐
│           Logistics Integration Core     │
│                                          │
│  Tenant/Auth                             │
│  Quote Engine + tariff snapshots/cache  │
│  Shipment Orchestrator                   │
│  Tracking Normalizer                     │
│  Audit/Event Store                       │
│  Retry / DLQ / Idempotency               │
│  Metrics / SLO / Contingency             │
└──────────────────────────────────────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
   Starken   Blue Express  Chilexpress  CorreosChile
                                    └── optional aggregators (Shipit, etc.)
```

A core design rule is that the **Dynamic Freight quote path must not synchronously depend on carrier API availability**. Carrier tariffs/capabilities should be synchronized into versioned snapshots/cache so Mercado Libre can receive a fast deterministic quote even when a carrier API is slow or unavailable.

## Roadmap

**Phase A — research + contracts**  
Confirm API commercial access, auth, sandboxes, rate limits, idempotency, cancellation/returns and SLA for each carrier.

**Phase B — Custom Shipping SaaS**  
Automate Mercado Libre Custom shipments using direct carrier adapters. Use an internal pilot tenant first, then onboard external pilot sellers.

**Phase C — DPP readiness**  
Multi-tenancy, seller OAuth, PII controls, audit, reliability, support and seller GMV instrumentation. Reach the Chile DPP threshold with active users.

**Phase D — Dynamic Freight homologation**  
Complete Mercado Libre certification, security review, latency/cache/contingency requirements and ME1 Dynamic Freight tests.

**Phase E — certified logistics product**  
Offer ME1 + multiple carriers as a commercial service to other Mercado Libre sellers.

Detailed exit criteria are in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Critical 2026 dates

- **30 Aug 2026** — Mercado Libre / Mercado Pago applications must be separated.
- **14 Sep 2026** — new ME1 V2 tracking buyer experience expected fully productive.
- **31 Oct 2026** — ME1 `seller_notifications` V1 discontinued.
- **1 Dec 2026** — Chile Law 21.719 enters into force.

See [`docs/CHANGES-2026.md`](docs/CHANGES-2026.md).

## Documentation

- [`RESEARCH.md`](RESEARCH.md) — primary research and source ledger.
- [`docs/COURIERS.md`](docs/COURIERS.md) — carrier/API capability matrix.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — target system architecture.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — staged delivery and certification plan.
- [`docs/CHANGES-2026.md`](docs/CHANGES-2026.md) — upcoming deadlines and migrations.
- [`docs/MVP.md`](docs/MVP.md) — executable runtime, local API and integration contract workflow.
- [`docs/PUBLIC-PRIVATE-BOUNDARY.md`](docs/PUBLIC-PRIVATE-BOUNDARY.md) — repository boundary for generic product code vs tenant-specific pilot data.
- [`docs/AUTOMATIC-SHIPPING.md`](docs/AUTOMATIC-SHIPPING.md) — automatic packaging from a SKU/family dimension list and order-to-shipment flow.

## Evidence policy

This repository uses three evidence states:

- `CONFIRMED_PUBLIC_API` — official public documentation exposes the integration/API contract.
- `CONFIRMED_GATED_API` — official source confirms API capability, but credentials/specification require a commercial account, KAM or onboarding.
- `RESEARCH_REQUIRED` — integration is plausible but not yet supported by sufficiently current official evidence.

No private endpoint or authentication mechanism should be committed based only on an old GitHub snippet, leaked plugin code or third-party blog.

## Primary sources

Mercado Libre:
- https://developers.mercadolibre.cl/mercadoenvios-modo-1
- https://developers.mercadolibre.cl/en_us/dynamic-freight
- https://developers.mercadolibre.cl/es_ar/atributos-y-variaciones/developer-partner-program
- https://developers.mercadolibre.cl/estados-de-ordenes-me1
- https://developers.mercadolibre.cl/crea-una-aplicacion-en-mercado-libre-es
- https://developers.mercadolibre.cl/envios-flex

Carriers:
- https://www.starken.cl/integraciones
- https://starkenpro.cl/Integraciondeplugin
- https://www.blue.cl/empresas/soluciones-ecommerce
- https://chilexpress.cl/servicio-ecommerce-comercio-electronico-chile
- https://developers.correos.cl/
- https://developers.shipit.cl/reference/comienza-con-nuestra-api

Chile:
- https://www.bcn.cl/leychile/Navegar?idNorma=1209272&idVersion=2026-12-01

## MVP runtime

The first executable runtime is implemented with **Node.js 24 + TypeScript + Fastify + SQLite**. It includes tenant isolation, credential references, tariff snapshots, snapshot-first quotes, idempotent shipment creation, canonical tracking, audit logs and fail-closed provider adapters.

Version **0.2.0** also adds durable packaging profiles (`sku` / `family` / `default`), quantity-aware packing rules, bulk dimension-list import, deterministic carrier selection and `POST /v1/automatic-shipments`, so runtime requests no longer need to send package dimensions.

See [`docs/MVP.md`](docs/MVP.md) for local setup, endpoints and the procedure for loading the first official carrier contract.

## Status

**Research baseline: active. MVP runtime v0.3.0 implemented with automatic dimension-list shipping. Production integrations: not enabled. ME1 certification gate: disabled.**
