# Etsy integration

Stub. Client code for the [Etsy Open API v3](https://developers.etsy.com/) goes here.

## Auth model

- **App-level credentials** (one per AlphaOS install) identify the app to Etsy:
  `ETSY_API_KEYSTRING`, `ETSY_SHARED_SECRET`, `ETSY_OAUTH_REDIRECT_URI`.
- **Per-shop credentials** are OAuth2 tokens obtained when a seller connects
  their shop. A default shop can be set via `ETSY_DEFAULT_SHOP_ID` /
  `ETSY_DEFAULT_SHOP_ACCESS_TOKEN` / `ETSY_DEFAULT_SHOP_REFRESH_TOKEN` for local
  dev; additional shops' tokens should be persisted per-shop in the database.

## TODO

- [ ] OAuth2 connect + token refresh flow
- [ ] Typed API client
- [ ] Listing / order sync
