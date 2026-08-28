# Roadmap — Custom → DPP → certified ME1

**Baseline date:** 28 August 2026

The project should not start by pretending to be a certified ME1 Dynamic Freight integrator. The fastest credible route is to build useful logistics automation first, acquire active sellers, then qualify for certification.

## Phase 0 — research and provider contracts

### Goal
Remove uncertainty around current provider contracts before runtime code depends on them.

### Work
- confirm Mercado Libre seller OAuth/application model after the 30-Aug-2026 separation rule;
- complete Starken pilot hardening: scheduled catalog refresh/observability, verified tracking-status map and controlled live OF validation;
- request Blue Express API specification/credentials;
- request Chilexpress productive API credentials/spec;
- establish CorreosChile business/client credentials and REST v2 contract;
- document sandbox/test modes, rate limits, idempotency and SLAs;
- build provider capability matrix from official contracts.

### Exit criteria
- at least one direct carrier has an authorized current API contract suitable for a production PoC;
- no adapter depends on reverse-engineered/private endpoints;
- DPP and ME1 requirements are represented as tracked product requirements.

---

## Phase 1 — Custom Shipping MVP

### Goal
Automate the logistics work already possible without ME1 Dynamic Freight certification.

### Minimum product
- tenant model;
- Mercado Libre seller OAuth connection;
- order/shipment ingestion;
- packaging profile per SKU;
- one direct carrier adapter;
- create shipment/OF/OT where supported;
- label retrieval;
- tracking number persistence;
- provider tracking ingestion/polling;
- Mercado Libre Custom shipment/tracking update where supported;
- retry/idempotency/audit;
- operational dashboard and failure queue.

### First operating case
Use a real seller operation as a controlled pilot before external onboarding. The goal is to prove:

- shipment creation correctness;
- cost/quote reconciliation;
- tracking reliability;
- label workflow;
- recoverability from provider/API failures.

### Exit criteria
- >= 30 days of stable real operation;
- no duplicate shipment creation under replay tests;
- shipment creation reconciliation >= 99.9%;
- tracking pipeline has measured lag/SLO;
- credentials and buyer PII are not exposed in logs;
- clear manual recovery procedure exists.

---

## Phase 2 — multi-tenant pilot SaaS

### Goal
Turn the internal integration into a product used by external Mercado Libre sellers.

### Product additions
- self-service/assisted tenant onboarding;
- multiple Mercado Libre sellers;
- multiple carrier connections per tenant;
- per-tenant shipping policies;
- role-based access;
- billing/plan meter skeleton;
- support tooling with audited impersonation/access;
- provider health and credential-expiry alerts;
- GMV/user activity instrumentation required for DPP readiness.

### Suggested pilot target
Acquire sellers whose combined Mercado Libre monthly GMV can eventually exceed the Chile DPP threshold of **USD 200,000/month**.

The exact seller count is less important than active usage and aggregate GMV.

### Exit criteria
- active external sellers use the platform continuously;
- aggregate active-seller GMV is measurable and attributable to the application;
- multi-tenant isolation has automated verification;
- support and incident handling are documented;
- security assessment gap analysis indicates path to >=65%.

---

## Phase 3 — DPP readiness and application

### Goal
Meet the current Chile Developer Partner Program admission requirements.

### Current official admission facts
- sellers actively use the solution;
- Chile threshold: **USD 200,000 monthly GMV**;
- Security Assessment: **>=65%**;
- platform good practices;
- formal application.

Source: https://developers.mercadolibre.cl/es_ar/atributos-y-variaciones/developer-partner-program

### Required engineering maturity
- production SLOs and alerting;
- incident response/on-call ownership;
- audit and traceability;
- secret management/rotation;
- PII minimization and deletion;
- dependency/security scanning;
- rate-limit controls;
- replay/idempotency safeguards;
- disaster recovery/backups;
- documented architecture and data flows.

### Exit criteria
- DPP application accepted / certification path opened;
- assigned Mercado Libre requirements/integration initiatives tracked;
- no unresolved critical security findings.

