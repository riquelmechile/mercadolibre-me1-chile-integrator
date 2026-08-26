# Controlled shipment ceremony

Core v0.8.0 adds a provider-neutral path for previewing one shipment and then performing one explicitly approved provider creation while the normal carrier connection remains disabled.

This exists for first-production ceremonies and similarly sensitive migrations. It is not an alternative automation API.

## Safety model

Normal routes keep their existing semantics:

- `/v1/quotes` requires an enabled carrier.
- `/v1/shipments` requires an enabled carrier.
- `/v1/automatic-shipments` only selects enabled carriers.

Controlled behavior is split into two independent runtime gates:

1. **preview gate** — read-only live quote on a disabled carrier;
2. **approval gate** — exact-payload one-shot shipment creation on a disabled carrier.

The controlled runtime is **loopback-only**. Configuring either gate causes startup to fail if `APP_HOST` is not `127.0.0.1`, `localhost`, or `::1`. Preview and approval envelopes are mutually exclusive: the core refuses to start if both are configured in the same process.

The target carrier must exist and remain `enabled: false`. If it becomes enabled, controlled operations reject the request rather than becoming a second normal path. While either controlled gate is active, every other non-GET `/v1/` mutation is locked with HTTP 423; only the single controlled mutation allowed by that runtime is accepted.

## Phase A — read-only preview

A preview runtime registers only the read-only POST operations `POST /v1/controlled-quotes` and `POST /v1/controlled-shipment-digest`.

Its environment envelope is:

```text
CONTROLLED_SHIPMENT_PREVIEW_ID
CONTROLLED_SHIPMENT_PREVIEW_TENANT_ID
CONTROLLED_SHIPMENT_PREVIEW_PROVIDER
CONTROLLED_SHIPMENT_PREVIEW_SECRET_SHA256
CONTROLLED_SHIPMENT_PREVIEW_ISSUED_AT
CONTROLLED_SHIPMENT_PREVIEW_EXPIRES_AT
```

All preview fields are required together. Partial configuration fails at startup. The preview window may not exceed 60 minutes.

The ephemeral preview secret itself is sent only as:

```text
x-controlled-shipment-preview: <ephemeral-preview-secret>
```

The header is redacted from Fastify request logs.

The quote request must set `allowLive: true`. The preview gate checks secret, time window, tenant and provider scope before the adapter is invoked. It bypasses only the normal `enabled` availability gate; adapter capabilities and provider validation remain unchanged.

A preview-only runtime does **not** register `/v1/controlled-shipments`. After the live quote fixes the intended service/delivery/payment values, send the exact intended create body to `POST /v1/controlled-shipment-digest` with the same preview secret. The endpoint parses the body through the same normalization used by the create API and returns only `{ payloadSha256 }`; it performs no provider I/O.

Include that digest, together with the quote amount and selected shipment values, in the human approval evidence. Then stop the preview runtime.

## Phase B — exact create approval

Only after the operator approves the exact shipment summary should a new approval runtime be started.

Its environment envelope is:

```text
CONTROLLED_SHIPMENT_APPROVAL_ID
CONTROLLED_SHIPMENT_TENANT_ID
CONTROLLED_SHIPMENT_PROVIDER
CONTROLLED_SHIPMENT_PAYLOAD_SHA256
CONTROLLED_SHIPMENT_SECRET_SHA256
CONTROLLED_SHIPMENT_ISSUED_AT
CONTROLLED_SHIPMENT_EXPIRES_AT
```

All approval fields are required together. Partial configuration fails at startup. The approval window may not exceed 60 minutes.

`CONTROLLED_SHIPMENT_PAYLOAD_SHA256` is the SHA-256 of the **normalized `ShipmentCreateInput`** after recursive key sorting. This binds approval to the exact tenant, provider, external order, origin, destination, package, service, delivery/payment mode, declared value, recipient fields, marketplace shipment identifier and idempotency key accepted by the API.

`CONTROLLED_SHIPMENT_SECRET_SHA256` contains only the SHA-256 of an ephemeral approval secret. The raw secret is sent only as:

```text
x-controlled-shipment-approval: <ephemeral-approval-secret>
```

That header is redacted from Fastify request logs. The raw secret must never be committed, persisted in SQLite, copied to an approval record, or stored in audit.

An approval-only runtime registers `POST /v1/controlled-shipments` and never registers the preview route. The server refuses simultaneous preview + approval configuration, so the create route cannot coexist with the pre-approval quote runtime.

## Controlled create gates

Before provider creation, the core verifies:

1. controlled runtime is loopback-only;
2. approval is inside its issued/expiry window;
3. approval secret hash matches in constant time;
4. tenant and provider match the approval scope;
5. normalized shipment payload SHA-256 exactly matches the approved digest;
6. target carrier exists and is still `enabled: false`;
7. shipment idempotency key is atomically claimed;
8. adapter still exposes `create_shipment`;
9. provider-specific validation runs unchanged.

For Starken, `allowedOriginAgencyCodes` therefore remains mandatory and missing/empty/out-of-list origins still fail before credential resolution or network I/O.

## One-attempt semantics

The atomic idempotency claim is acquired before `adapter.createShipment()`. Only the winner of a concurrent claim may reach provider I/O.

The idempotency record stores a SHA-256 fingerprint of the normalized shipment request. Reusing the same idempotency key with a different payload is rejected.

If provider creation fails, the idempotency record becomes `failed`; the same key cannot be retried automatically. Reconciliation and a new explicit approval are required.

If creation completes, subsequent requests with the exact same payload/key return the existing shipment without another provider create attempt.

## Audit

A successful controlled create records:

```text
action = shipment.create.controlled
actor = controlled-api
metadata.provider
metadata.approvalId
```

The approval secret is never stored in audit metadata.

## Operational rule

Use a preview-only runtime to obtain the live quote. Stop it. Review and approve the exact create payload. Start a separate approval-only runtime for at most one provider create attempt. Reconcile the result and stop that runtime.

At no point does this mechanism change `CarrierConnection.enabled`, and it does not enable normal automation afterward.
