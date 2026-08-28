# Maustian Logistics — Launch Plan Chile

**Authoritative launch route**  
**Cut:** 2026-08-28  
**Product:** generic Mercado Libre logistics SaaS / future certified Dynamic Freight integrator  
**Primary market:** Chile (MLC)

This document is the launch authority for the business/product track. It separates what Maustian can build and sell now from what requires seller ME1 activation, Developer Partner certification, Dynamic Freight homologation, Partner Center publication or Mercado Envíos Carrier onboarding.

> Corporate decision: do **not** change company bylaws, SII activities/giro or municipal patent now. Re-open that topic only if a concrete, verified requirement blocks contracting, invoicing, DPP, Partner Center or Carrier onboarding.

## 1. Current verified state

Public product repository currently provides:

- multi-tenant logistics domain and tenant isolation;
- seller connection / Mercado Libre seller-owned shipping discovery;
- packaging profiles and quantity strategies;
- carrier routing and tariff snapshots;
- Starken generic adapter and catalog/routing primitives;
- controlled shipment preview/create/observation safety gates;
- shipment idempotency and audit;
- tracking normalization and monotonic final states;
- ME1 V2 `seller_notifications` contract guards;
- current Dynamic Freight request/response/cache/error contract guards;
- loopback-only Mercado Envíos Carrier test harness;
- selected official Carrier test evidence: **31/31 PASS** for OAuth, Coverage City, Agencies, Domestic Authorization, Last Mile and Conciliation 0260.

Current public branch baseline before this plan: `origin/main` at `186d4d7`.

The private first-seller pilot is a separate repository. No seller-specific origin, tariff, packaging, credential or operational data belongs here.

## 2. The three lanes

```text
LANE A — PRODUCT / DPP                 LANE B — SELLER ME1 PILOT
main business path                     production validation path

pre-certification SaaS                 certified temporary integrator
        ↓                                      ↓
external sellers                       seller ME1 activation
        ↓                                      ↓
GMV(e) >= USD 200k                     contingency + live operation
        ↓                                      ↓
DPP + security                         Maustian shadow comparison
        ↓                                      ↓
Dynamic Freight homologation           migrate only after certification


LANE C — MERCADO ENVIOS CARRIER
parallel strategic option

protocol readiness
        ↓
commercial/onboarding conversation
        ↓
Carrier ID + SERVICE_ID + contract
        ↓
production carrier homologation
```

The lanes share the same generic logistics core, but **authority never transfers between lanes**. DPP certification does not make Maustian a Mercado Envíos Carrier; Carrier test success does not activate ME1 for a seller.

## 3. Hard dates and immediate blockers

### 30 August 2026 — Mercado Libre / Mercado Pago application separation

Mercado Libre documents that from **30/08/2026** applications must be separated by business unit: one application for Mercado Libre and another for Mercado Pago. Applications that do not adapt can lose Mercado Libre API access.

Immediate action for **this product only**:

1. establish one canonical Mercado Libre application for the Maustian integrator product;
2. confirm the owner account/legal-entity ownership corresponds to Maustian as solution owner;
3. verify `GET /applications/{APP_ID}` contains no `urn:mp:*` scopes;
4. use this same application for every seller OAuth grant so DPP active-user/GMV(e) evidence is not fragmented across unrelated App IDs;
5. keep Client Secret and seller grants only in the deployment secret/token store, never Git;
6. configure PKCE, product-owned HTTPS callback, product-owned notification callback, minimum functional permissions and only consumed notification topics.

Apps belonging to other Maustian systems, seller storefronts, Ads tooling or Mercado Pago are outside this repository's scope unless they become an explicit dependency. See [`APPLICATION-IDENTITY.md`](APPLICATION-IDENTITY.md).

Official source: https://developers.mercadolibre.cl/crea-una-aplicacion-en-mercado-libre-es

### 31 October 2026 — ME1 V1 retirement

All new ME1 tracking/status work must use:

`POST /v2/shipments/{shipment_id}/seller_notifications`

V1 is scheduled to disappear on **31/10/2026**. MLC `service_id` is `282578`.

Official source: https://developers.mercadolibre.cl/estados-de-ordenes-me1

### 1 December 2026 — Chile personal-data reform

Law 21.719 enters into force on **01/12/2026**. The product processes seller, buyer, recipient, address, phone and shipment data, so privacy/data-governance readiness is a launch requirement rather than future polish.

Official source: https://www.bcn.cl/leychile/Navegar?idNorma=1209272

## 4. Phase 0 — application identity, legal surface and evidence baseline

