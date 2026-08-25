# Courier/API capability matrix — Chile

**Research cut:** 25 August 2026

This document separates what is publicly documented from what is confirmed but commercially gated.

## Status legend

- `CONFIRMED_PUBLIC_API`: current official public API documentation is available.
- `CONFIRMED_GATED_API`: official source confirms API integration, but exact production contract/credentials are gated by account/KAM/onboarding.
- `RESEARCH_REQUIRED`: not enough current official evidence yet.

## Matrix

| Provider | Type | Status | Quote | Create shipment / transport order | Label | Tracking | Coverage | Pickup | Returns/POD | Auth visibility |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Starken | Direct carrier | `CONFIRMED_GATED_API` | Yes | OF issuance | Yes in plugin flow | Yes | Implied by quote/service | StarkenPro supports pickup | Reverse logistics + POD | API/REST/SOAP confirmed; server auth contract gated |
| Blue Express | Direct carrier | `CONFIRMED_GATED_API` | Yes | Yes in integrated ecommerce flow | Yes | Yes | Yes via service availability | Yes for business plans | Returns via ecosystem/Reversso | Credentials via customer/KAM; detailed API gated |
| Chilexpress | Direct carrier | `CONFIRMED_GATED_API` | Yes | OT generation | Yes | Push + pull | Yes | Available in enterprise flows | Returns supported | Productive API credentials requested explicitly |
| CorreosChile | Direct carrier | `CONFIRMED_PUBLIC_API` | Yes | Admission | Yes | Yes | Regions/communes/branches/services | Yes | Some legacy + current flows | Public developer docs; productive creds require client code |
| Shipit | Multi-courier aggregator | `CONFIRMED_PUBLIC_API` | Yes | Yes | Via shipment flow | Yes | Yes | Through service | Depends on selected carrier | Token + account email publicly documented |

---

## Starken adapter

**Runtime status (v0.4.0):** the generic contract-driven REST transport is implemented for quote, shipment creation and tracking. Production activation remains gated until an authorized Starken Host-to-Host contract is loaded in private tenant configuration. See `STARKEN-CONTRACT.md`.


### Officially confirmed

Starken states that an e-commerce can integrate through **REST API and/or SOAP** and automate:

- generation of Orden de Flete (OF);
- tracking;
- quotation based on dimensions, weight and destination;
- delivery modality selection;
- proof of delivery (POD) PDF;
- reverse logistics;
- Host-to-Host REST emission for creating OFs;
- single/batch reprinting, including Zebra-label and PDF printing flows.

StarkenPro plugin documentation additionally confirms:

- real-time pricing;
- online OF issuance;
- label generation;
- shipment tracking;
- token request through StarkenPro "Solicitud Plugins";
- multi-package shipments in the official Shopify app;
- agency selection/configuration;
- commune-level commercial discounts in the Shopify integration.

These last Shopify/plugin capabilities are provider evidence, not proof that the current public Host-to-Host REST contract exposes the same fields or credentials. Keep them capability-gated until the authorized REST mapping is obtained.

### Do not assume

Do not assume the StarkenPro plugin token is the same credential/scope as the enterprise REST/SOAP API. The production adapter must be configured only after Starken supplies or confirms:

- base URLs;
- authentication method;
- client/account identifiers;
- sandbox/test environment;
- request/response contracts;
- rate limits;
- idempotency behavior;
- webhook/push support;
- cancellation, pickup and reverse-logistics operations.

### Sources

- https://www.starken.cl/integraciones
- https://www.starken.cl/empresas
- https://starkenpro.cl/Integraciondeplugin
- https://developers.starken.cl/plugins
- https://developers.starken.cl/vendeConNosotros
- https://developers.starken.cl/cotizaTusEnvios
- https://developers.starken.cl/seguimiento
- https://apps.shopify.com/starken-envios-a-todo-chile

---

## Blue Express adapter

### Officially confirmed

Blue Express publicly markets direct **API integration** for e-commerce/business accounts and supports integrated checkout/tariff and operational flows.

Official manuals/pages confirm or strongly establish:

- calculated shipping rates in checkout for supported integrations;
- product weight/dimensions as quote inputs;
- automatic label generation in integrated flows;
- tracking/back-office capabilities;
- credentials provisioned for customer accounts through Blue Express/KAM support;
- business pickup and checkout customization in API-oriented plans.

### Important limits

