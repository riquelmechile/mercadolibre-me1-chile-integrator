# Research baseline — Mercado Libre Chile logistics integrator

**Research cut:** 25 August 2026  
**Country:** Chile  
**Purpose:** establish the current technical/commercial facts needed to build a multi-tenant logistics integrator for Mercado Libre Chile and direct carrier APIs.

## Executive conclusion

A direct logistics integration business is technically viable, but the route to a certified Mercado Envíos 1 (ME1) Dynamic Freight integrator is staged.

The practical sequence is:

1. automate existing Mercado Libre **Custom** shipping with direct carrier APIs;
2. onboard real sellers and operate as a multi-tenant SaaS;
3. accumulate seller usage and GMV;
4. qualify for the Mercado Libre **Developer Partner Program (DPP)**;
5. complete Dynamic Freight homologation;
6. offer certified ME1 as a commercial service.

The main barrier is not writing a quote endpoint. Mercado Libre explicitly reserves Dynamic Freight homologation to certified integrators, and Chilean DPP admission currently requires active sellers using the solution with at least USD 200,000 monthly GMV in aggregate plus a Security Assessment score of at least 65%.

---

## 1. Mercado Libre Chile

### 1.1 Mercado Envíos 1 (ME1)

Official documentation confirms ME1 is available in Chile and is designed for sellers that need to ship heavy/bulky products using their own logistics or third-party services.

Current official notes include:

- seller must have ME1 enabled before publishing/editing an item in ME1;
- ME2 must already be active for the seller;
- an item can be migrated to `shipping.mode = me1` from Custom / "Acordar con el vendedor" when eligibility conditions are met;
- Mercado Libre remains the authority for seller/item/category eligibility.

Important implementation note: current documentation around dimension thresholds contains wording that should not be hardcoded as business truth without runtime eligibility checks. The adapter should query/validate Mercado Libre eligibility and treat documentation constants as advisory, not as the sole source of truth.

Source: https://developers.mercadolibre.cl/mercadoenvios-modo-1

### 1.2 Dynamic Freight / Flete Dinámico

Dynamic Freight lets Mercado Libre query an external integrator for delivery price and timing before checkout.

Official homologation requirements explicitly mention:

- contract compliance;
- optimal response time;
- infrastructure location;
- clear data origin/destination;
- cache usage;
- error monitoring;
- Mercado Libre contingency handling.

Most importantly, the documentation states that approval/homologation is **reserved to certified integrators**. A developer that is not certified is directed to the Developer Partner Program.

Architecture consequence: the quote path must be deterministic and low-latency. It should not block on an external carrier API call for every quote. Carrier tariffs, coverage and service metadata should be synchronized into a local/versioned snapshot or cache.

Source: https://developers.mercadolibre.cl/en_us/dynamic-freight

### 1.3 Developer Partner Program (DPP)

Current Chile requirements:

- follow Mercado Libre platform good practices;
- submit a formal application;
- have Mercado Libre sellers actively using the solution;
- active sellers must aggregate at least **USD 200,000 monthly GMV** in Chile;
- complete Security Assessment with **65% or higher**.

Mercado Libre defines active users for this metric based on recent tool usage (last three months in the published definition).

This creates a bootstrap constraint: a new integrator should acquire users through Custom/direct logistics automation before expecting Dynamic Freight certification.

Source: https://developers.mercadolibre.cl/es_ar/atributos-y-variaciones/developer-partner-program

### 1.4 ME1 tracking: V2 migration

Mercado Libre updated the ME1 tracking documentation on **19 August 2026**.

Current endpoint:

`POST https://api.mercadolibre.com/v2/shipments/{SHIPMENT_ID}/seller_notifications`

Key facts:

- V2 is already in production;
- buyer experience for the new statuses is expected fully productive on **14 September 2026**;
- V1 is scheduled to be discontinued on **31 October 2026**;
- `shipped` and `delivered` updates are mandatory and may be subject to penalties if not maintained;
- `delivered` and `not_delivered` are final/irreversible states;
- `tracking_number` and `tracking_url` must be sent together if used;
- `substatus` must be present and must be JSON `null`, not string `"null"`, when absent.

Chile ME1 service id documented by Mercado Libre: `282578`.

Source: https://developers.mercadolibre.cl/estados-de-ordenes-me1

### 1.5 Application separation — 30 August 2026

