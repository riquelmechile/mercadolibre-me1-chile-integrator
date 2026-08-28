# Mercado Libre ME1 Chile Integrator

**Provider-neutral logistics control plane for Mercado Libre Chile.**

Build and validate multi-carrier Custom Shipping flows today, while keeping the quote, shipment, tracking and safety architecture ready for a future certified **Mercado Envíos 1 (ME1) / Dynamic Freight** integration.

<p>
  <img alt="Runtime v0.10.0" src="https://img.shields.io/badge/runtime-v0.10.0-2563eb">
  <img alt="89 tests passing" src="https://img.shields.io/badge/tests-89%2F89%20passing-16a34a">
  <img alt="Node.js 24 or newer" src="https://img.shields.io/badge/node-%E2%89%A524-339933">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-runtime-3178c6">
  <img alt="ME1 production gate disabled" src="https://img.shields.io/badge/ME1%20production-gated-f59e0b">
</p>

<img src="https://raw.githubusercontent.com/riquelmechile/mercadolibre-me1-chile-integrator/main/docs/assets/control-plane.svg" alt="Controlled shipment lifecycle: preview, explicit approval, one create attempt and observation while the carrier connection remains disabled." width="100%">

> **Current release:** `v0.10.0` · research baseline: Chile, August 2026.
> The repository contains an executable MVP, public research and generic provider adapters. It contains **no tenant production credentials, buyer data or private pilot configuration**.

## What works today

| Capability | State | Current implementation |
|---|---|---|
| Multi-tenant logistics runtime | ✅ Implemented | Node.js 24 + TypeScript + Fastify + SQLite |
| Snapshot-first quoting | ✅ Implemented | Versioned tariff snapshots, coverage and volumetric weight |
| Packaging resolution | ✅ Implemented | SKU/family/default profiles with quantity-aware packing rules |
| Carrier location catalogs | ✅ Implemented | Versioned region/city/commune/agency catalogs and local routing |
| Starken quote / OF / tracking | ✅ Implemented | Official plugin-gateway protocol with evidence-based mappings |
| Seller-owned Mercado Libre shipping planner | ✅ Implemented | Reads seller/category/item capability, MLC `city_to`, Custom and strict ME1 V2 dry-run plans |
| Controlled first-production lifecycle | ✅ Implemented | Preview → exact approval/create → observation while carrier stays disabled |
| Shipment idempotency | ✅ Implemented | Atomic claims + normalized request fingerprint |
| Tracking normalization | ✅ Implemented | Deduplication, deterministic ordering and monotonic final states |
| Blue Express / Chilexpress | 🔒 Contract-gated | Provider shells exist; production mappings wait for official contracts |
| ME1 Dynamic Freight contract | ✅ Prepared / 🔒 production-gated | Request/quote/cache/error guards implemented; homologation remains certification-gated |
| Mercado Envíos Carrier contract | ✅ Local oracle / 🔒 onboarding-gated | Official suite selected flows 31/31 PASS; Carrier ID/SERVICE_ID remain external |

The runtime deliberately fails closed when provider evidence, seller/category shipping eligibility, credentials, routing, status mappings or certification prerequisites are incomplete. Seller-owned Custom Shipping is never assumed from OAuth/write scope alone.

## Seller-owned Mercado Libre path

For sellers that actually expose `custom` in current Mercado Libre shipping preferences and compatible category/item evidence, v0.10.0 can discover eligibility and build deterministic **dry-run** plans for item Custom Shipping configuration and Custom shipment status/tracking updates. It does not expose a live item-shipping write endpoint.

ME1 activation and Dynamic Freight homologation are separate gates. Current developer docs expose a KAM/support or direct-request channel for ME1, while current seller guidance still lists a certified Dynamic Freight integrator as an activation requirement. The core records that official conflict rather than assuming either path; Dynamic Freight endpoint homologation itself remains explicitly certification-gated.

Read [`docs/SELLER-OWNED-CUSTOM-SHIPPING.md`](docs/SELLER-OWNED-CUSTOM-SHIPPING.md) for the seller decision model, [`docs/ME1-DYNAMIC-FREIGHT-AUDIT.md`](docs/ME1-DYNAMIC-FREIGHT-AUDIT.md) for the current checkout/tracking contract, and [`docs/MERCADO-ENVIOS-CARRIER-GAP.md`](docs/MERCADO-ENVIOS-CARRIER-GAP.md) for the separate carrier track.

## The controlled shipment safety model

The first real shipment for a newly integrated carrier should not require enabling normal automation.

1. **Preview-only** — obtain a live quote and let the server derive the normalized create-payload SHA-256.
2. **Explicit approval** — a human approves the exact shipment summary and exact digest.
3. **Approval-only create** — one idempotent provider create attempt is allowed for that exact payload.
4. **Observation-only** — reconcile issuance → freight order and ingest tracking through short-lived read-only sessions.

Throughout the ceremony, `CarrierConnection.enabled` remains `false`. Controlled modes are loopback-only, mutually exclusive, limited to ≤60-minute windows, use ephemeral secret hashes and lock unrelated mutations.

Read the full contract in [`docs/CONTROLLED-SHIPMENT-CEREMONY.md`](docs/CONTROLLED-SHIPMENT-CEREMONY.md).

## Run it locally

The shortest successful path uses the mock carrier and never touches a production provider.

```bash
npm ci
cp .env.example .env
npm run check
npm run dev
```

Default local bind:

```text
http://127.0.0.1:8787
```

Verify the runtime:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

For the complete tenant → carrier → tariff snapshot → quote → shipment example, follow [`docs/MVP.md`](docs/MVP.md).

