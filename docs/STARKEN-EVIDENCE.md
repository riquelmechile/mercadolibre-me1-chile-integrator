# Starken evidence ledger

**Research cut:** 25 August 2026 (Chile)

This ledger records what the public product is allowed to treat as evidence about Starken. It exists to prevent a historical snippet, third-party plugin, leaked credential or stale endpoint from silently becoming a production contract.

## Provenance tiers

- `CURRENT_OFFICIAL` — current page on a Starken-owned domain.
- `CURRENT_OFFICIAL_VENDOR_LISTING` — current marketplace/app listing published by Starken itself on a third-party platform.
- `THIRD_PARTY_CURRENT` — current independent implementation that can corroborate product behavior but cannot define the Starken contract.
- `HISTORICAL_UNVERIFIED` — old/community/document-mirror material useful only for vocabulary or hypotheses. Never a source for production endpoints, credentials, auth headers or status mappings.

## Current official evidence

| Source | Tier | Publicly confirmed facts | Product consequence |
|---|---|---|---|
| `https://www.starken.cl/integraciones` | `CURRENT_OFFICIAL` | E-commerce integration by REST and/or SOAP; OF generation, printing/labeling/dispatch, tracking, quote from weight/dimensions/address, home vs branch delivery choices, POD | Keep provider-neutral quote/create/tracking/POD/label concepts in the core; exact Host-to-Host contract remains gated |
| `https://developers.starken.cl/vendeConNosotros` | `CURRENT_OFFICIAL` | Web Service **EMISION Host 2 Host (REST Service)** for Freight Order creation; printing/reprinting flows including Zebra/PDF | `create_shipment` is a justified normalized capability; label/reprint remain gated until their authorized contract is modeled |
| `https://developers.starken.cl/cotizaTusEnvios` | `CURRENT_OFFICIAL` | Online quote API; origin, destination, parcel weight and dimensions are quote inputs | Current `QuoteInput` / `PackageSpec` model is justified |
| `https://developers.starken.cl/seguimiento` | `CURRENT_OFFICIAL` | Real-time milestone tracking | Current normalized tracking boundary is justified; provider status codes still require an authorized map |
| `https://developers.starken.cl/plugins` | `CURRENT_OFFICIAL` | Real-time pricing, online OF, label generation, tracking, **home delivery / agency delivery**, StarkenPro token request, account-dependent payment behavior, pickup workflow | Generic delivery mode, payment intent and opaque agency/location identifier are justified; plugin token is not assumed equivalent to enterprise Host-to-Host credentials |
| `https://starkenpro.cl/Integraciondeplugin` | `CURRENT_OFFICIAL` | StarkenPro plugin onboarding/token workflow | Plugin onboarding is documented separately from Host-to-Host runtime activation |
| `https://www.starken.cl/cotizador` | `CURRENT_OFFICIAL` | Public quote flow requests origin, destination, dimensions, weight and **declared value** | `declaredValueClp` is a generic quote/shipment field, not a Starken-specific extension |

## Current official vendor listing

| Source | Tier | Publicly confirmed facts | Product consequence |
|---|---|---|---|
| `https://apps.shopify.com/starken-envios-a-todo-chile` | `CURRENT_OFFICIAL_VENDOR_LISTING` | App published by Starken; real-time tariffs, dispatch modes, OF, labels, tracking, agency configuration, commune discounts and **multi-package** support | Multi-package is a confirmed Starken product capability, but it remains runtime-gated until the authorized Host-to-Host package/label/tracking/idempotency semantics are known |

## Third-party current corroboration

Current independent e-commerce plugins may demonstrate that merchants use home/agency choices, service choices and Starken quoting in production. They are useful for compatibility research only.

Rules:

1. never copy a third-party proxy/API key into the core;
2. never infer Starken production endpoints from another vendor's backend;
3. never treat proprietary field names as canonical Starken fields;
4. use them only to identify scenarios our normalized domain should be able to represent.

## Historical / unverified clues

Older public community snippets and mirrored documents have shown concepts such as city/location identifiers, delivery modality, payment type, package type and service type. Some historical material also exposed concrete endpoint/auth values.

Those concrete values are **intentionally omitted from this repository**.

Historical evidence may only be used when it aligns with current official behavior to justify generic concepts. It must never be used to populate:

- `baseUrl`;
- endpoint paths;
- API keys/tokens;
- authentication headers;
- production account identifiers;
- provider status maps;
- service or payment numeric codes.

## Evidence-to-runtime matrix

| Concept | Evidence state | Runtime state v0.5.0 |
|---|---|---|
| weight/dimensions/origin/destination quote | current official | implemented |
| home vs agency delivery | current official | implemented as generic `deliveryPreference` / `deliveryMode` |
| selected agency/location identifier | current official behavior | implemented as opaque `providerLocationId` |
| sender-prepaid vs recipient-pay intent | current official account/payment behavior | implemented generically as `paymentMode` |
| declared merchandise value | current official quote UI | implemented as `declaredValueClp` |
| OF creation | current official Host-to-Host REST capability | normalized `create_shipment` implemented; exact provider mapping gated |
| tracking | current official | normalized tracking implemented; exact status map gated |
| label generation / reprint / Zebra / PDF | current official | confirmed, runtime method still gated |
| pickup | current official | confirmed, runtime method still gated |
| POD | current official | confirmed, runtime method still gated |
| multi-package | current official vendor listing | confirmed, automatic runtime remains fail-closed |
| exact Host-to-Host base URL / endpoint paths | not publicly established to required confidence | **not committed** |
| exact Host-to-Host authentication scheme | not publicly established to required confidence | **not committed** |
| exact production request/response field names and numeric codes | not publicly established to required confidence | **not committed** |

## Activation rule

A tenant may activate live Starken Host-to-Host operations only after an authorized current contract supplies the missing transport details and contract tests prove the mapping against Starken's authorized environment. Until then the adapter remains fail-closed.

The public core must remain deployable without any tenant-specific Starken URL, account number, RUT, plugin token, API key or buyer data.