**Objective:** remove administrative blockers before acquiring external sellers.

### Development / operations

- create/verify the **canonical Mercado Libre application for this integrator product** under the solution owner/legal entity;
- verify 30/08/2026 ML-vs-MP separation on that application via `GET /applications/{APP_ID}`;
- use one product App ID across all seller OAuth grants; do not create one App ID per seller;
- implement/document PKCE, OAuth callback, token rotation, token revocation/recovery and functional permissions;
- attribute active-seller/GMV(e) telemetry to the canonical product App ID;
- create a current architecture/data-flow diagram;
- create a product application/secret inventory;
- create a production/staging environment inventory;
- establish domain, support email and incident contact;
- maintain an audit trail for every seller authorization.

### Business/legal artifacts

Prepare before external onboarding:

- product Terms of Service;
- Privacy Notice/Policy;
- Data Processing terms / seller data-processing annex;
- subprocessors list;
- support/SLA policy;
- acceptable-use and suspension policy;
- pricing/billing terms;
- incident-notification contact;
- evidence that Maustian owns or is authorized to commercialize the product IP.

No corporate-giro change is required by this plan unless a concrete authority later demands it.

### Exit criteria

- app ownership documented;
- ML/MP separation verified;
- no secrets in Git/logs;
- OAuth works with a controlled seller account;
- legal/support baseline published or ready for pilot contracts;
- data-flow inventory exists.

## 5. Phase 1 — sellable pre-certification SaaS

**Objective:** create value and onboard external sellers before DPP/ME1 certification.

The product must be useful without claiming certified ME1 Dynamic Freight.

### Minimum sellable capability

1. seller OAuth onboarding;
2. order/shipment ingestion;
3. SKU/package dimensions and packaging rules;
4. one or more carrier connections per tenant;
5. tariff/coverage snapshots;
6. cost/SLA routing;
7. provider shipment creation where contractually supported;
8. labels/evidence where provider supports them;
9. provider tracking ingestion;
10. reconciliation between marketplace order, carrier shipment and cost;
11. incident/failure queue;
12. tenant-scoped audit log;
13. billing-meter skeleton;
14. GMV(e) attribution telemetry;
15. health/SLO dashboards.

### Critical product rule

Normal Dynamic Freight-style quotation logic must be snapshot-first. Do not synchronously call a courier API for every checkout-style quote. Carrier rates/coverage should be synchronized, versioned and served locally.

### Exit criteria

- second seller can be onboarded without code changes;
- tenant isolation automated tests pass;
- no duplicate provider shipment under replay/concurrency tests;
- carrier reconciliation is measurable;
- support has a manual recovery path;
- seller activity and GMV(e) can be attributed to the Maustian application.

## 6. Phase 2 — first real seller ME1 validation

**Objective:** obtain real ME1 checkout/tracking evidence without pretending Maustian is already certified.

Current seller-side Mercado Libre guidance requires:

- seller reputation not red;
- products with `entrega a acordar` / not using normal Mercado Envíos;
- active contract with a **certified Dynamic Freight integrator**;
- integration hub capable of migrating publications;
- updated contingency table (Mercado Libre recommends review every 3 months);
- the certified integrator requests ME1 activation;
- the integrator contract remains active to avoid ME1 deactivation.

Official sources:

- https://vendedores.mercadolibre.cl/aprender/nota/como-activar-mercado-envios-1-me1?guideKeyId=GE76&moduleKeyId=MO348
- https://vendedores.mercadolibre.cl/aprender/nota/cuidados-para-mantener-me1-activo

### Operating model

```text
certified integrator = production authority
Maustian            = shadow/read-only comparator
```

Maustian should independently calculate:

- expected quote;
- expected carrier;
- expected SLA;
- expected package dimensions;
- expected tracking mapping;
- expected logistics contribution/margin.

Differences are evidence for product improvement; they must not modify the seller's certified ME1 authority while Maustian is not homologated.

### Publication-history rule

Never recreate/swap marketplace items merely to force ME1. Use item-specific `shipping_modes` prevalidation and a controlled migration path that preserves listing history where Mercado Libre permits it.

### Exit criteria

- seller visibly has `me1` on selected shipments/items;
- contingency tariff is accepted and active;
- checkout price/promise is observed;
- at least one controlled end-to-end shipment completes;
- Maustian shadow quote/tracking/cost comparison is recorded;
- no seller reputation or listing-history regression.

## 7. Phase 3 — external sellers and the GMV(e) campaign

**Objective:** become eligible to apply to the Chile Developer Partner Program.

Mercado Libre currently publishes for Chile:

- platform good practices;
- formal DPP application;
- **USD 200,000 monthly GMV(e)** of active sellers using the solution;
- Security Assessment **>=65%**;
- minimum initiatives assigned by an Integration Expert.

GMV(e) is based on active users of the application (usage during the prior three months) and their Mercado Libre billing/transactions.

Official source: https://developers.mercadolibre.cl/es_cl/developer-partner-program

### Commercial target

Do not optimize initially for hundreds of tiny sellers. Prefer a small number of medium/high-GMV sellers whose logistics problem is acute.

Example target structure:

```text
seller A   USD 60k/month
seller B   USD 50k/month
seller C   USD 45k/month
seller D   USD 45k/month
------------------------
GMV(e)     USD 200k/month
```

This is an illustration, not a Mercado Libre requirement on seller count.

### Ideal initial categories

- bulky / oversize products;
- furniture and mattresses;
- construction/ferreteria;
- rolls/materials;
- appliances/equipment;
- large spare parts;
- sellers currently using entrega a acordar or manual freight coordination.

### Required evidence

For every seller retain:

- Mercado Libre seller/user id;
- app authorization date;
- active-use evidence;
- monthly order/GMV attribution;
- features actually used;
- carrier connections;
- operational uptime/error metrics;
- support/incident history.

### Exit criteria

- active external sellers continuously use Maustian;
- evidence-backed GMV(e) >= USD 200k/month;
- >=30 days stable production operation;
- no unresolved critical security finding;
- DPP evidence pack ready.

## 8. Phase 4 — security, privacy and DPP application

**Objective:** enter certification with margin, not at the minimum.

Mercado Libre publishes **65%** as the Security Assessment pass threshold. Internal target should be **>=85%** before applying.

### Security evidence pack

- MFA/privileged-access policy;
- RBAC/tenant isolation;
- secret manager and rotation;
- dependency scanning;
- SAST/secret scanning;
- TLS/security headers;
- rate limiting and abuse protection;
- webhook authentication/replay protection;
- idempotency and duplicate-write controls;
- audit logging without secrets/PII leakage;
- backup/restore evidence;
- incident response runbook;
- vulnerability handling;
- data deletion/retention procedures;
- architecture and data-flow diagrams;
- production SLOs/alerts;
- change/release evidence.

Mercado Libre can block applications for KYC/T&C violations, excessive API usage or data infractions, so API governance is part of launch safety.

Official sources:

- https://developers.mercadolibre.cl/es_cl/developer-partner-program
- https://developers.mercadolibre.cl/es_cl/buenas-practicas-para-uso-de-la-plataforma
- https://developers.mercadolibre.cl/bloqueo-de-aplicaciones

### Privacy readiness before 01/12/2026

Maintain:

- data inventory;
- purpose/legal-basis mapping;
- seller/controller-processor responsibility mapping;
- data-retention schedule;
- access/deletion workflow;
- subprocessors and hosting regions;
- incident/breach process;
- secure logging and minimization;
- transfer/backup map;
- buyer-data access controls.

### DPP submission

Submit only when the published gates are evidence-backed. Once in process, expect Mercado Libre to assign initiatives through an Integration Expert.

### Maintenance reality

Certification creates an ongoing engineering obligation. Current DPP rules include:

- mandatory platform changes: 15-day adaptation window;
- urgent performance/security/regulatory issues: response within 8 hours and post-mortem within 48 hours;
- up to four assigned initiatives per quarter, excluding mandatory changes/technical debt;
- quarantine/downgrade/removal if delivery obligations are missed.

This means on-call/change-management capability is part of the product, not optional overhead.

## 9. Phase 5 — Dynamic Freight homologation

**Objective:** replace the temporary certified integrator with Maustian for sellers that migrate.

Mercado Libre states that Dynamic Freight homologation is reserved to integrators in the certification process.

Current homologation package includes:

- endpoint URL;
- communication headers;
- request/body contract;
- application name and app ID;
- demonstration video;
- technical/security validation;
- initial load/latency validation;
- cache behavior;
- error monitoring;
- Mercado Libre contingency.

Performance target: **<400 ms**. Mercado Libre documents Dynamic Freight infrastructure in **US East / Virginia**.

Official source: https://developers.mercadolibre.cl/es_ar/publica-productos/flete-dinamico

### Production architecture gate

```text
Mercado Libre Virginia
        ↓
Maustian low-latency quote edge
        ↓
local/versioned tariff + coverage + routing snapshot
        ↓
quote response
```

Courier APIs synchronize asynchronously. They are not a mandatory synchronous dependency for each quote.

