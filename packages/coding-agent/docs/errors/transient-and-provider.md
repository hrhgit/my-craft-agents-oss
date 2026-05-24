# Transient and Provider Errors

These errors usually mean the model request failed in transit or the upstream provider rejected or interrupted the request.

## Common messages

- `terminated`
- `fetch failed`
- `timeout`, `timed out`
- `too many requests`, `429`
- `500`, `502`, `503`, `504`
- `service unavailable`
- `connection lost`, `connection refused`, `socket hang up`
- `websocket closed`, `websocket error`

## What they usually mean

### `terminated`

The streaming response ended unexpectedly before pi finished receiving the model output.

Typical causes:
- unstable network
- proxy or VPN interruption
- provider-side stream reset
- long-running request cut off by an intermediate layer

In pi, this is treated as a transient retryable error.

### `429`, `too many requests`, rate limit

The provider accepted the request shape but rejected it due to quota, concurrency, or rate limits.

Typical causes:
- too many requests in a short period
- insufficient plan quota
- provider-side burst limit

### `500`-`504`, `service unavailable`

The provider or an upstream service failed while serving the request.

Typical causes:
- provider outage
- overloaded backend
- gateway timeout
- regional service instability

## What to check first

1. Retry once if the error was sporadic.
2. Check whether pi auto-retry is enabled in `~/.pi/agent/settings.json`.
3. Check provider authentication and quota.
4. Check local network, proxy, VPN, or corporate gateway.
5. If failures happen on long requests, consider increasing provider timeout.

## Relevant settings

See `../settings.md`.

Useful keys:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

## Related files

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/docs/settings.md`
- `packages/coding-agent/docs/providers.md`

## When the problem is persistent

If the same request fails repeatedly:
- switch to another provider or model
- shorten the request
- reduce large attachments or context
- inspect provider credentials and billing state
- inspect proxy, VPN, or firewall behavior