---

## Phase 4 — Dynamic Freight homologation

### Goal
Certify the quote endpoint and operational integration for ME1 Dynamic Freight.

### Product work
- ME1 quote endpoint contract (current request/response/cache/error guards already implemented);
- active tariff/coverage snapshots;
- quote cache / ETag revalidation;
- deterministic pricing policy;
- Mercado Libre contingency handling;
- latency/error SLO dashboards;
- test tenant/seller/item fixtures;
- traceable quote versioning;
- failure/fallback tests;
- homologation evidence pack.

### Design constraint
Normal quote serving should not make a blocking call to Starken/Blue/Chilexpress on every Mercado Libre request. Carrier data should be synchronized and versioned.

### Exit criteria
- Mercado Libre homologation passes;
- production endpoint registered/approved;
- contingency tests pass;
- required latency/reliability metrics remain inside agreed limits;
- seller onboarding to ME1 has a controlled process.

---

## Parallel track — Mercado Envíos Carrier onboarding

The official Carrier Integration test suite is now used as a local external oracle. Selected MLC flows for OAuth, Coverage City, Agencies, Domestic Authorization and Last Mile/Conciliation are green against the fixture harness. This track is still commercially blocked on Mercado Libre-assigned Carrier ID, SERVICE_ID, carrier contract and focal-point onboarding.

It must remain separate from DPP/Dynamic Freight: passing carrier API tests does not activate ME1 for a seller, and ME1 certification does not make an application a Mercado Envíos carrier.

See [`INTEGRATOR-VS-CARRIER.md`](INTEGRATOR-VS-CARRIER.md) for the current admission gates, commercial roles and technical responsibilities of both tracks.

---

## Phase 5 — ME1 tracking V2 production

### Goal
Provide reliable buyer-visible tracking through the current ME1 V2 contract.

### Required behavior
- use `/v2/shipments/{shipment_id}/seller_notifications`;
- map provider events to Mercado Libre V2 status/substatus;
- always include valid `substatus` or JSON null;
- pair tracking number + tracking URL;
- prevent duplicate/final-state regressions;
- monitor publication failures and lag.

### Time constraint
V1 is scheduled for discontinuation on **31 October 2026**, so there is no reason to implement new code against V1.

---

## Phase 6 — commercial certified product

### Goal
Sell a focused logistics/ME1 service to other Mercado Libre sellers.

### Potential packaging

#### Starter
- one Mercado Libre seller;
- one carrier;
- quotes/ME1;
- labels;
- tracking;
- dashboard.

#### Pro
- multiple carriers;
- shipping rules;
- advanced alerts;
- reconciliation;
- analytics;
- API/webhooks for seller ERP/WMS.

#### Enterprise
- multiple sellers/accounts;
- RBAC/SSO;
- SLA;
- custom origins/warehouses;
- audit exports;
- dedicated support;
- custom carrier contracts.

Pricing should be validated with pilots rather than copied from broad omnichannel suites.

---

## Phase 7 — additional channel/courier expansion

Possible future modules:

- Mercado Libre Flex courier integration;
- additional Chilean carriers;
- own-fleet/TMS adapter;
- warehouse/WMS interfaces;
- carrier cost reconciliation;
- automated provider selection based on cost/SLA;
- returns/reverse logistics orchestration.

Do not merge unrelated channel behavior into the ME1 adapter. Maintain clear contracts between channel, core and provider layers.

---

## Decision gates

### Gate A — build runtime?
Proceed only after at least one direct carrier contract/spec is officially available.

### Gate B — onboard external sellers?
Proceed only after tenant isolation, secrets, audit and recovery are verified.

### Gate C — apply to DPP?
Proceed only when active-seller GMV and security threshold are evidence-backed.

### Gate D — expose ME1 production endpoint?
Proceed only through Mercado Libre's certification/homologation process.

### Gate E — add a new courier?
Proceed only when its current official API contract is obtained and its capabilities/constraints can be represented without breaking the core abstraction.
