# Integrator vs Mercado Envíos Carrier — Chile

**Audit cut:** 2026-08-28

This repository tracks two independent Mercado Libre business/integration paths. They solve different problems, have different admission gates and must never be treated as interchangeable.

```text
A. Certified Integrator / Dynamic Freight
   Mercado Libre seller checkout
              ↓
   certified partner quote endpoint
              ↓
   seller's logistics/carriers

B. Mercado Envíos Carrier
   Mercado Envíos network
              ↓
   carrier authorization / coverage / tracking APIs
              ↓
   physical logistics operation
```

Passing or preparing one path does not grant the other.

## Executive comparison

| Topic | Certified Integrator / Dynamic Freight | Mercado Envíos Carrier |
|---|---|---|
| Primary customer | Mercado Libre sellers | Mercado Libre / Mercado Envíos logistics network |
| Main function | Calculate seller shipping price + promise for ME1 checkout | Accept, transport and report Mercado Envíos shipments |
| Buyer checkout price | Yes — Dynamic Freight returns quotations | Not the primary contract; carrier services are selected by Mercado Envíos network configuration |
| Seller ME1 relationship | Directly relevant | Separate from seller ME1 activation |
| Public admission program | Developer Partner Program (DPP) | No equivalent public DPP admission page found |
| Public Chile GMV threshold | **USD 200,000 monthly active-seller GMV** for DPP application | **No public GMV threshold found** in current Carrier docs |
| Security gate | DPP Security Assessment **>=65%**, plus platform good practices | OAuth/resource security and carrier technical/onboarding requirements; no public 65% DPP threshold found |
| Commercial/onboarding gate | DPP application + assigned Integration Expert initiatives + certification/homologation | Mercado Libre-assigned **Carrier ID**, service/contract onboarding and focal-point authorization |
| Mercado Libre assigned service identifier | Dynamic Freight `service` is 0..99 and controlled by seller/integrator inside quote contract | **SERVICE_ID** is assigned by Mercado Libre for each carrier service |
| External endpoint direction | Mercado Libre calls integrator quote endpoint | Mercado Libre calls carrier OAuth/coverage/agencies/authorization/tracking endpoints |
| Main performance requirement | Dynamic Freight response target **<400 ms** | Authorization docs/test flows expect low-latency operational responses; final SLA is onboarding/service dependent |
| Test/homologation artifact | Dynamic Freight homologation by Mercado Libre | Official `mercadolibre/carrier-integration-tests` Docker suite |
| Product business model | SaaS/integration sold to sellers | Logistics operator/carrier relationship with Mercado Envíos |

## Path A — Certified Integrator / Dynamic Freight

### What the company is

The company is a **software/integration provider used by Mercado Libre sellers**.

The product connects seller accounts, logistics policies and carrier contracts and exposes a homologated Dynamic Freight endpoint so Mercado Libre can obtain a shipping price and delivery promise before purchase.

```text
seller A ─┐
seller B ─┼─> integration platform ─> carrier/routing/tariff engine
seller C ─┘             ↑
                        │
                 Mercado Libre
                 Dynamic Freight
```

### Public DPP entry requirements

The current Developer Partner Program page publishes the following requirements for Chile:

1. comply with Mercado Libre platform good practices;
2. submit the formal DPP application;
3. have active sellers using the solution with **USD 200,000 monthly GMV** in Chile;
4. complete the Security Assessment and score **65% or more**;
5. implement the minimum initiatives assigned by a Mercado Libre Integration Expert during the certification process.

The published GMV metric is based on active users of the application and their Mercado Libre billing/transactions, not the integrator's own seller account alone.

Mercado Libre states that admission/certification remains subject to its review and that required initiatives can change as the platform evolves.

### What Dynamic Freight homologation then requires

The Dynamic Freight page explicitly says homologation is reserved to integrators in the certification process.

The homologation package currently includes at least:

- external endpoint URL;
- communication headers;
- GET request/body contract;
- Mercado Libre application name and ID;
- demonstration video;
- technical/security validation;
- load/latency validation;
- cache behavior;
- error monitoring;
- contingency support.

Current published target latency is **below 400 ms**. Mercado Libre documents its Dynamic Freight infrastructure in US East / Virginia, which matters for endpoint placement and latency testing.

### Dynamic Freight contract responsibilities

For Chile the request destination is represented as:

```json
{
  "type": "city",
  "value": "Region/Commune"
}
```

The integrator must:

- accept one item from one seller per request;
- use Mercado Libre-provided consolidated package dimensions as authoritative when quantity >1;
- calculate one or more quotations;
- return price, handling time, shipping time, promise and service code;
- keep `promise = handling_time + shipping_time`;
- use a `service` identifier in range 0..99;
- support the documented cache/ETag behavior;
- implement documented error behavior and Mercado Libre contingency.

This is the path that directly creates a **sellable SaaS/product for many sellers**.

## Path B — Mercado Envíos Carrier

### What the company is

The company is integrated as a **transport/logistics provider in the Mercado Envíos network**.

Instead of merely calculating the seller's checkout quote, Mercado Envíos sends operational shipment requests to the carrier.

```text
Mercado Envíos
      ↓
coverage / authorization / tracking / agencies / pickup
      ↓
carrier
      ↓
physical logistics network
```

### What the public Carrier documentation proves is provisioned by Mercado Libre

Current public Carrier documentation/test tooling exposes several values that cannot be self-created as production identity:

- **Carrier ID** — required in carrier access/onboarding flows;
- **SERVICE_ID** — numeric value explicitly described as provided by Mercado Libre for each carrier service;
- service name;
- carrier contract;
- optional account/user/password depending on service;
- focal-point access authorization for protected resources;
- application/user identity used for Mercado Libre API access.

The public documentation for restricted carrier resources describes a flow such as:

```text
Application
   ↓
Authentication
   ↓
request access from Mercado Libre focal point
   ↓
Carrier ID + Application ID/user ID
   ↓
resource access
```

That means creating a normal Mercado Libre application is necessary but **not sufficient** to become a production carrier.

### No public DPP-style GMV requirement found

Unlike DPP, the current public Carrier documentation does **not** publish a Chile admission table such as “USD 200,000 monthly GMV” or a DPP Security Assessment >=65% requirement.

This must not be interpreted as “Carrier onboarding is easier.” It means the public gate is different and appears to be commercial/logistics onboarding directly with Mercado Libre.

The missing public information includes, for example:

- minimum parcel volume or geographic coverage to be considered as a new Chile carrier;
- required legal/insurance/financial guarantees;
- commercial tariff negotiation requirements;
- operational capacity requirements;
- whether subcontracted/virtual-carrier models are permitted;
- production SLA/KPI thresholds specific to an MLC contract.

Those requirements must be obtained from Mercado Libre's logistics onboarding/focal point before presenting Carrier readiness as a business entitlement.

### Carrier technical responsibilities

The carrier must expose Mercado Libre-facing infrastructure including, depending on the contracted service:

- OAuth 2.0 token generation;
- OAuth token revocation;
- audience-separated tokens;
- coverage;
- agencies;
- shipment authorization;
- cancellation/delivery-block semantics;
- tracking pull/push;
- pickup/booking when enabled;
- additional network/fiscal/handling-unit APIs where applicable.

Chile is explicitly a **city-coverage** country in the Carrier contract.

The official test suite requires identifiers including:

```text
SITE_ID=MLC
SERVICE_ID=<provided by Mercado Libre>
SERVICE_NAME=<service/company name>
CARRIER_CLIENT_ID=...
CARRIER_CONTRACT=...
CARRIER_ACCOUNT=...
CARRIER_USER=...
CARRIER_PASSWORD=...
SERVICE_LOGISTIC=drop_off | cross_docking | fulfillment
```

The test suite is available publicly, so implementation can be prepared before commercial onboarding. A synthetic SERVICE_ID may be used only to exercise the local test UI; it is not production provisioning.

## What the current repository already proves

The public core currently has a loopback-only Carrier contract harness and has passed selected official MLC Carrier tests for:

```text
OAuth                         8/8
Coverage City                 3/3
Agencies                      3/3
Domestic Authorization        9/9
Last Mile                     7/7
Conciliation 0260             1/1
---------------------------------
Selected verified total      31/31
```

This proves **technical protocol readiness for those selected scenarios only**.

It does not prove:

- Carrier ID assignment;
- SERVICE_ID assignment;
- a Mercado Libre carrier contract;
- permission to transport Mercado Envíos volume;
- production homologation completion;
- seller ME1 activation.

## Business consequence

These are different companies/products even if they can eventually share the same logistics core.

### Integrator business

```text
seller pays/uses our software
        ↓
we connect seller + carriers
        ↓
we provide ME1/Dynamic Freight automation
```

Revenue can be SaaS, per-shipment, per-seller or enterprise integration fees.

The most visible formal barrier is the **DPP Chile active-seller GMV requirement of USD 200k/month**, plus security/certification.

### Carrier business

```text
Mercado Envíos contracts/onboards carrier
        ↓
Mercado Libre injects shipments into carrier network
        ↓
carrier performs logistics + tracking
```

Revenue/commercial terms are part of the carrier relationship. The public technical documentation does not publish the commercial entry threshold.

## Recommended strategy for this project

Do **not** make the two tracks sequential dependencies.

```text
PRODUCT TRACK                          CARRIER TRACK

Custom Shipping SaaS                  carrier protocol readiness
      ↓                                      ↓
external sellers                      official test suite
      ↓                                      ↓
USD 200k active GMV                   request MLC carrier onboarding
      ↓                                      ↓
DPP ≥65% security                     Carrier ID / SERVICE_ID / contract
      ↓                                      ↓
Dynamic Freight homologation          production carrier homologation
      ↓                                      ↓
certified seller product              Mercado Envíos logistics provider
```

The public product should continue building reusable tenant/carrier/tariff/tracking infrastructure because both tracks benefit from it.

The private first-seller pilot remains only a tenant overlay and must not become a prerequisite or special case in the public product.

## Decision rule

Use this question when classifying future work:

> Is Mercado Libre calling us because we represent a **seller's shipping integration**, or because Mercado Envíos considers us the **carrier responsible for the shipment**?

If the former, it belongs to the Integrator/Dynamic Freight boundary.

If the latter, it belongs to the Carrier Integration boundary.

Never use credentials, permissions, certification or test success from one boundary as evidence of authority in the other.

## Primary official evidence

- Mercado Libre Developers — Developer Partner Program, current 2026 admission requirements.
- Mercado Libre Developers — Dynamic Freight / homologation contract.
- Mercado Envíos Developers — Carrier Integration Test Suite.
- Mercado Envíos Developers — Carrier OAuth Token.
- Mercado Envíos Developers — Coverage / Chile city coverage.
- Mercado Envíos Developers — Domestic Authorization.
- Mercado Envíos Developers — access-release examples requiring Carrier ID + Application/User ID + focal point.
