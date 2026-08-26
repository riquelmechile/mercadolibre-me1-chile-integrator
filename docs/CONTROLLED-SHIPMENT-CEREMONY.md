# Controlled shipment ceremony

Core v0.8.2 provides a provider-neutral controlled lifecycle for previewing, creating, reconciling and observing one shipment while the normal carrier connection remains disabled.

This exists for first-production ceremonies and similarly sensitive migrations. It is not an alternative automation API.

## Safety model

Normal routes keep their existing semantics:

- `/v1/quotes` requires an enabled carrier.
- `/v1/shipments` requires an enabled carrier.
- `/v1/automatic-shipments` only selects enabled carriers.

Controlled behavior is split into three independent runtime gates:

1. **preview gate** — read-only live quote + server-derived create digest on a disabled carrier;
2. **approval gate** — exact-payload one-shot shipment creation on a disabled carrier;
3. **observation gate** — provider reconciliation + tracking reads for one existing shipment on a disabled carrier.

Every controlled runtime is **loopback-only**. Configuring any gate causes startup to fail if `APP_HOST` is not `127.0.0.1`, `localhost`, or `::1`. Preview, approval and observation envelopes are pairwise mutually exclusive: the core refuses to start if more than one is configured in the same process.

The target carrier must exist and remain `enabled: false`. If it becomes enabled, controlled operations reject the request rather than becoming a second normal path. While any controlled gate is active, every other non-GET `/v1/` mutation is locked with HTTP 423; only the controlled mutation(s) specific to that runtime are accepted.

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

An approval-only runtime registers `POST /v1/controlled-shipments` and never registers preview or observation routes. The server refuses simultaneous controlled modes, so create cannot coexist with preview or post-create observation.


## Phase C — controlled reconciliation and tracking observation

After a controlled create has produced a persisted shipment, stop the approval runtime. Start a fresh observation-only loopback runtime when reconciliation or tracking is required. Observation sessions are independently short-lived and may be repeated later with new secrets; they never expose quote or create.

Environment envelope:

```text
CONTROLLED_SHIPMENT_OBSERVATION_ID
CONTROLLED_SHIPMENT_OBSERVATION_TENANT_ID
CONTROLLED_SHIPMENT_OBSERVATION_PROVIDER
CONTROLLED_SHIPMENT_OBSERVATION_SHIPMENT_ID
CONTROLLED_SHIPMENT_OBSERVATION_SECRET_SHA256
CONTROLLED_SHIPMENT_OBSERVATION_ISSUED_AT
CONTROLLED_SHIPMENT_OBSERVATION_EXPIRES_AT
```

The window may not exceed 60 minutes and all fields are required together. The raw secret is sent only as:

```text
x-controlled-shipment-observation: <ephemeral-observation-secret>
```

The observation runtime registers only `POST /v1/controlled-shipment-observation` among controlled mutation endpoints. The gate checks time, secret, tenant, provider and exact shipment ID before provider I/O, and the target carrier must still be `enabled: false`.

The service first invokes an optional provider reconciliation read when the shipment lacks a tracking number or label. Reconciled tracking number/label/provider metadata are persisted without changing shipment identity or idempotency. It then calls provider tracking, normalizes events through the adapter, and ingests them through the existing dedupe and monotonic-final-state rules. Repeating an observation is safe: duplicate provider events are not duplicated locally.

For the official Starken adapter, reconciliation uses only `GET /emision/consulta/{issuanceId}` and tracking uses only the existing provider tracking GET path. No provider create is available in observation mode.

A successful observation records `shipment.observe.controlled` with `observationId`; the observation secret is never stored.

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

Use a preview-only runtime to obtain the live quote and normalized digest. Stop it. Review and approve the exact create payload. Start a separate approval-only runtime for at most one provider create attempt, then stop it. Use fresh observation-only runtimes as needed to reconcile the issuance and observe tracking through terminal outcome.

At no point does this mechanism change `CarrierConnection.enabled`, and it does not enable normal automation afterward.
