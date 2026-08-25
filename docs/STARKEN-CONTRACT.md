# Starken contract-driven adapter

**Status:** transport and normalization implemented; production Host-to-Host contract not bundled.

The public core contains a generic REST adapter for Starken. It does **not** publish, infer or hardcode private Starken endpoints, credentials, account identifiers or commercial payload schemas.

## Verified public scope — August 2026

Official Starken sources confirm that e-commerce/system integrations can use REST and/or SOAP and cover, depending on the customer flow:

- shipment quotation from origin, destination, weight and dimensions;
- Freight Order (OF) issuance;
- label generation/printing;
- shipment tracking;
- proof of delivery (POD);
- pickup/reverse-logistics workflows;
- Host-to-Host REST emission for OF creation;
- single and batch OF reprinting with Zebra/PDF output;
- multi-package handling, agency configuration and commune-level discounts in the official Shopify integration.

Official references:

- https://www.starken.cl/integraciones
- https://www.starken.cl/empresas
- https://developers.starken.cl/vendeConNosotros
- https://developers.starken.cl/cotizaTusEnvios
- https://developers.starken.cl/seguimiento
- https://developers.starken.cl/plugins
- https://apps.shopify.com/starken-envios-a-todo-chile

The public developer pages do **not** expose a complete production Host-to-Host REST contract with the exact account authentication scheme, endpoint set and request/response payloads. Those details therefore remain private configuration supplied only after authorized onboarding with Starken.

## Boundary

The v0.5.0 adapter currently implements these normalized capabilities:

- `quote`
- `create_shipment`
- `tracking`

Other Starken capabilities documented publicly (labels/reprint, pickup, POD, reverse logistics, multi-package shipments, agency selection and commercial discount rules) remain roadmap capabilities until the corresponding authorized contract is represented in the public normalized interface.

The public Host-to-Host page confirms OF creation and printing/reprinting workflows, but it does not publish the exact REST paths, auth scheme or payload schemas. The Shopify app additionally confirms multi-package operation, configurable agencies and commune-level discounts; those features must not be inferred as identical Host-to-Host fields without the authorized contract.

A connection can only advertise capabilities that the adapter actually implements. Configuration cannot make the adapter claim an unsupported runtime capability.

## Activation contract

A Starken carrier connection needs:

```json
{
  "provider": "starken",
  "credentialRef": "starken/example-tenant",
  "config": {
    "capabilities": ["quote", "create_shipment", "tracking"],
    "contract": {
      "version": "authorized-contract-version",
      "baseUrl": "https://api-authorized.example.invalid",
      "allowedHosts": ["api-authorized.example.invalid"],
      "auth": { "mode": "bearer" },
      "timeoutMs": 10000,
      "statusMap": {},
      "operations": {}
    }
  }
}
```

The example intentionally uses `.invalid`. Replace the contract only inside authorized tenant/deployment configuration.

`credentialRef` is resolved at runtime by `SecretProvider`. The secret value never belongs in the carrier connection, SQLite row, public repository or tenant fixture.

## Authentication modes

The transport supports three generic modes so the core does not need to change when the authorized Starken contract specifies its actual mechanism:

- `bearer` → `Authorization: Bearer <resolved-secret>`
- `basic` → the resolved secret is encoded as HTTP Basic credentials
- `header` → the resolved secret is sent in one explicitly configured header, optionally with a non-secret prefix

Static operation headers cannot contain authentication credentials. Raw `Authorization`, API-key or cookie values in operation configuration are rejected.

## Network safety

Before resolving a secret or issuing network I/O the adapter validates:

1. the requested capability is implemented and enabled;
2. the contract and operation mapping are complete;
3. `baseUrl` is valid;
4. production URLs use HTTPS;
5. the base host appears in `allowedHosts`;
6. operation paths cannot escape the configured origin;
7. timeouts are between 100 ms and 30 seconds.

Plain HTTP is accepted only for loopback test hosts (`127.0.0.1`, `localhost`, `::1`, `*.localhost`). Redirects are rejected.

## Request templates

Operation bodies are JSON templates over the normalized logistics context. A placeholder must occupy the entire JSON string value:

```json
{
  "weight": "{{package.weightKg}}",
  "origin": "{{origin.commune}}",
  "destination": "{{destination.commune}}"
}
```

No JavaScript, expressions or `eval` are supported. Missing values fail before the request is sent.

Supported normalized context includes the fields already present in `QuoteInput`, `ShipmentCreateInput` and `Shipment` such as origin/destination, package dimensions, external order ID, service code, provider shipment reference and tracking number.

If the authorized emission contract later requires normalized recipient/sender fields that the public domain does not yet model, add those as generic domain fields first; do not hide tenant-specific semantics inside a provider template.

## Response mappings

The adapter extracts fields using safe dotted paths. Examples:

```json
{
  "itemsPath": "data.services",
  "serviceCodePath": "code",
  "serviceNamePath": "name",
  "amountPath": "price",
  "estimatedBusinessDaysPath": "days"
}
```

Mappings cannot use prototype paths or execute code.

For tracking, every provider status must have an explicit entry in `statusMap`. Unknown states fail closed. The adapter never guesses `delivered`, `cancelled` or another canonical state.

## Failure semantics

The adapter never returns raw response bodies, secret values or auth headers in errors. Failures expose only sanitized categories such as:

- missing/invalid contract;
- unsupported capability;
- unsafe transport/host;
- network or timeout;
- HTTP status code;
- malformed JSON/mapping;
- unknown tracking status.

## Production activation checklist

Before enabling a real Starken connection:

1. obtain the current authorized Host-to-Host specification from Starken;
2. confirm whether the account uses enterprise REST/SOAP or a plugin/token flow — do not assume they share credentials/scopes;
3. record contract version and source internally;
4. populate endpoint/auth/mapping configuration in the private tenant/deployment repository;
5. store the credential only in the runtime secret store;
6. map every tracking status explicitly;
7. run contract tests against the authorized test environment;
8. validate quotation parity using measured packed dimensions;
9. run shipment creation in non-production/test mode if Starken provides one;
10. approve the tenant contract through review before enabling live emission.

The public core should not be modified simply to insert an account-specific URL or payload field.


## Generic delivery fields available to mappings — v0.5.0

The normalized quote context can expose:

- `deliveryPreference` — `home`, `agency`, or `any`;
- `paymentMode` — `sender_prepaid` or `recipient_pay`;
- `declaredValueClp`;
- `destination.providerLocationId` — opaque selected location/agency identifier.

The shipment-create context exposes concrete `deliveryMode` instead of `any`, plus `paymentMode`, `declaredValueClp`, and the same opaque destination location identifier. These are generic logistics fields, not Starken constants.

A quote response mapping may optionally provide `deliveryModePath`. Only `home` and `agency` are accepted; unknown values fail closed.

Current public Starken evidence confirms home/agency delivery concepts, declared value in the public quote flow, account-dependent payment behavior and agency configuration. It does **not** publish the exact Host-to-Host field names/codes, so an authorized contract mapping is still required before production.

See `STARKEN-EVIDENCE.md` for provenance and evidence tiers.