## Mental model

```text
Mercado Libre / seller workflows
              │
              ▼
┌──────────────────────────────────────────────┐
│          Logistics Integration Core          │
│                                              │
│ tenant isolation    packaging + routing      │
│ snapshot quotes     idempotent shipments     │
│ audit/events        tracking normalization   │
└───────────────────────┬──────────────────────┘
                        │ provider-neutral contract
                        ▼
            CourierAdapter registry
               │       │       │
               ▼       ▼       ▼
            Starken   Blue   Chilexpress   …
```

Three rules shape the system:

- **Snapshot-first quote path** — future Dynamic Freight quoting must not depend synchronously on carrier availability when a valid local snapshot exists.
- **Evidence-based adapters** — undocumented provider production contracts are not guessed into the repository.
- **Tenant + secret isolation** — operational records keep `credentialRef` values; raw credentials remain in the runtime secret provider.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full target architecture and current implementation boundary.

## Carrier integration status

| Provider | Public integration evidence | Runtime state |
|---|---|---|
| **Starken** | Quote, OF issuance, label/plugin flow, tracking, POD, reverse logistics | Official plugin gateway implemented |
| **Blue Express** | Ecommerce rates, labels, tracking, pickup flows | Contract-gated adapter shell |
| **Chilexpress** | Address, quote, OT/label, tracking, coverage, returns | Contract-gated adapter shell |
| **CorreosChile** | Services, coverage, tariffs, admission, labels, branches, pickup, tracking | Research / future adapter |
| **Shipit** | Multi-courier quote, shipment creation, tracking, coverage, webhooks | Optional aggregator research |

The evidence matrix and unresolved contract questions live in [`docs/COURIERS.md`](docs/COURIERS.md).

## Documentation by task

| I want to… | Start here |
|---|---|
| run the executable MVP | [`docs/MVP.md`](docs/MVP.md) |
| understand the system architecture | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| evaluate seller-owned Custom Shipping | [`docs/SELLER-OWNED-CUSTOM-SHIPPING.md`](docs/SELLER-OWNED-CUSTOM-SHIPPING.md) |
| audit current ME1 + Dynamic Freight Chile | [`docs/ME1-DYNAMIC-FREIGHT-AUDIT.md`](docs/ME1-DYNAMIC-FREIGHT-AUDIT.md) |
| compare against Mercado Envíos Carrier homologation | [`docs/MERCADO-ENVIOS-CARRIER-GAP.md`](docs/MERCADO-ENVIOS-CARRIER-GAP.md) |
| understand automatic packaging/shipping | [`docs/AUTOMATIC-SHIPPING.md`](docs/AUTOMATIC-SHIPPING.md) |
| understand carrier location catalogs | [`docs/CARRIER-CATALOGS.md`](docs/CARRIER-CATALOGS.md) |
| inspect the Starken runtime contract | [`docs/STARKEN-CONTRACT.md`](docs/STARKEN-CONTRACT.md) |
| audit Starken evidence provenance | [`docs/STARKEN-EVIDENCE.md`](docs/STARKEN-EVIDENCE.md) |
| run a controlled first shipment | [`docs/CONTROLLED-SHIPMENT-CEREMONY.md`](docs/CONTROLLED-SHIPMENT-CEREMONY.md) |
| understand public/private repository boundaries | [`docs/PUBLIC-PRIVATE-BOUNDARY.md`](docs/PUBLIC-PRIVATE-BOUNDARY.md) |
| follow certification/product milestones | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| review 2026 migrations/deadlines | [`docs/CHANGES-2026.md`](docs/CHANGES-2026.md) |
| inspect research and primary sources | [`RESEARCH.md`](RESEARCH.md) |

## Path to a certified ME1 product

```text
A. Official carrier contracts + direct adapters
              ↓
B. Custom Shipping SaaS with internal/external pilots
              ↓
C. DPP readiness: security, tenants, support, seller GMV
              ↓
D. Dynamic Freight homologation + contingency/SLO tests
              ↓
E. Certified multi-carrier ME1 logistics product
```

Production ME1 publication remains intentionally gated. A technically correct endpoint is not treated as certification.

### Near-term 2026 gates tracked by this repository

- **30 Aug 2026** — Mercado Libre / Mercado Pago applications separation.
- **14 Sep 2026** — ME1 V2 tracking buyer-experience rollout milestone tracked by the research baseline.
- **31 Oct 2026** — ME1 `seller_notifications` V1 discontinuation.
- **1 Dec 2026** — Chile Law 21.719 personal-data regime enters into force.

See [`docs/CHANGES-2026.md`](docs/CHANGES-2026.md) for the maintained change ledger.

## Evidence and repository boundaries

Provider claims are classified as:

- `CONFIRMED_PUBLIC_API` — current official public documentation exposes the contract.
- `CONFIRMED_GATED_API` — official evidence confirms the capability, but specification/credentials require commercial onboarding.
- `RESEARCH_REQUIRED` — implementation must remain gated until stronger evidence exists.

The public repository contains reusable product code and public evidence only. Tenant-specific origins, measured commercial data, credentials, buyer information and production-order evidence belong in private tenant overlays or secret stores. See [`docs/PUBLIC-PRIVATE-BOUNDARY.md`](docs/PUBLIC-PRIVATE-BOUNDARY.md).

## Current project status

**Research baseline active · executable MVP v0.10.0 · seller-owned Custom capability discovery + dry-run planning implemented · Starken controlled lifecycle implemented · normal carrier automation disabled until explicitly activated · Dynamic Freight production still certification-gated.**
