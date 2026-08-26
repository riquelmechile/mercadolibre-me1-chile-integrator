# Starken evidence ledger

**Research cut:** 25 August 2026 (Chile)

This ledger records which facts the public product may treat as current Starken interoperability evidence. Its purpose is to prevent stale snippets, leaked credentials, tenant data or unverified provider semantics from silently becoming production behavior.

## Provenance tiers

- `CURRENT_OFFICIAL_PUBLIC` — current material on a Starken-owned domain or an official artifact downloadable from Starken's own portal without reproducing its source code here.
- `CURRENT_OFFICIAL_LIVE_READONLY` — non-destructive response validated against Starken with an authorized tenant credential; tenant-specific values are not committed.
- `CURRENT_OFFICIAL_VENDOR_LISTING` — marketplace/app listing published by Starken itself.
- `HISTORICAL_UNVERIFIED` — old/community/mirrored material useful only as a hypothesis. Never sufficient for production auth, endpoints or status mappings.

## Official public sources

| Source | Tier | Confirmed facts | Product consequence |
|---|---|---|---|
| `https://www.starken.cl/integraciones` | `CURRENT_OFFICIAL_PUBLIC` | REST/SOAP integrations, quote, OF, labels/dispatch, tracking, home/branch concepts, POD | Normalized quote/create/tracking domain is justified |
| `https://developers.starken.cl/vendeConNosotros` | `CURRENT_OFFICIAL_PUBLIC` | Host-to-Host REST emission and OF printing/reprinting | OF creation is a supported carrier capability |
| `https://developers.starken.cl/cotizaTusEnvios` | `CURRENT_OFFICIAL_PUBLIC` | Quote uses origin, destination, weight and dimensions | `PackageSpec` + routing codes are justified |
| `https://developers.starken.cl/seguimiento` | `CURRENT_OFFICIAL_PUBLIC` | Shipment milestone tracking | Tracking boundary is justified; semantics still require explicit status map |
| `https://starkenpro.cl/Integraciondeplugin` | `CURRENT_OFFICIAL_PUBLIC` | Official plugin workflow, token onboarding, quote, OF, labels, tracking, home/agency and account-dependent payment | Plugin gateway protocol is an official interoperability source |
| official WooCommerce plugin v4.8.7 | `CURRENT_OFFICIAL_PUBLIC` | Gateway/auth/route/request/response facts used by the current plugin | `starken-plugin-gateway-v1` may be implemented independently; plugin source is not vendored or redistributed |

Artifact observed for the current WooCommerce plugin research cut:

```text
SHA-256 cd1299a7797c7a88503943bf0c6c894ba7ef472df8e44a6dd83d492f3659467b
Version 4.8.7
```

The StarkenPro download endpoints labelled Prestashop and Magento returned byte-identical archives during the cut. That portal inconsistency is recorded only as a research warning; the public runtime does not infer Magento behavior from that artifact.

## Live read-only validation

Using an authorized tenant token held only in memory/secret context, the following operations were exercised without emitting an OF:

- region catalog;
- city catalog;
- commune catalog;
- agency catalog;
- delivery-type catalog;
- service-type catalog;
- one synthetic quote using fictional package data.

These calls confirmed:

- Bearer authentication against the current plugin gateway;
- quote success with HTTP `201`;
- `alternativas[]` response shape;
- delivery alternatives carrying service, delivery mode, payment code and price;
- agency catalog records carrying dimensions/weight/value constraints and operational flags.

No token, account identifier, account-specific quote amount, RUT or buyer data from the validation is committed here.

## Current protocol facts allowed in runtime

The current official plugin protocol establishes these interoperability facts with sufficient confidence:

```text
Base: https://gateway.starken.cl/externo/integracion
Auth: Authorization: Bearer <secret>
```

Verified route families:

```text
/agency/region
/agency/city
/agency/comuna
/agency/agency
/quote/cotizador-multiple
/emision/tipo-entrega/
/emision/tipo-servicio/
/emision/emision
/emision/consulta/{issuanceId}
/tracking/orden-flete/of/{freightOrder}
```

Known normalized mappings currently allowed:

- `DOMICILIO` -> `home`;
- `AGENCIA` / `SUCURSAL` -> `agency`;
- payment code `2` -> `sender_prepaid`;
- payment code `3` -> `recipient_pay`;
- delivery DLS `2` -> home;
- delivery DLS `1` -> agency;
- current verified `NORMAL` service DLS -> `0`.

Any other service/payment/delivery code fails closed unless later verified evidence explicitly adds it.

## Evidence-to-runtime matrix — v0.7.0

| Concept | Evidence state | Runtime state |
|---|---|---|
| quote by origin/destination/weight/dimensions | official public + live readonly | implemented |
| current plugin gateway + Bearer auth | official artifact + live readonly | implemented in official protocol mode |
| home/agency selection | official artifact + live readonly | implemented |
| recipient-pay / sender-prepaid normalization | official artifact + live readonly | implemented |
| provider city/commune/agency routing codes | official artifact + live catalogs | generic address fields implemented |
| declared value | official public/artifact | implemented |
| OF emission payload | official artifact | implemented and fixture-tested; no discovery-time live OF emitted |
| asynchronous issuance ID -> OF reconciliation | official artifact | implemented for tracking reconciliation |
| label URL from emission/consultation | official artifact | normalized on create when present |
| tracking history shape | official artifact | implemented; provider statuses require explicit tenant map |
| `allowLiveQuotes` | product policy | opt-in only; false by default; Dynamic Freight remains snapshot-first |
| agency physical constraints | live readonly catalog | implemented through versioned catalog sync + local routing enforcement for positive dimension/value limits |
| complete tracking status map | insufficient verified semantics | **gated** |
| multi-package | official vendor listing | **gated** |
| pickup/POD/returns/cancel | official product capability | **gated** |
| Zebra/batch reprint | official product capability | **gated** |

## Secret and proprietary-material law

1. Never commit a Starken token, password, account credential or tenant identifier to the public repository.
2. Never copy or vendor the official plugin source into this repository.
3. Protocol facts required for interoperability may be represented in independently written adapter code and tests.
4. Discovery artifacts (ZIP/PDF/local probes) are temporary research inputs and must stay outside the Git tree and be deleted after evidence extraction.
5. Tracking semantics must not be inferred from dashboard labels alone; unknown raw states fail closed.
6. Tenant commercial tariffs and account-specific quote results are private pilot evidence, not public fixtures.

## Activation rule

A real tenant connection uses `credentialRef`; the token is resolved only at runtime. Before live OF emission the tenant must additionally have verified routing data, recipient fields, selected delivery/payment mode, service mapping and declared value. Tracking remains disabled until an explicit verified `trackingStatusMap` is installed.

The public product remains usable without any tenant-specific data.
