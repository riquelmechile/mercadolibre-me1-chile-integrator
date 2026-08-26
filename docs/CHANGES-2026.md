# 26 August 2026 — v0.7.3 Starken origin allowlist hard gate

Starken shipment creation now requires `allowedOriginAgencyCodes` to be present and non-empty. Missing, malformed, empty, or non-matching origin policy fails before secret resolution and before network I/O. This closes the fail-open path found during a private pilot high-risk review.

---

# Critical changes and deadlines — 2026

**Research cut:** 25 August 2026

This file tracks changes that affect architecture or delivery timing.

## 30 August 2026 — Mercado Libre / Mercado Pago application separation

Mercado Libre's application documentation states that from **30/08/2026** applications must be separated by business unit: one application for Mercado Libre and a different application for Mercado Pago.

Applications that do not adapt are warned that they can lose access to Mercado Libre APIs.

### Required project action

- create/use a dedicated Mercado Libre application identity;
- do not design auth around a shared Mercado Pago app;
- store app identity/configuration separately from tenant seller OAuth tokens;
- verify callbacks and redirect URIs after the separation.

Source: https://developers.mercadolibre.cl/crea-una-aplicacion-en-mercado-libre-es

---

## 14 September 2026 — ME1 V2 buyer experience fully productive

Mercado Libre's ME1 tracking page states that the buyer experience for the new V2 statuses is expected to be fully productive on **14/09/2026**.

The API is already usable before that date; some status presentation may not be fully reflected in the buyer UI until rollout completes.

### Required project action

- implement only V2 for new development;
- test canonical status/substatus mapping against current docs;
- distinguish API acceptance from buyer-UI presentation during the rollout period.

Source: https://developers.mercadolibre.cl/estados-de-ordenes-me1

---

## 31 October 2026 — ME1 `seller_notifications` V1 discontinued

Mercado Libre documents the following migration:

Old:

`POST /shipments/{shipment_id}/seller_notifications`

Current:

`POST /v2/shipments/{shipment_id}/seller_notifications`

V1 is scheduled to be discontinued on **31/10/2026**.

### V2 contract changes highlighted by Mercado Libre

- URL includes `/v2/`;
- `substatus` must be present;
- when no substatus applies, send JSON `null`, not string `"null"`;
- `tracking_number` and `tracking_url` must be sent together;
- `shipped` and `delivered` updates are mandatory;
- final status handling must be conservative because final states are irreversible.

### Required project action

- no new V1 implementation;
- adapter tests must reject string `"null"` for substatus;
- idempotency must prevent repeated irreversible state changes;
- alert on tracking publication lag/failures.

Source: https://developers.mercadolibre.cl/estados-de-ordenes-me1

---

## 1 December 2026 — Chile Law 21.719 enters into force

Law 21.719 modernizes Chile's personal-data framework and creates the Agencia de Protección de Datos Personales.

A logistics SaaS processes data such as:

- buyer name;
- home/business address;
- phone/email where provided;
- order/shipment linkage;
- delivery events;
- possible POD information.

### Required project action before this date

- data inventory and processing purposes;
- tenant/controller/processor responsibility analysis;
- retention/deletion policy;
- subject access/deletion/export workflow as legally required;
- encryption and least-privilege access;
- audit of privileged reads;
- incident response;
- processor/subprocessor inventory;
- contract/privacy terms for external sellers;
- avoid unnecessary PII in logs and analytics.

Source: https://www.bcn.cl/leychile/Navegar?idNorma=1209272&idVersion=2026-12-01

---

## Ongoing 2026 — DPP and Dynamic Freight certification

Mercado Libre may change partner requirements, assigned initiatives and homologation practices over time.

Current baseline:

- Chile DPP monthly active-seller GMV threshold: **USD 200,000**;
- Security Assessment: **>=65%**;
- Dynamic Freight homologation reserved to certified integrators;
- homologation considers cache, monitoring, infrastructure/data-flow and contingency.

### Required project action

Before any DPP submission or homologation attempt, re-check official docs and record the verification date in this repository.

Sources:
- https://developers.mercadolibre.cl/es_ar/atributos-y-variaciones/developer-partner-program
- https://developers.mercadolibre.cl/en_us/dynamic-freight

---

## Ongoing — carrier API contracts

Carrier public websites can confirm capabilities while keeping endpoint/auth details behind commercial onboarding.

Never treat an old plugin implementation as a permanent carrier API contract.

For each provider, store a contract metadata record:

```text
provider
contract_version
received_at
source
sandbox_available
production_base_url_ref
auth_scheme
rate_limit
idempotency_support
webhook_support
support_contact_role
review_due_at
```

The actual secrets/base URLs supplied under private commercial contracts should live in private configuration/secret storage, not in this public repository if redistribution is not authorized.
