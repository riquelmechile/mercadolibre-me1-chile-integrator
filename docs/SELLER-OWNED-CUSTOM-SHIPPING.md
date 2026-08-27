# Seller-owned Mercado Libre shipping — Custom now, ME1 later

**Runtime status:** v0.9.0

This document defines the safe path for a seller that wants to connect its own logistics stack to Mercado Libre without pretending that seller ownership replaces Mercado Libre's ME1 / Dynamic Freight certification requirements.

## Decision first

There are two different product paths:

| Path | Who owns logistics | Can this core prepare it now? | Certification boundary |
|---|---|---:|---|
| `custom` | seller | yes, when Mercado Libre currently exposes Custom for the seller/category/item | no Dynamic Freight homologation required for the planner itself |
| `me1` + Dynamic Freight | seller + third-party logistics | only if the seller already has ME1 enabled | activation/homologation requires a certified Dynamic Freight integrator |

Seller OAuth scopes are **not** evidence that a shipping mode is enabled. The runtime discovers current Mercado Libre shipping preferences before recommending a path.

## Officially observed Custom behavior

Current Mercado Libre Custom Shipping documentation describes Custom as seller-managed logistics where the seller provides shipping prices and is responsible for delivery. Orders using Custom have a `shipment_id`, and the seller can update shipment state through `/shipments/{shipment_id}`.

For a `shipped` transition, the current Custom contract includes `receiver_id`, `tracking_number`, and optionally delivery speed/comments. `delivered` and `cancelled` have their own transitions.

Important buyer-experience limitation: the current Custom documentation says `tracking_number` is required by the API for the shipped transition but is not shown in sale listing/detail. This is different from ME1 V2 `seller_notifications`, where `tracking_number` + `tracking_url` are explicitly used for external tracking in the buyer experience.

Therefore the product promise for Custom must be:

> automate seller logistics and Mercado Libre shipment state where the account supports it;
> do not promise ME1-style buyer-visible external tracking until the account is actually on the ME1 V2 path.

## Why we do not self-activate ME1

Current Mercado Libre Chile seller guidance for activating ME1 requires, among other conditions:

- acceptable seller reputation;
- products that can use the ME1 flow;
- an active contract with a Mercado Libre-certified Dynamic Freight integrator;
- an integration hub;
- a maintained contingency tariff table.

Mercado Libre's Dynamic Freight developer documentation also states that endpoint homologation is reserved for certified integrators.

The runtime consequently carries this invariant:

```text
dynamicFreightActivationRequiresCertifiedIntegrator = true
```

If read-only evidence shows the seller already exposes `me1`, the planner can report `existing_me1`; it still does not claim that this repository activated ME1.

## Discovery flow

The runtime reads the current Mercado Libre shipping surfaces through the seller credential reference. For an existing item it also calls Mercado Libre's non-mutating shipping-mode prevalidator; although that endpoint uses HTTP POST, it evaluates allowed modes and does not update the listing:

```text
GET /users/{seller_id}/shipping_preferences
GET /categories/{category_id}/shipping_preferences
GET  /items/{item_id}
POST /users/{seller_id}/shipping_modes   # prevalidation only, no listing mutation
GET  /items/{item_id}/shipping_options?zip_code={zip}
```

The planner then normalizes:

```text
sellerModes
categoryModes
itemMode
itemAvailableModes
customEligible
me1AlreadyAvailable
dynamicFreightActivationRequiresCertifiedIntegrator
recommendedPath
blockers[]
```

`customEligible` is true only from converging evidence. For an existing non-Custom item, category evidence must expose `custom` and the item-specific `shipping_modes` prevalidation must also return `custom`. An item that already uses Custom is direct evidence. When no item-specific probe exists, the planner falls back to seller + category evidence. Unknown, contradictory or malformed responses fail closed.

## Read-only API

Discover seller/category/item shipping capability:

```text
GET /v1/tenants/:tenantId/sellers/:sellerId/shipping/capabilities
    ?categoryId=MLC...
    &itemId=MLC...
```

