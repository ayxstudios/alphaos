# Shopify integration

Stub. Client code for the [Shopify Admin API](https://shopify.dev/docs/api/admin)
goes here.

## Auth model

- **App-level credentials** (Partner dashboard) identify the app during OAuth:
  `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`, `SHOPIFY_APP_URL`,
  `SHOPIFY_WEBHOOK_SECRET`.
- **Per-shop credentials** are the shop domain plus the Admin API access token
  minted when a merchant installs the app. A default shop can be set via
  `SHOPIFY_DEFAULT_SHOP` / `SHOPIFY_DEFAULT_ACCESS_TOKEN` for local dev;
  additional shops' tokens should be persisted per-shop in the database.

## TODO

- [ ] OAuth install flow + token storage
- [ ] Typed Admin API (GraphQL) client
- [ ] Webhook verification (`SHOPIFY_WEBHOOK_SECRET`) + handlers
- [ ] Product / order sync
