# Public product vs tenant-specific data

This repository is the generic, sellable and certification-oriented product core. It must not contain customer-specific or internal-pilot operational data.

## Allowed here

- reusable marketplace and courier contracts;
- multi-tenant runtime and security controls;
- generic packaging algorithms such as `threshold_growth`;
- fictional fixtures and deterministic tests;
- public research and certification requirements;
- provider adapters whose contracts are based on authorized/public documentation.

## Must stay outside this repository

- real seller/company names used as pilot configuration;
- real SKUs and measured packaging tables;
- seller IDs, addresses, buyer data or order exports;
- raw API tokens, credentials or production secrets;
- customer-specific carrier contracts, pricing or credentials;
- private certification evidence tied to individual sellers.

Tenant-specific pilots consume the public core through stable APIs/configuration contracts. They must not fork or duplicate core business logic. Secret values are resolved by deployment infrastructure; Git stores only non-secret reference identifiers.

Every public fixture must be visibly fictional (`ExampleCo`, `FLEX-*`, `fictional-example`).
