# Carrier catalog synchronization and routing

**Runtime status:** current in v0.10.0 · introduced in v0.7.0

The integrator maintains versioned, tenant-scoped carrier location catalogs so provider routing codes are resolved in the control plane instead of being hardcoded in orders or marketplace logic.

## Invariant

Provider catalog refresh is explicit network I/O. Quoting and automatic shipping never refresh a catalog implicitly.

The flow is:

```text
carrier API (explicit sync)
        ↓
normalized carrier catalog snapshot
        ↓
SQLite active version
        ↓
local routing resolver
        ↓
providerCityCode / providerCommuneCode / providerAgencyCode
        ↓
quote / shipment orchestration
```

Dynamic Freight remains snapshot-first for tariffs. Carrier location catalogs and tariff snapshots are separate concerns.

## Generic snapshot

`CarrierLocationCatalogSnapshot` contains normalized collections for:

- regions;
- cities;
- communes;
- agencies.

Snapshots are tenant + provider scoped. A SHA-256 digest over normalized sorted content is used as the version, so identical provider content produces the same semantic version. Activation is atomic; an incomplete refresh cannot replace the prior active snapshot.

The public core stores normalized routing/operational fields only. Raw provider responses and credentials are not persisted.

## Starken sync

For the verified Starken plugin-gateway protocol, an explicit sync reads:

- `GET /agency/region`
- `GET /agency/city`
- `GET /agency/comuna`
- `GET /agency/agency`

The request uses the carrier connection `credentialRef`; the token is resolved at runtime and never stored in SQLite or Git.

Control-plane endpoint:

```text
POST /v1/tenants/:tenantId/carriers/starken/catalog/sync
```

Read the active summary:

```text
GET /v1/tenants/:tenantId/carriers/starken/catalog
```

The HTTP response intentionally returns version/count metadata rather than dumping the whole provider catalog.

## Routing resolution

Resolve a normalized address locally:

```text
POST /v1/tenants/:tenantId/carriers/starken/routing/resolve
```

Example body:

```json
{
  "address": {
    "region": "Maule",
    "commune": "Talca"
  },
  "deliveryMode": "agency",
  "agencyName": "Example Branch",
  "package": {
    "weightKg": 2,
    "lengthCm": 100,
    "widthCm": 40,
    "heightCm": 30
  },
  "declaredValueClp": 100000
}
```

Matching is case/diacritic insensitive. Commune matches must be unique after optional region disambiguation. Agency selection must also be unique; the resolver never chooses arbitrarily between multiple eligible branches.

The result enriches the generic address with provider routing codes while retaining the human-readable region/commune fields.

## Agency acceptance limits

The current Starken agency catalog exposes fields including maximum length, width, height and declared value. Positive limits are normalized and enforced before shipment creation.

Provider values of `0` are treated as **unspecified**, not as zero capacity. The current `weight_restriction` value is retained as opaque metadata because its public semantics are not sufficiently established to convert it into a numeric maximum safely.

Destination-agency routing only considers agencies that are active and marked for delivery. Oversized packages or declared values fail closed.

## Automatic shipping

`POST /v1/automatic-shipments` can opt into local routing enrichment with:

```json
{
  "routeWithCatalog": true
}
```

This flag reads only the active SQLite catalog. It does not perform provider network calls.

For each provider candidate with an active catalog, automatic shipping resolves origin/destination routing before quote. The selected provider's routed addresses are then preserved through shipment creation. If a quote selects agency delivery and multiple eligible agencies exist without an explicit selection, shipment creation fails closed rather than picking one.

## Refresh policy

Catalog synchronization is an operational/control-plane action. Recommended deployment behavior:

1. sync during onboarding;
2. refresh on a scheduled cadence appropriate to provider change frequency;
3. retain the previous active snapshot when refresh validation fails;
4. record the active version alongside shipment orchestration metadata;
5. alert on large count/hash changes before production rollout if desired.

No carrier catalog should become a synchronous checkout dependency.
