# Changelog

## 0.0.5 - 2026-04-28

- **BREAKING:** `new Client(...)` now requires an API key, sourced from
  the `apiKey` constructor option or the `RESCONTRE_API_KEY` environment
  variable. Construction throws `RescontreConfigurationError` if neither
  is set.
- The SDK now sends `X-API-Key: <key>` on every `verify` and `settle`
  request. Public endpoints (`/health`, `/agents`, `/servers`,
  `/agreements`, `/settlement`, `/webhooks/*`) remain unauthenticated.
- New `AuthenticationError` (subclass of `RescontreAPIError`) is thrown
  without retry when the facilitator returns HTTP 401 from `verify` or
  `settle`.

## 0.0.1 - 2026-04-25

- Initial release.
