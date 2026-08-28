# Mercado Libre Application Identity — Maustian Integrator

**Status:** product architecture decision
**Scope:** public integrator product only
**Cut:** 2026-08-28

## 1. One canonical Mercado Libre application for the product

The public product must use **one canonical Mercado Libre application owned by Maustian** as the identity of the integrator.

That application is not a Plasticov application, not a storefront application, not an Ads application and not a generic company-wide credential bucket. It represents this product:

```text
Maustian SpA — solution owner
          │
          └── Maustian Integrator Application (one App ID)
                    │
                    ├── Maustian seller self-grant
                    ├── Plasticov seller grant
                    ├── Seller C grant
                    └── Seller D grant
```

Each seller authorizes the same application through OAuth. The application owner may also be a seller: Mercado Libre explicitly documents that the owner can self-grant its own application. Therefore **Maustian SpA may simultaneously be the solution owner/developer and one seller tenant of the same integration**.

App identity and seller identity must stay separate:

```text
shared across the product:
  APP_ID + CLIENT_SECRET + callback/webhook identity

isolated per seller grant:
  seller_id + access_token + refresh_token + tenant policy + ME1 state
```

Plasticov is another seller grant, not another developer application. Tokens, refresh tokens, seller IDs and tenant policy remain isolated per seller/tenant.

## 2. Why this matters for DPP

Mercado Libre defines GMV(e) as the monthly GMV of active users using **each application**. Therefore the product must not fragment its sellers across unrelated application IDs if the objective is to build auditable DPP traction.

For Chile the current DPP threshold is USD 200,000 monthly GMV(e), plus good practices, a formal application, Security Assessment >=65%, and assigned certification initiatives.

Official sources:
- https://developers.mercadolibre.cl/es_ar/atributos-y-variaciones/developer-partner-program
- https://developers.mercadolibre.cl/es_ar/como-empezar/autenticacion-y-autorizacion
- Mercado Libre communications docs explicitly state the application owner can self-grant its own application.

The canonical product App ID becomes the durable identity used to measure active sellers, support the certification process and later identify the solution during Dynamic Freight homologation.

## 3. Ownership

Mercado Libre recommends creating the application from the account of the solution owner and recommends that account be under a legal entity.

For this product the intended owner is **Maustian SpA**. The same Maustian Mercado Libre account may also act as a seller and authorize the application it owns. This is a supported OAuth role combination, not an identity conflict.

Official source:
- https://developers.mercadolibre.cl/crea-una-aplicacion-en-mercado-libre-es

The product must not depend on an application owned by a **customer seller** as its long-term identity. That does not prohibit Maustian itself from also being a seller: Maustian is the solution owner, so its seller account is simply one authorized tenant/grant of its own product application.

## 4. Mercado Libre vs Mercado Pago

From 30/08/2026 Mercado Libre requires Mercado Libre and Mercado Pago applications to be separated by business unit.

The canonical integrator application must therefore contain **no `urn:mp:*` scopes**.

Verification gate:

```text
GET /applications/{APP_ID}
```

and assert that the application scopes contain no Mercado Pago scope.

This repository does not manage or audit unrelated Mercado Pago applications.

## 5. OAuth model

The product is server-side and multi-tenant.

Required model:

```text
seller
  ↓
Maustian authorization URL
  ↓
Mercado Libre consent
  ↓
HTTPS callback owned by the product
  ↓
authorization code + state + PKCE
  ↓
server-side token exchange
  ↓
per-seller encrypted access/refresh grant
```

The product must support:
- Authorization Code;
- Refresh Token;
- offline access;
- `state` verification;
- PKCE S256;
- encrypted token storage;
- seller/app/tenant binding;
- rotation/revocation/recovery;
- duplicate-seller protection;
- audit evidence without token disclosure.

Mercado Libre currently documents PKCE as optional but recommended. The product treats PKCE as the target production configuration.

## 6. Redirect and notification ownership

The canonical application must use HTTPS endpoints owned by the product, not tenant-specific domains.

Target shape:

```text
https://<maustian-product-domain>/oauth/mercadolibre/callback
https://<maustian-product-domain>/webhooks/mercadolibre
```

The exact production domain is deployment configuration and must not be hard-coded into the public core.

Tenant-specific domains such as a seller storefront are not the long-term OAuth identity of the integrator.

## 7. Functional permissions — least privilege

Enable only permissions required by the product release.

Minimum expected product capabilities:

1. **Usuarios** — default identity/account information.
2. **Ventas y envíos** — orders, shipments, claims/returns required by logistics operation.
3. **Publicación y sincronización** — only when the product actually performs ME1/listing migration or dimension/shipping updates.

Additional permissions such as Communications, Metrics, Promotions, Ads or Invoices must be justified by an implemented product feature; they are not enabled merely because they exist.

Official functional-permission source:
- https://developers.mercadolibre.cl/es_ar/permisos-funcionales

## 8. Notification topics

Initial logistics-oriented topics should be selected from the smallest set necessary for implemented behavior, normally including:
- Orders;
- Shipments;
- Items when listing/shipping configuration is managed;
- Claims/returns where required by post-sale logistics.

Topics not consumed by the product must not be enabled merely for future speculation.

## 9. Public/private boundary

Public repository stores:
- App architecture;
- OAuth contracts;
- callback/topic requirements;
- permission requirements;
- environment variable names;
- validation logic.

Private/deployment stores hold:
- real App ID;
- Client Secret;
- access/refresh tokens;
- seller IDs and tenant mappings;
- authorization evidence containing private seller data.

A real App ID may be referenced in controlled private operational evidence, but should not be required by the public source code.

## 10. Maustian seller + Plasticov seller

The first deployment should prove the multi-role/multi-tenant model explicitly:

```text
Maustian SpA owns canonical integrator App
        │
        ├── Maustian seller self-grants App
        │      └── tenant = maustian
        │
        └── Plasticov seller grants same App
               └── tenant = plasticov
```

Maustian's seller role is useful for proving owner self-grant, tenant isolation and normal seller API behavior. Plasticov remains the controlled logistics/ME1 pilot with its private packaging, tariff and carrier policy.

The private Plasticov overlay stores only Plasticov's seller `credentialRef` and tenant-specific logistics data. The public repository stores neither seller's tokens nor tenant data.

A seller-specific application may exist for unrelated historical tooling, but it is outside this integration's architecture and must not become a dependency of the public product.

## 11. Gate before external seller onboarding

Before onboarding Seller B:

- [ ] canonical Maustian product App ID exists;
- [ ] owner account/legal identity confirmed;
- [ ] application contains no `urn:mp:*` scopes;
- [ ] PKCE enabled in application and proven E2E;
- [ ] product-owned HTTPS callback configured;
- [ ] product-owned notification callback configured;
- [ ] functional permissions reduced to implemented needs;
- [ ] notification topics reduced to implemented needs;
- [ ] secrets are deployment-only;
- [ ] Maustian owner self-grant maps to exactly one `maustian` tenant;
- [ ] Plasticov grant maps to exactly one `plasticov` tenant;
- [ ] both grants resolve the same canonical App ID but different seller IDs/tokens;
- [ ] GMV(e) telemetry attributes active seller usage to this canonical App ID.

Until these checks pass, external sellers should not be distributed across temporary application identities.
