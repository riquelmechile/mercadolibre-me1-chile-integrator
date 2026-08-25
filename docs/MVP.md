# MVP runtime — v0.3.0

**Implementation cut:** 25 August 2026.

This repository now includes an executable MVP for the logistics core described in `ARCHITECTURE.md`.

## What runs today

- Node.js 24 + TypeScript + Fastify.
- Durable SQLite persistence using Node's built-in `node:sqlite`.
- Tenant isolation for reads/writes.
- Mercado Libre seller connection records using secret references only.
- Courier connection records for `mock`, `starken`, `blueexpress`, `chilexpress`.
- Versioned tariff snapshots with one active snapshot per tenant/provider.
- Snapshot-first quote engine with volumetric-weight support.
- Idempotent shipment creation.
- Canonical tracking events with duplicate detection and monotonic final states.
- Append-only audit events.
- Fastify HTTP API with correlation IDs and redacted secret headers.
- Mock courier adapter for complete local/sandbox flows.
- Fail-closed carrier adapter shells for Starken, Blue Express and Chilexpress.
- Mercado Libre adapter boundary with a certification gate for ME1 publication.

## Safety boundary

The MVP deliberately does **not** guess private carrier API contracts.

Starken, Blue Express and Chilexpress adapters expose the normalized provider boundary, but shipment/quote operations fail with `integration_gated` until the official account-specific contract is added and tested.

Secrets must not be placed in repository files or normal database rows. Connections store only a `credentialRef`. The default environment resolver maps for example:

```text
credentialRef = starken/exampleco
-> SECRET_STARKEN_EXAMPLECO
```

The HTTP API rejects config fields whose names look like raw `token`, `secret`, `password`, `apiKey` or `credential` values.

ME1 publication has two gates:

1. runtime `ME1_CERTIFIED=true`; and
2. seller connection `config.me1Certified=true`.

This is intentional so certification cannot be enabled accidentally by changing only one layer.

## Local start

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

Default bind:

```text
http://127.0.0.1:8787
```

Security rule: the runtime refuses to bind to a non-loopback host unless `APP_API_KEY` is configured. When `APP_API_KEY` is set, every `/v1/*` request must send `Authorization: Bearer <key>`. Health/readiness endpoints remain unauthenticated.

Health:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

## Minimal local flow

### 1. Create tenant

```bash
curl -X POST http://127.0.0.1:8787/v1/tenants \
  -H 'content-type: application/json' \
  -d '{"name":"ExampleCo"}'
```

### 2. Connect mock courier

```bash
curl -X POST http://127.0.0.1:8787/v1/tenants/TENANT_ID/carriers \
  -H 'content-type: application/json' \
  -d '{"provider":"mock","config":{}}'
```

### 3. Publish an active tariff snapshot

```bash
curl -X POST http://127.0.0.1:8787/v1/tenants/TENANT_ID/tariff-snapshots \
  -H 'content-type: application/json' \
  -d '{
    "provider":"mock",
    "version":"pilot-v1",
    "rules":[{
      "serviceCode":"RM_STD",
      "serviceName":"RM Standard",
      "currency":"CLP",
      "amount":4990,
      "region":"Metropolitana",
      "minWeightKg":0,
      "maxWeightKg":30,
      "estimatedBusinessDays":2
    }]
  }'
```

### 4. Quote

```bash
curl -X POST http://127.0.0.1:8787/v1/quotes \
  -H 'content-type: application/json' \
  -d '{
    "tenantId":"TENANT_ID",
    "provider":"mock",
    "origin":{"region":"Metropolitana","commune":"Santiago"},
    "destination":{"region":"Metropolitana","commune":"Providencia"},
    "package":{"weightKg":5,"lengthCm":30,"widthCm":20,"heightCm":20}
  }'
```

### 5. Create shipment idempotently

```bash
curl -X POST http://127.0.0.1:8787/v1/shipments \
  -H 'content-type: application/json' \
  -d '{
    "tenantId":"TENANT_ID",
    "provider":"mock",
    "externalOrderId":"MLC-ORDER-1",
    "idempotencyKey":"MLC-ORDER-1:create:v1",
    "origin":{"region":"Metropolitana","commune":"Santiago"},
    "destination":{"region":"Metropolitana","commune":"Providencia"},
    "package":{"weightKg":5,"lengthCm":30,"widthCm":20,"heightCm":20}
  }'
```

Submitting the same idempotency key again returns the original shipment instead of creating a second provider operation.

## REST endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | process health + registered providers |
| GET | `/readyz` | readiness + ME1 certification gate state |
| POST | `/v1/tenants` | create tenant |
| GET | `/v1/tenants/:tenantId` | read tenant |
| POST | `/v1/tenants/:tenantId/carriers` | connect courier by config + credential ref |
| GET | `/v1/tenants/:tenantId/carriers` | list courier connections |
| POST | `/v1/tenants/:tenantId/sellers` | connect Mercado Libre seller by credential ref |
| GET | `/v1/tenants/:tenantId/sellers` | list seller connections |
| POST | `/v1/tenants/:tenantId/tariff-snapshots` | publish/version tariff rules |
| POST | `/v1/quotes` | deterministic snapshot-first quote |
| POST | `/v1/shipments` | idempotent provider shipment create |
| GET | `/v1/tenants/:tenantId/shipments/:shipmentId` | read shipment |
| POST | `/v1/tenants/:tenantId/shipments/:shipmentId/tracking-events` | ingest canonical provider event |
| GET | `/v1/tenants/:tenantId/shipments/:shipmentId/tracking-events` | list tracking history |
| GET | `/v1/tenants/:tenantId/audit` | tenant audit trail |

## Adding an official carrier contract

Do not modify the core service contract first. Add the provider-specific mapping behind the existing `CourierAdapter` boundary:

1. obtain the official current API specification and credentials/sandbox;
2. document auth, base URL, rate limits, idempotency and error semantics;
3. add request/response mapping in the provider adapter;
4. resolve actual credentials through `SecretProvider` using `credentialRef`;
5. add contract fixtures with secrets removed;
6. add quote/create/tracking tests with network mocked;
7. only then enable the declared capabilities on a tenant connection.

Provider code must never infer endpoints from leaked plugins, stale repositories or third-party snippets.

## Next MVP increment

The next implementation slice is the first real carrier pilot, preferably Starken:

- official Starken server-to-server contract;
- account/sandbox auth;
- quote mapping;
- OF/shipment creation;
- label metadata;
- tracking normalization;
- reconciliation against actual billed freight;
- Mercado Libre Custom order/shipment ingestion using a real seller connection.

ME1 Dynamic Freight production remains a later certification milestone.