### Contingency

The seller must maintain a valid ME1 contingency tariff. Mercado Libre documents APIs for template retrieval, upload/status and quotation simulation, but seller tariff upload/simulation is gated by the seller already having ME1. These APIs **cannot be used to self-activate ME1**.

### Migration rule

Do not split one seller's Dynamic Freight authority between two integrators. Migrate seller-by-seller with:

1. shadow comparison;
2. homologated endpoint ready;
3. contingency verified;
4. cutover window;
5. post-cutover quote/tracking monitoring;
6. rollback path coordinated with Mercado Libre/integrator.

### Exit criteria

- Mercado Libre approves/homologates endpoint;
- latency/load/security pass;
- contingency verified;
- first migrated seller completes stable checkout and tracking;
- migration runbook is repeatable.

## 10. Phase 6 — Partner Center commercial launch

**Objective:** turn certification into distribution.

The Centro de Partners is for certified solutions under Mercado Libre Partner Programs. Current terms make the Partner responsible for the solution, pricing, quality, support, legal compliance and rights/licenses over its IP/content.

If direct subscription/payment inside Partner Center is used, the Partner must identify the Mercado Pago account that receives those payments.

Official sources:

- https://centrodepartners.mercadolibre.cl/
- https://centrodepartners.mercadolibre.cl/terminos-y-condiciones-cl

### Required commercial pack

- product name/brand;
- logo/screenshots/demo;
- value proposition;
- public pricing or contact-sales model;
- Terms;
- Privacy;
- support channel/SLA;
- onboarding instructions;
- cancellation/refund terms where applicable;
- IP ownership/authorization evidence;
- receiving Mercado Pago account if using direct Partner Center transactionality.

## 11. Parallel Lane C — Mercado Envíos Carrier

Carrier is **not** a prerequisite for launching the SaaS or reaching DPP.

### Already demonstrated technically

Selected official MLC Carrier scenarios have been passed locally for:

- OAuth;
- Coverage City;
- Agencies;
- Domestic Authorization;
- Last Mile;
- Conciliation 0260.

### Officially provisioned values

The public test suite documents:

```text
SITE_ID=MLC
SERVICE_ID=<provided by Mercado Libre>
SERVICE_NAME=...
CARRIER_CLIENT_ID=...
CARRIER_CONTRACT=...
CARRIER_ACCOUNT=...
CARRIER_USER=...
CARRIER_PASSWORD=...
SERVICE_LOGISTIC=drop_off | cross_docking | fulfillment
```

`SERVICE_ID` is explicitly described as supplied by Mercado Libre.

Official source: https://developers.mercadoenvios.com/en_us/carriers-test-suite

### Bureaucratic/commercial gate

No public DPP-style Chile GMV threshold was found for Carrier onboarding. Therefore the next useful action is business development, not additional speculative logistics build-out.

Ask Mercado Envíos:

1. process/contact for new Carrier evaluation in MLC;
2. whether a 4PL/orchestrator that subcontracts physical transport is eligible;
3. minimum parcel volume/coverage/capacity expectations;
4. insurance/legal/financial requirements;
5. required operational SLA/KPIs;
6. process to receive Carrier ID and SERVICE_ID;
7. accepted operation types for a new Chile carrier;
8. test/stage and production homologation sequence.

Until Mercado Libre answers, treat volume, fleet, insurance and physical-network thresholds as **unknown/inferred**, not official requirements.

### Investment gate

Continue maintaining protocol compatibility with the official suite. Do not invest materially in a physical carrier network solely to chase onboarding until Mercado Libre confirms commercial eligibility.

## 12. Bureaucracy matrix

| Gate | Who owns it | Evidence needed | Can Maustian do it alone? |
|---|---|---|---|
| ML/MP app separation | Maustian | DevCenter app inventory | Yes |
| Seller OAuth | Maustian + seller | authorization grant | Yes with seller consent |
| Pre-certification SaaS | Maustian | production product | Yes |
| Seller ME1 activation | seller + certified integrator + MELI | reputation, contract, contingency, hub | No |
| USD 200k GMV(e) | Maustian + external sellers | active usage + attributable GMV | Yes commercially, not instantly |
| Security Assessment >=65% | Maustian + MELI assessment | security evidence | Mostly; approval external |
| DPP acceptance | Mercado Libre | formal application + gates | No |
| Assigned initiatives | Maustian + Integration Expert | delivered/validated initiatives | Shared |
| Dynamic Freight homologation | Mercado Libre | endpoint/video/load/security/cache/contingency | No |
| Partner Center publication | Mercado Libre + Maustian | certification + commercial/legal pack | No |
| Carrier ID/SERVICE_ID | Mercado Envíos | commercial onboarding | No |
| Carrier production homologation | Mercado Envíos + Maustian | contract + technical/operational evidence | No |
| Company-giro change | Maustian/SII/other authority | only if concrete blocker appears | Not currently required by plan |

