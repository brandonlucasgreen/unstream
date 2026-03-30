# Unstream Public API: Security Architecture

> Status: **On hold** (March 2026). Saved for reference if a company or integration partner expresses interest. The primary scaling risk (third-party platforms blocking Unstream's IPs under high request volume) needs to be addressed before opening the API publicly.

## 1. Current State

### Cost structure per search

A single `/api/search/sources?query=X` call fans out to **9 parallel platform searches** (Bandcamp, Bandwagon, Mirlo, Faircamp, Jamcoop, Patreon, Qobuz, Ampwall, Beatport), then makes additional follow-up requests for release disambiguation. Each call, on a cache miss, generates roughly **15-25 outbound HTTP requests** to third-party sites. MusicBrainz enrichment (Phase 2) adds another 3 requests with mandatory 1.1s delays.

### Existing infrastructure

- **Rate limiting**: IP-based via Upstash Redis, sliding window. Standard: 30 req/min, Strict: 10 req/min.
- **Caching**: Redis cache-aside, 30-minute TTL per platform per query.
- **CORS**: `Access-Control-Allow-Origin: *` (wide open).
- **Response caching**: `Cache-Control: s-maxage=60, stale-while-revalidate`.

---

## 2. API Key Management

### Key format

Prefix `usk_live_` (production) or `usk_test_` (sandbox). Body: 32 bytes cryptographically random, base62-encoded.

```
usk_live_a3Bf9kLm2nPq4RsT5uVw6xYz7Ab8Cd9E
```

### Supabase schema

```sql
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email   text NOT NULL,
  owner_name    text,
  key_prefix    text NOT NULL,          -- first 8 chars for display
  key_hash      text NOT NULL UNIQUE,   -- SHA-256 hash of the full key
  tier          text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'internal')),
  daily_limit   integer NOT NULL DEFAULT 100,
  per_second    integer NOT NULL DEFAULT 1,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  description   text,
  allowed_origins text[]
);

CREATE INDEX idx_api_keys_hash ON api_keys (key_hash) WHERE is_active = true;
```

Never store raw keys. Show the full key once at creation, store only the SHA-256 hash.

### Registration flow

- Free tier: Self-service via existing Supabase Auth. Max 3 keys per account.
- Pro tier: Request form with use case description, manual approval.
- Internal tier: Unstream's own apps (web, extension, macOS).

---

## 3. Tiered Rate Limiting

| Tier | Per-second | Per-minute | Per-day | Batch size |
|------|-----------|-----------|---------|------------|
| Anonymous (no key) | 1 | 10 | 50 | N/A |
| Free | 1 | 30 | 100 | 5 |
| Pro | 5 | 100 | 10,000 | 20 |
| Internal | 20 | 300 | unlimited | 50 |

Per-key limits use the existing `@upstash/ratelimit` sliding window, keyed by `rl:api:{key_hash_prefix}:{window}`. Both per-second (burst) and per-day (quota) checks must pass.

---

## 4. API Design

### URL structure

```
GET  /api/v1/search?query=Radiohead           -- single artist search
POST /api/v1/search/batch                      -- multi-artist batch
GET  /api/v1/artist/{slug}                     -- artist profile lookup
GET  /api/v1/platforms                         -- list of supported platforms
GET  /api/v1/status                            -- health check (no auth)
```

### Response format

```json
{
  "data": {
    "query": "Radiohead",
    "results": [...]
  },
  "meta": {
    "cached": true,
    "latency_ms": 142,
    "result_count": 3,
    "api_version": "1"
  }
}
```

### Error format

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "You have exceeded your daily quota of 100 requests.",
    "details": { "limit": 100, "remaining": 0, "resets_at": "2026-03-30T00:00:00Z" }
  }
}
```

### Standard headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 73
X-RateLimit-Reset: 1711756800
X-Request-Id: req_abc123
```

---

## 5. Security Considerations

### CORS

