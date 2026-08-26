# Starken adapter — official plugin gateway + contract-driven fallback

**Status:** official current plugin protocol implemented for quote, OF creation and tracking; exact tracking status semantics remain tenant-gated until explicitly mapped.

The public core contains two Starken execution modes:

1. `starken-plugin-gateway-v1` — an implementation of the current protocol evidenced by Starken's official downloadable plugins and validated with non-destructive live calls against an authorized account.
2. Contract-driven fallback — the generic REST mapping engine retained for a future enterprise/Host-to-Host contract that differs from the current plugin gateway.

No tenant token, account identifier, buyer data, tenant SKU or commercial tariff is committed to this repository.

## Current evidence cut — 25 August 2026

The current official WooCommerce plugin exposed by StarkenPro identifies itself as **v4.8.7**. The artifact inspected during this research cut had SHA-256:

`cd1299a7797c7a88503943bf0c6c894ba7ef472df8e44a6dd83d492f3659467b`

The official download is linked by StarkenPro itself. The plugin artifact is **not vendored, copied or redistributed** by this project; only protocol facts necessary for interoperability are implemented independently.

The current gateway used by that official integration is:

```text
https://gateway.starken.cl/externo/integracion
```

Authentication is Bearer token based. The token is resolved from `credentialRef` through `SecretProvider`; the value never belongs in source control or SQLite configuration.

The current verified operation set is:

```text
GET  /agency/region
GET  /agency/city
GET  /agency/comuna
GET  /agency/comuna/{id}
GET  /agency/agency

GET  /emision/tipo-entrega/
GET  /emision/tipo-servicio/

POST /quote/cotizador-multiple
POST /emision/emision
GET  /emision/consulta/{issuanceId}
GET  /tracking/orden-flete/of/{freightOrder}
```

A live, non-destructive validation with an authorized StarkenPro token confirmed successful catalog reads and quotation. No live OF was emitted as part of protocol discovery.

## Activation

Use the official protocol explicitly:

```json
{
  "provider": "starken",
  "credentialRef": "starken/example-tenant",
  "config": {
    "protocol": "starken-plugin-gateway-v1",
    "capabilities": ["quote", "create_shipment", "tracking"],
    "originAgencyCode": "REPLACE_WITH_TENANT_DLS_CODE",
    "trackingStatusMap": {}
  }
}
```

`trackingStatusMap` deliberately starts empty. Provider tracking states are never guessed. A tenant must install an explicitly verified map before tracking is activated.

The optional `serviceCodeMap` can add DLS mappings discovered through an authorized current contract. The only built-in service mapping currently treated as verified is `NORMAL -> 0`; unknown service codes fail closed.

## Generic routing data

The Starken protocol requires more than a commune label, so the generic address model can carry provider routing codes without making them canonical business data:

- `providerCityCode` — provider city/routing code used for quote origin/destination;
- `providerCommuneCode` — provider commune code used for OF recipient routing;
- `providerAgencyCode` — provider agency code used when the selected delivery mode is `agency`;
- `street`, `number`, `unit` — normalized address fields used by shipment execution.

These fields are generic logistics fields. Other couriers may populate them with their own codes.

## Quote

The verified quote request uses:

```json
{
  "origen": 1,
  "destino": 91,
  "bulto": "BULTO",
  "alto": 10,
  "ancho": 10,
  "largo": 10,
  "kilos": 1,
  "todas_alternativas": true
}
```

The numeric values above are fictional examples. No tenant tariff or destination from the pilot is embedded in the public product.

The verified response contains `alternativas[]` with at least:

- `servicio`;
- `entrega`;
- `codigo_tipo_pago`;
- `precio`;
- `precio_sin_descuento`;
- `descuento_tipo_cliente`.

The adapter maps provider concepts into the normalized domain:

- `DOMICILIO` -> `home`;
- `AGENCIA` / `SUCURSAL` -> `agency`;
- payment code `2` -> `sender_prepaid`;
- payment code `3` -> `recipient_pay`.

Starken's current quote payload does not provide a reliable business-day ETA in the inspected protocol, so a live `QuoteResult` may return `estimatedBusinessDays: null`. Snapshot tariffs still require an explicit numeric ETA.

When the caller requests `home`, `agency`, or a payment mode, incompatible Starken alternatives are filtered before price selection. `any` can select the cheapest eligible alternative and the concrete selected delivery/payment values travel into shipment creation.

## Snapshot-first law

ME1 Dynamic Freight must not synchronously depend on Starken availability. The architecture remains:

```text
carrier tariff/coverage sync -> versioned tariff snapshot -> deterministic marketplace quote
```

`allowLiveQuotes` on automatic shipping is **false by default**. It exists only as an explicit post-sale/pilot fallback. Enabling it does not change the snapshot-first requirement for Dynamic Freight certification.

## OF creation

The normalized shipment domain now has an optional generic `recipient` object and explicit address/provider routing fields. The official Starken mode validates all required fields **before resolving the token or issuing network I/O**.

The current verified OF schema includes:

- origin/destination agency codes where applicable;
- recipient RUT/name/phone/email/contact;
- street, number, unit and commune routing code;
- declared value;
- delivery/payment/service DLS codes;
- `encargos[]` with parcel weight/dimensions and description;
- optional checking account and cost center for sender-prepaid tenants.

For home delivery the destination agency field is omitted. For agency delivery a destination agency code is mandatory.

The response may expose an asynchronous issuance identifier before the final Freight Order exists. The adapter therefore stores the Starken issuance ID as the provider shipment reference, preserves an OF when already returned, and can reconcile the issuance before tracking.

A returned label URL promotes the canonical result to `label_ready`; otherwise the shipment remains `created` until later reconciliation.

## Tracking

The current tracking endpoint is keyed by Freight Order and exposes a current status plus `history[]` entries containing provider status, note and timestamps.

Every provider status must be present in private/tenant `trackingStatusMap` before it can become a canonical status. Unknown statuses fail closed. Event IDs are deterministically derived from provider data so repeated polling deduplicates correctly.

## Catalog facts

Read-only validation showed that agency catalog records expose operational constraints such as:

- maximum length/width/height;
- value limit;
- weight restriction;
- pickup/delivery flags;
- geolocation and schedules.

The v0.7.0 carrier-location catalog layer normalizes positive agency length/width/height/value limits and enforces them during local agency routing. Provider zero values are treated as unspecified rather than zero capacity; the opaque `weight_restriction` value is preserved without inventing numeric semantics.

## Capabilities still gated

The following are confirmed Starken product capabilities but are not yet advertised as implemented runtime capabilities:

- multi-package emission;
- pickup scheduling;
- POD retrieval;
- cancellation/returns;
- label reprint and Zebra-specific output;
- scheduled catalog refresh, drift monitoring and operational alerting;
- a complete verified tracking-status map.

The adapter must not claim these capabilities until their runtime semantics and tests exist.

## Contract-driven fallback

If Starken supplies a distinct enterprise Host-to-Host contract, the original contract-driven engine remains available. It supports HTTPS/host allowlists, secret references, safe JSON templates, response mappings, timeouts and explicit status maps. A tenant can use that mode without changing the normalized product domain.

See `STARKEN-EVIDENCE.md` for provenance and confidence rules.
