# Changelog

## 0.1.0 - 2026-07-19

- Repositioned for the agent payment ops product: the primary surface is
  now event ingestion, receipt timelines, and the issue inbox.
- New `client.sendEvent({...})` for `POST /events`, with built-in retry
  (backoff on network errors, timeouts, 429/5xx; never on 4xx). Retries
  are idempotent because the server dedups on
  `(source, external_id, event_type)`; a replayed send returns
  `duplicate: true`. Schedule configurable via the `retryBackoffMs`
  client option.
- New `client.listIssues(...)`, `client.searchReceipts(...)`, and
  `client.getReceipt(correlationId)` for `GET /issues`, `GET /receipts`,
  and `GET /receipts/{id}`.
- New exports: `IngestEventResult`, `OpsEventType`, `EVENT_TYPES`,
  `AMOUNT_REQUIRED_EVENT_TYPES`, `RESERVED_SOURCE_PREFIXES`,
  `SendEventParams`, `ListIssuesParams`, `SearchReceiptsParams`,
  `DEFAULT_RETRY_BACKOFF_MS`.
- `sendEvent` validates locally before any network call: unknown event
  types, reserved `rail:`/`webhook:` source prefixes, and missing
  `amount` on `payment.succeeded`/`payment.refunded` throw
  `RescontreError`.
- Clearinghouse methods (`verify`, `settle`, `bilateralSettlement`,
  registration/agreements) are unchanged but documented as legacy; they
  return `403` against `OPS_MODE=true` deployments.

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