Inspect the shipping options Mercado Libre currently calculates for an item/postal code:

```text
GET /v1/tenants/:tenantId/sellers/:sellerId/shipping/item-options
    ?itemId=MLC...
    &zipCode=...
```

These routes perform Mercado Libre reads only.

## Dry-run Custom item plan

When discovery says the item is eligible, the core can produce the exact Mercado Libre item payload without executing it:

```text
POST /v1/tenants/:tenantId/sellers/:sellerId/shipping/custom/item-plan
```

Example request:

```json
{
  "categoryId": "MLC123",
  "itemId": "MLC999",
  "costs": [
    { "description": "Despacho zona 1", "cost": 4990 },
    { "description": "Despacho zona 2", "cost": 6990 }
  ]
}
```

The planner preserves the item's observed `local_pick_up` value and forces `free_shipping:false` for this paid-cost Custom plan so a migration cannot accidentally erase pickup or keep a previous ME2 free-shipping flag. The result is explicitly marked:

```json
{
  "dryRun": true,
  "method": "PUT",
  "path": "/items/MLC999",
  "body": {
    "shipping": {
      "mode": "custom",
      "local_pick_up": false,
      "free_shipping": false,
      "methods": [],
      "costs": [
        { "description": "Despacho zona 1", "cost": "4990" },
        { "description": "Despacho zona 2", "cost": "6990" }
      ]
    }
  }
}
```

v0.9.0 deliberately exposes **no live item-shipping write endpoint**. A future execution path must reuse the repository's prepare/approve/execute discipline and re-read final Mercado Libre state after the write.

## Dry-run Custom shipment update plan

Build an official Custom shipment transition without sending it:

```text
POST /v1/tenants/:tenantId/sellers/:sellerId/shipping/custom/shipment-update-plan
```

Shipped example:

```json
{
  "shipmentId": "SHIPMENT_ID",
  "status": "shipped",
  "receiverId": "RECEIVER_ID",
  "trackingNumber": "PROVIDER_TRACKING_OR_OF",
  "speedHours": 72
}
```

The core returns a dry-run `PUT /shipments/{shipmentId}` payload. `trackingNumber` is required for `shipped` in this planner. Delivered produces a `PUT`; cancelled follows the current Custom documentation's `POST` transition. A future executor must source `receiverId` from fresh Mercado Libre order/shipment state rather than accepting stale stored buyer data as authority.

## Write gate

The existing low-level `MercadoLibreAdapter.publishCustomTracking()` is now additionally gated by:

```text
SellerConnection.config.customShippingWritesEnabled === true
```

The low-level Custom tracking write uses the fixed official `/shipments/{shipmentId}` path and remains disabled unless `customShippingWritesEnabled=true`. When disabled, it fails before secret resolution/network I/O; tenant config cannot substitute an arbitrary write path.

No HTTP route in v0.9.0 turns a dry-run Custom item plan into a live Mercado Libre mutation.

## Relationship to Starken

The intended seller-owned flow is:

```text
Mercado Libre order
      ↓
packaging + origin + destination
      ↓
Starken quote / controlled create
      ↓
OF / tracking reconciliation
      ↓
Custom shipment status plan
      ↓
future guarded Mercado Libre execution
```

This gives us a production-shaped workflow before Dynamic Freight certification, but only for seller/category/item combinations where Mercado Libre actually exposes Custom.

The price shown before purchase remains constrained by the shipping mode Mercado Libre enables for the seller/listing. Dynamic Freight real-time checkout pricing remains a separate certified integration path.

## Current source basis

- Mercado Libre Developers — Envíos Personalizados, updated March 2026.
- Mercado Libre Developers — Gestión Mercado Envíos / shipping preferences.
- Mercado Libre seller learning center — activation and maintenance requirements for ME1.
- Mercado Libre Developers — Dynamic Freight homologation requirements.
- Mercado Libre Developers — ME1 V2 order/tracking states and external tracking semantics.

Treat these as external contracts: re-check current official documentation before enabling a new production write path.