## 13. Development backlog ordered by business value

### P0 — now

- audit ML/MP app separation before/at 30/08/2026;
- harden seller OAuth and callback lifecycle;
- GMV(e) telemetry;
- external-tenant onboarding flow;
- production data inventory/privacy baseline;
- incident/support runbooks;
- shadow quote/tracking comparison framework;
- current ME1 V2 only.

### P1 — first external sellers

- self/assisted onboarding;
- carrier credential lifecycle;
- tariff snapshot refresh workers;
- routing policy UI/API;
- reconciliation dashboard;
- failure queue;
- billing meter;
- usage/GMV dashboard;
- seller health/KYC/account-status checks.

### P2 — DPP readiness

- formal Security Assessment gap tracker;
- SLO/alerting/on-call;
- privacy requests/deletion;
- backup/DR evidence;
- performance/load harness;
- developer documentation;
- support tooling/RBAC;
- release/change-management process.

### P3 — homologation

- Virginia/US-East quote deployment option;
- Dynamic Freight production gateway;
- quote/version traceability;
- ETag/cache observability;
- contingency orchestration;
- homologation video/evidence generator;
- seller migration tooling.

### P4 — post-certification

- Partner Center listing/onboarding;
- subscription/billing integration if desired;
- regionalization preparation;
- additional carriers/countries.

## 14. Decision gates

### Gate A — external seller onboarding
Proceed when tenant isolation, OAuth, secrets, audit and recovery are verified.

### Gate B — seller ME1 pilot
Proceed only through a certified integrator and current official ME1 activation flow; never claim Maustian certification early.

### Gate C — DPP application
Proceed only when active-seller GMV(e) >= USD 200k/month, security evidence is strong and no critical blocker remains.

### Gate D — Dynamic Freight production
Proceed only after Mercado Libre homologation.

### Gate E — migrate a seller from another integrator
Proceed only as a coordinated full cutover with contingency and rollback; never split authority.

### Gate F — Carrier investment
Proceed beyond protocol readiness only after Mercado Envíos confirms MLC commercial eligibility/onboarding path.

### Gate G — company giro/bylaw changes
Proceed only if a concrete verified legal, tax, contracting or Mercado Libre onboarding requirement makes the current structure a blocker.

## 15. What success looks like

```text
Maustian generic SaaS
       ↓
multiple active sellers
       ↓
measurable logistics value + GMV(e)
       ↓
USD 200k/month Chile
       ↓
DPP / Silver certification
       ↓
Dynamic Freight homologation
       ↓
controlled seller migrations
       ↓
Partner Center distribution
       ↓
regional expansion

Carrier remains an optional second business line,
not a dependency on the SaaS path.
```

## 16. Official references

- Mercado Libre application creation / 30-08-2026 separation: https://developers.mercadolibre.cl/crea-una-aplicacion-en-mercado-libre-es
- Functional permissions / legal-entity ownership recommendation: https://developers.mercadolibre.cl/es_ar/permisos-funcionales
- Developer Partner Program: https://developers.mercadolibre.cl/es_cl/developer-partner-program
- Dynamic Freight homologation: https://developers.mercadolibre.cl/es_ar/publica-productos/flete-dinamico
- ME1 activation: https://vendedores.mercadolibre.cl/aprender/nota/como-activar-mercado-envios-1-me1?guideKeyId=GE76&moduleKeyId=MO348
- Maintaining ME1: https://vendedores.mercadolibre.cl/aprender/nota/cuidados-para-mantener-me1-activo
- ME1 V2 tracking: https://developers.mercadolibre.cl/estados-de-ordenes-me1
- Platform good practices: https://developers.mercadolibre.cl/es_cl/buenas-practicas-para-uso-de-la-plataforma
- Application blocking: https://developers.mercadolibre.cl/bloqueo-de-aplicaciones
- Centro de Partners: https://centrodepartners.mercadolibre.cl/
- Centro de Partners terms: https://centrodepartners.mercadolibre.cl/terminos-y-condiciones-cl
- Carrier test suite: https://developers.mercadoenvios.com/en_us/carriers-test-suite
- Chile Law 21.719: https://www.bcn.cl/leychile/Navegar?idNorma=1209272