Some published plugin/e-commerce flows list package constraints such as **20 kg** and **70×70×70 cm**. Treat these as service/flow-specific. Do not hardcode them globally for all Blue Express API contracts.

The adapter should expose per-service constraints:

```text
max_weight
max_length
max_width
max_height
volumetric_divisor
allowed_origin_types
allowed_destination_types
pickup_supported
pudo_supported
```

### Sources

- https://www.blue.cl/empresas/soluciones-ecommerce
- https://www.blue.cl/nosotros/centro-de-ayuda/integraciones-ecommerce
- https://static.blue.cl/multimedia/Manual-usuario-VTEX-ago-2023.pdf
- https://static.blue.cl/multimedia/ecommerce/Plataforma-Woo.pdf
- https://www.blue.cl/docs/emprendedores/ecommerce/manual_integracion_Jumpseller.pdf

---

## Chilexpress adapter

### Officially confirmed

Chilexpress states that e-commerce can integrate through APIs/plugins for:

- address normalization;
- branch/physical point support;
- tariff quotation;
- Orden de Transporte (OT) generation;
- digital label materialization;
- tracking push & pull;
- coverage;
- returns/change labels.

Chilexpress exposes a current onboarding form specifically titled around **productive credentials for API or plugins**.

### Adapter requirements

Before implementation, obtain the current official contract for:

- authentication/token lifecycle;
- sandbox and production environments;
- quote endpoint;
- address normalization;
- OT create/cancel;
- label format/reprint;
- push tracking/webhook signature;
- pickup scheduling;
- return label flow;
- rate limits and idempotency.

### Sources

- https://chilexpress.cl/servicio-ecommerce-comercio-electronico-chile
- https://altarapidaclientes.chilexpress.cl/Home/
- https://www.chilexpress.cl/plataformas-digitales-para-empresas

---

## CorreosChile adapter

### Officially confirmed

CorreosChile operates a public developer portal with a modern REST API 2.0 surface and some retained legacy SOAP documentation.

Capabilities described by the portal include:

- regions and communes;
- branches and agencies;
- address normalization;
- customer services;
- tariffs/coverage;
- shipment admission;
- labels and manifests;
- pickup requests;
- tracking.

### Integration model

1. Become a CorreosChile business customer.
2. Obtain a client code.
3. Request productive integration credentials.
4. Prefer REST v2 where equivalent functionality exists.
5. Use SOAP only if a required capability remains legacy-only.

### Sources

- https://developers.correos.cl/
- https://developers.correos.cl/como-integrarme
- https://developers.correos.cl/v2/servicios
- https://developers.correos.cl/formulario-de-integracion

---

## Shipit adapter (optional aggregator)

Shipit is not a direct carrier. It is useful as an optional multi-courier layer and as a reference for normalized logistics contracts.

Public docs cover:

- order/shipment creation;
- courier selection;
- quote APIs;
- tracking;
- coverage;
- webhooks;
- optional fulfillment/inventory.

Authentication is documented using:

- `X-Shipit-Email`;
- `X-Shipit-Access-Token`.

### Sources

- https://developers.shipit.cl/reference/comienza-con-nuestra-api
- https://developers.shipit.cl/reference/consumo-de-endpoints
- https://developers.shipit.cl/reference/crear-un-env%C3%ADo

---

## Future provider candidates

Candidates should only be promoted to a real adapter after current official evidence is collected.

Potential categories:

- local/last-mile courier networks;
- regional 3PLs;
- own-fleet/TMS integrations;
- additional multi-courier aggregators;
- Mercado Libre Flex courier integration.

Mercado Libre Flex should be treated as a **channel capability**, not a carrier adapter, because the integration relationship is with Mercado Libre's courier registration/OAuth flow.

Source: https://developers.mercadolibre.cl/envios-flex

---

## Normalized `CourierAdapter` capabilities

Every provider adapter should implement capability discovery rather than pretend all couriers support the same operations.

Suggested capability names:

```text
quote
coverage
create_shipment
cancel_shipment
label
label_reprint
pickup_create
pickup_cancel
tracking_pull
tracking_push
pod
return_create
address_normalize
branches
pudo
insurance
multi_package
```

A tenant/provider connection stores the supported capability set plus service-specific constraints.

## Contract rule

Do not add a production endpoint to source code unless backed by:

1. current official public documentation; or
2. a current provider-issued private integration specification received through an authorized onboarding process.
