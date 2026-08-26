# Automatic shipping from a dimension list

The runtime no longer needs package dimensions in every shipment request. Packaging is resolved from a tenant-scoped durable list before any carrier side effect.

## Resolution order

1. exact `sku`
2. product `family`
3. tenant `default`

Within the same level, the highest `priority` wins. A missing profile fails closed.

## Packaging profile

```json
{
  "name": "Flexible 300",
  "matchType": "sku",
  "matchValue": "FLEX-100",
  "priority": 100,
  "active": true,
  "packingMode": "stack_height",
  "maxQuantity": 4,
  "package": {
    "weightKg": 4.2,
    "lengthCm": 65,
    "widthCm": 45,
    "heightCm": 12
  },
  "metadata": {}
}
```

`package` must represent the measured packed unit/bundle, not naked product dimensions.

### Packing modes

- `fixed`: the profile already represents the whole supported quantity/bundle.
- `scale_weight_only`: dimensions stay fixed, physical weight scales with quantity.
- `stack_height`: weight and height scale with quantity.
- `stack_length`: weight and length scale.
- `stack_width`: weight and width scale.

`maxQuantity` is a safety boundary. Higher quantities are rejected until a profile explicitly covers them.

If `metadata.separatePackage=true`, automatic consolidation is blocked when an order would require more than one physical package. Multi-package provider semantics will be implemented only when official carrier contracts are available.

## Bulk import

Use `POST /v1/tenants/:tenantId/packaging-profiles/import`:

```json
{
  "profiles": [
    {
      "name": "Flexible 300",
      "matchType": "sku",
      "matchValue": "FLEX-100",
      "priority": 100,
      "packingMode": "stack_height",
      "maxQuantity": 4,
      "package": { "weightKg": 4.2, "lengthCm": 65, "widthCm": 45, "heightCm": 12 }
    }
  ]
}
```

A fill-in template lives at [`examples/packaging-profiles.example.json`](../examples/packaging-profiles.example.json).

## Automatic flow

`POST /v1/automatic-shipments` receives order identity, seller, destination and items only:

```json
{
  "tenantId": "...",
  "sellerId": "exampleco-ml",
  "externalOrderId": "MLC-123",
  "marketplaceShipmentId": "123456",
  "origin": { "region": "Metropolitana", "commune": "Santiago" },
  "destination": { "region": "Valparaíso", "commune": "Viña del Mar" },
  "items": [
    { "sku": "FLEX-100", "family": "FLEX", "quantity": 2 }
  ],
  "idempotencyKey": "MLC-123"
}
```

The runtime then performs:

```text
order items
  -> packaging profile resolution
  -> safe quantity expansion
  -> consolidated PackageSpec
  -> enabled carriers
  -> snapshot-first quotes
  -> cheapest eligible quote (or preferredProvider)
  -> idempotent provider shipment creation
  -> persist package/profile/quote provenance
  -> tracking lifecycle
```

The normal automatic quote path uses tariff snapshots (`allowLive=false`). This prevents order creation from depending on carrier API latency and is aligned with the future ME1 Dynamic Freight architecture.

## Conservative multi-line consolidation

For multiple product lines in the current single-package MVP:

- physical weights are summed;
- length is the maximum line length;
- width is the maximum line width;
- heights are summed.

This deliberately prefers conservative dimensions over underestimating freight. If this is not valid for a product, mark the profile with `separatePackage=true`; the order will stop before a courier side effect.

## What remains before production

1. replace template values with measured packed dimensions for each tenant's SKUs/families;
2. operate scheduled Starken catalog refresh/monitoring and load Blue Express/Chilexpress contracts as they are authorized;
3. implement tariff/coverage sync jobs feeding `TariffSnapshot`;
4. connect the Mercado Libre paid-order notification to the automatic request builder;
5. validate provider-specific package limits and multi-package semantics.

## Generic `threshold_growth` example

Tenant-specific dimensions do not belong in this public repository. The example below is intentionally fictional and exists only to document the reusable contract.

| SKU | Weight / unit | 1 unit package | 2 unit package | Growth after threshold |
|---|---:|---|---|---|
| `FLEX-100` | 1.25 kg | 90 × 12 × 8 cm | 120 × 13 × 9 cm | +0.4 cm width / +0.2 cm height per extra unit |

The generic rule is data-driven: below the threshold the base package is used; at/above the threshold a configured fixed length and base cross-section apply, and subsequent units grow width/height by configured increments. Real seller measurements must live in a private tenant configuration store/repository.


## Delivery intent

Automatic requests may carry optional provider-neutral shipping intent:

```json
{
  "deliveryPreference": "agency",
  "paymentMode": "sender_prepaid",
  "declaredValueClp": 25000,
  "destination": {
    "region": "Example Region",
    "commune": "Example Commune",
    "providerLocationId": "opaque-location-id"
  }
}
```

`providerLocationId` is deliberately opaque. The core stores/passes it but does not translate it into a Starken/Blue Express/Chilexpress agency code. If `deliveryPreference` is `home` or `agency`, automatic shipment creation preserves that concrete intent; `any` does not invent a final delivery mode.

Multi-package remains fail-closed. Public evidence that a carrier supports multiple packages is not enough to define how package arrays, labels, tracking identifiers or idempotency work in its Host-to-Host contract.