Mercado Libre's application documentation was updated on 6 August 2026 and states:

> From **30 August 2026**, applications must be separated between Mercado Libre and Mercado Pago, one application per business unit. Applications that do not adapt lose access to Mercado Libre APIs.

Design consequence: this project must have a Mercado Libre-specific OAuth application and must not assume a shared Mercado Pago app identity.

Source: https://developers.mercadolibre.cl/crea-una-aplicacion-en-mercado-libre-es

### 1.6 Flex courier integration as a separate product path

Mercado Libre also exposes a dedicated Flex integration for courier companies. A courier links its business account through OAuth and the integrator registers managed shipments through the Flex courier API.

This is not the same product as ME1 Dynamic Freight and should be kept as a future adapter/module rather than mixed into the ME1 core.

Source: https://developers.mercadolibre.cl/envios-flex

---

## 2. Carrier evidence

### 2.1 Starken

Official Starken material confirms e-commerce integration through **REST API and/or SOAP**.

Publicly confirmed capabilities:

- shipment/OF issuance from an e-commerce event;
- tracking;
- quote calculation using weight, dimensions and destination;
- shipping modality selection;
- proof of delivery (POD) PDF;
- reverse logistics services.

StarkenPro additionally documents plugin token flows with:

- real-time tariff calculation;
- online OF issuance;
- label generation;
- shipment tracking.

Critical uncertainty:

The public documentation does **not** prove that a StarkenPro plugin token is automatically the same credential/scope used for arbitrary server-to-server REST/SOAP integration. Production implementation must obtain the current API contract/credentials from Starken and must not infer them from plugin code.

Sources:
- https://www.starken.cl/integraciones
- https://www.starken.cl/empresas
- https://starkenpro.cl/Integraciondeplugin

Status: `CONFIRMED_GATED_API`.

### 2.2 Blue Express

Blue Express confirms direct e-commerce integration by API in its business offering.

Public material confirms:

- plugins for common e-commerce platforms;
- API integration for business/e-commerce flows;
- checkout/tariff integration;
- automatic label generation in integrated flows;
- tracking/back-office capabilities;
- pickup and tailored checkout options for qualifying business accounts;
- credentials are managed for customer accounts and may require KAM/account support.

Important limitation:

Public plugin manuals contain package limits such as 20 kg and 70×70×70 cm for certain e-commerce flows. These limits must **not** be generalized to every enterprise/API contract. The adapter must store service-level limits returned or contractually provided by Blue Express.

Sources:
- https://www.blue.cl/empresas/soluciones-ecommerce
- https://www.blue.cl/nosotros/centro-de-ayuda/integraciones-ecommerce
- https://static.blue.cl/multimedia/Manual-usuario-VTEX-ago-2023.pdf

Status: `CONFIRMED_GATED_API`.

### 2.3 Chilexpress

Chilexpress officially offers direct API/plugin integration.

Publicly confirmed capabilities:

- address normalizer;
- coverage/branch data;
- rate quotation;
- generation of Orden de Transporte (OT) / digital label;
- tracking using push and pull models;
- returns/reverse flows;
- productive credentials can be requested specifically for API or plugins.

The public onboarding form explicitly includes "Solicitar credenciales Productivas para API o Plugins".

Sources:
- https://chilexpress.cl/servicio-ecommerce-comercio-electronico-chile
- https://altarapidaclientes.chilexpress.cl/Home/
- https://www.chilexpress.cl/plataformas-digitales-para-empresas

Status: `CONFIRMED_GATED_API`.

### 2.4 CorreosChile

CorreosChile has a current public developer portal and explicitly supports custom API integrations.

Public capabilities include:

- regions/communes;
- branches/agencies;
- address normalization;
- service/tariff consultation;
- shipment admission;
- label generation;
- pickup requests;
- tracking;
- customer-specific available services.

The portal documents an API 2.0 REST surface while legacy SOAP documentation remains available for some operations.

Production credentials require a CorreosChile client code/account and an integration request.

Sources:
- https://developers.correos.cl/
- https://developers.correos.cl/como-integrarme
- https://developers.correos.cl/v2/servicios

Status: `CONFIRMED_PUBLIC_API` for documentation, with production credentials gated by customer onboarding.

### 2.5 Shipit (aggregator, not direct carrier)

Shipit exposes a public developer API and can be useful as:

- optional fallback/multi-courier adapter;
- benchmarking source for normalized logistics contracts;
- early-market integration where a direct carrier contract is not yet available.

Capabilities:

- shipment/order creation;
- multi-courier selection;
- quotes;
- tracking;
- coverage;
- webhooks;
- optional inventory/fulfillment functions.

Published authentication uses account email and access token headers.

Sources:
- https://developers.shipit.cl/reference/comienza-con-nuestra-api
- https://developers.shipit.cl/reference/consumo-de-endpoints

Status: `CONFIRMED_PUBLIC_API`.

---

## 3. Commercial landscape

### Multivende

Public Chile pricing observed during this research:

- Starter: **10 UF/month**;
- setup: **8 UF per connection**;
- higher published tiers: 20 UF, 35 UF and 100 UF/month.

This is not an ME1-only price: Multivende is a broader omnichannel platform. It is therefore a market ceiling/reference rather than a direct apples-to-apples competitor.

Source: https://multivende.com/planes/

### Zipnova

Zipnova publicly promotes Mercado Libre Dynamic Freight / ME1 integration and certification credentials in Chile. Pricing is commercial/quote-based rather than openly listed in the material reviewed.

Source: https://www.zipnova.com/cl/productos/envios/integraciones/mercado-libre

### Envíame

Envíame provides technology to connect merchant-owned carrier accounts, shipment creation, labels, tracking, rules and operational back office. This validates the business model where the seller keeps the carrier contract while paying for the orchestration layer.

Source: https://enviame.io/nuestra-tecnologia/

### Product positioning opportunity

A focused ME1/Custom logistics product can be materially narrower than an omnichannel suite. The commercial hypothesis is to price below broad platforms while charging for:

- seller connection / tenant;
- carrier connections;
- shipment volume tiers;
- advanced SLA/observability;
- optional per-shipment fee in future carrier-negotiated plans.

Pricing remains a product hypothesis, not a committed tariff.

---

## 4. Security and Chilean privacy law

A multi-tenant logistics SaaS processes personally identifiable information (PII): buyer name, address, phone, shipment history and possibly delivery evidence.

The architecture should therefore treat the following as baseline requirements before DPP submission:

- tenant isolation;
- encryption at rest/in transit;
- secret vaulting and rotation;
- least privilege;
- masking/redaction in logs;
- purpose limitation and minimal retention;
- deletion workflows;
- auditable access;
- webhook authenticity checks;
- idempotency and replay protection;
- dependency/security scanning;
- incident response and postmortem capability.

Chile's Law **21.719** enters into force on **1 December 2026** and modernizes the legal framework for personal data while creating the Agencia de Protección de Datos Personales.

Source: https://www.bcn.cl/leychile/Navegar?idNorma=1209272&idVersion=2026-12-01

---

## 5. Open questions before runtime implementation

### Mercado Libre

- exact commercial path from DPP admission to Dynamic Freight homologation in Chile;
- current sandbox/test seller arrangements for ME1 certification;
- exact SLO/latency target used in the current Chile homologation test pack;
- contingency-table update mechanism and operational test expectations;
- webhook topics and minimum scopes for the first Custom SaaS release.

### Starken

- current production and sandbox base URLs;
- auth mechanism and whether StarkenPro plugin token can be reused server-to-server;
- client/account identifiers;
- current quote, OF, label, tracking, cancellation, pickup, POD and reverse-logistics contracts;
- rate limits, idempotency and webhook support.

### Blue Express

- current API specification/OpenAPI or equivalent;
- auth/token lifecycle;
- quote, label, shipment create/cancel, pickup, tracking and return endpoints;
- contract-specific dimensional/weight constraints;
- sandbox and rate limits.

### Chilexpress

- current developer portal endpoint reference and credential model;
- sandbox/productive environment details;
- push tracking/webhook signing;
- idempotency and cancellation/return contracts.

### CorreosChile

- select REST v2 over SOAP wherever functionally equivalent;
- verify current auth/control-access documentation;
- identify which operations remain SOAP-only, if any, in 2026.

---

## 6. Evidence rule

No implementation should be merged for a provider endpoint unless one of these is true:

1. current official public documentation supports it; or
2. the provider has supplied a current private contract/specification through an authorized business onboarding channel.

Do not derive production credentials/endpoints from leaked code, reverse-engineered plugins or stale unofficial repositories.