- With valid API key: allow any origin (or key-specific `allowed_origins`)
- Without API key: only allow `https://unstream.stream`

### Request validation

- Max query length: 200 characters
- Strip control characters, limit to printable Unicode
- Max 50 results per response

### SSRF prevention

This is the most important security concern. Each search causes outbound requests to URLs partly influenced by scraping results.

- Maintain explicit allowlist of outbound hostnames (bandcamp.com, mirlo.space, qobuz.com, etc.)
- Set `redirect: 'manual'` on outbound fetches and validate redirect targets
- Never fetch URLs from user input without hostname validation

### Monitoring

Track per-key usage in a `api_usage_log` table. Alert on:
- Key hitting >80% of daily quota
- Spike in 429 responses
- Identical repeated queries (scraping pattern)
- >1000 unique queries/day from one key (enumeration attempt)

### Cost control

- Extend cache TTL to 2-4 hours for API consumers (web app keeps 30 min)
- Global circuit breaker: if total outbound requests exceed threshold, degrade to cache-only
- Pre-warm cache for top 1,000 most-searched artists nightly
- For free tier, skip slowest platforms to reduce outbound load

---

## 6. Scalability

### Netlify limits

- Concurrent executions: 1,000/site on Pro
- Timeout: 10-26 seconds
- Invocations: 12.5M/month on Pro ($25/mo)

### When to migrate

Netlify is adequate until ~10 active pro-tier consumers. At that point, consider migrating just the API to a dedicated service (Fly.io, Railway) while keeping the web app on Netlify.

### The real bottleneck

Not Netlify invocations — it's **outbound request volume to third-party platforms**. If Bandcamp or Qobuz sees a sudden 10x increase in scraping from Netlify IP ranges, they may block us. This is the primary reason this initiative is on hold.

---

## 7. Implementation Phases

| Phase | What | Effort | Status |
|-------|------|--------|--------|
| 1 | Versioned URL routing, standardized response/error format | Small | Not started |
| 2 | API key table + generation + validation middleware | Medium | Not started |
| 3 | Per-key rate limiting | Medium | Not started |
| 4 | CORS tightening | Small | Not started |
| 5 | SSRF hostname allowlist | Small | Not started |
| 6 | Developer dashboard (generate/view/revoke keys) | Medium | Not started |
| 7 | Usage logging + monitoring | Medium | Not started |
| 8 | OpenAPI spec + hosted docs | Medium | Not started |
| 9 | Batch endpoint | Small | Not started |
| 10 | Cache tuning, pre-warming, tiered platform access | Small | Not started |

Phases 1-5 are the minimum viable public API. Phases 6-8 make it usable by external developers. Phases 9-10 are scaling optimizations.

---

## 8. Architecture Diagram

```
                         Public API Consumers
                                |
                        [Authorization Header]
                        [usk_live_... API key]
                                |
                                v
                     +---------------------+
                     |   Netlify CDN Edge   |
                     |  (s-maxage=300)      |
                     +---------------------+
                          |  cache miss
                          v
                 +------------------------+
                 |  /api/v1/search        |
                 |  (Netlify Function)    |
                 +------------------------+
                          |
              +-----------+-----------+
              v                       v
     +----------------+     +------------------+
     | API Key        |     | Rate Limiter     |
     | Validator      |     | (Upstash Redis)  |
     | (Redis-cached) |     | per-sec + per-day|
     +----------------+     +------------------+
              |                       |
              +--------> PASS? <------+
                      |           |
                    YES          NO (401/429)
                      |
                      v
              +------------------------+
              |   Redis Cache Check    |
              +------------------------+
                    |            |
                  HIT          MISS
                    |            |
                    v            v
              [Return]    [Fan-out to 9 platforms]
                                |
                                v
                    [Aggregate + disambiguate]
                                |
                    +-----------+-----------+
                    v                       v
           [Cache in Redis]     [Persist to Supabase]
                    |
                    v
           [Return JSON + rate limit headers]
```
