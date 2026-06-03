# DoIT — Backend & API Specification

> The server that powers the **DoIT** iOS app: an offline-first sync backend, a realtime collaboration layer, an AI proxy over the Claude API, and the auth/billing/notification plumbing that the client cannot do alone. This is the engineering counterpart to **`DoIT-AppSpec.md`** (referenced throughout as *AppSpec §x*).

- **Service:** `DoItAi-api` — a standalone, versioned REST + WebSocket API (`/api/v1`); no external service dependencies beyond Apple, APNs, and the Claude API
- **Stack:** Node.js 22 LTS · TypeScript · Fastify · PostgreSQL 16 · Redis · deployed to a managed PaaS
- **Status:** Draft v0.1 — living document
- **Owner:** Fahad
- **Last updated:** 2026-06-03

---

## Table of Contents

1. [Scope & Goals](#1-scope--goals)
2. [Architecture & Stack](#2-architecture--stack)
3. [API Conventions](#3-api-conventions)
4. [Authentication & Authorization](#4-authentication--authorization)
5. [Database Schema](#5-database-schema)
6. [Sync Protocol](#6-sync-protocol)
7. [REST Endpoint Surface](#7-rest-endpoint-surface)
8. [Realtime (WebSocket)](#8-realtime-websocket)
9. [AI Proxy Layer](#9-ai-proxy-layer)
10. [Push Notifications (APNs)](#10-push-notifications-apns)
11. [Background Jobs](#11-background-jobs)
12. [Billing & Entitlements](#12-billing--entitlements)
13. [Versioning & Schema Evolution](#13-versioning--schema-evolution)
14. [Security & Privacy](#14-security--privacy)
15. [Observability](#15-observability)
16. [Infrastructure & Deployment](#16-infrastructure--deployment)
17. [Project Structure](#17-project-structure)
18. [Testing Strategy](#18-testing-strategy)
19. [Roadmap & Milestones](#19-roadmap--milestones)
20. [Open Questions & Risks](#20-open-questions--risks)
21. [Appendix — Error Codes & Examples](#21-appendix--error-codes--examples)

---

## 1. Scope & Goals

**What this service is.** The authoritative server-side mirror of the app's local store, plus the capabilities a client genuinely can't own:

- **Sync** — accept client-generated mutations, reconcile conflicts, and serve deltas so a user's data is identical across devices.
- **Collaborate** — model shares/members/roles, fan out realtime changes, and drive cross-user notifications.
- **AI** — proxy the Claude API with the server-held key, prompt caching, and structured-output validation (AppSpec §5.10). **The key never ships in the app.**
- **Identity & money** — Sign in with Apple, per-user authorization, and StoreKit receipt validation for the Pro entitlement.
- **Compliance** — data export and account deletion.

**Design tenets**

- **The client is the source of truth for a single device; the server is the source of truth across devices.** The app is offline-first (AppSpec §7–§8). The server never blocks the UI — it reconciles asynchronously.
- **Client-generated IDs.** Every entity `id` is a UUID minted on the client so offline creates survive sync with no remap (AppSpec §6). The server treats `POST`/`PUT` of a known `id` as an idempotent upsert.
- **Additive, versioned contracts.** The API is versioned from day one under `/api/v1`; new fields are added nullable so an older app build keeps working as the schema evolves (global contract-stability rule).
- **Authorize everything, trust nothing from the client.** Every request is authenticated from day one and share-role permissions are enforced server-side (AppSpec §13) — never on the client.
- **Idempotent, retry-safe background work** with timeouts and backoff on every external call (global rules).

**Non-goals (v1)**

- Not a web client or admin UI — this is an API. (A future web app may consume the same v1 surface.)
- No server-side rendering of the sectograph/planner/calendar — those are pure client views over synced data (AppSpec §6 "*views, not entities*").
- The server does **not** read the user's Apple Calendar; EventKit free/busy stays on-device (AppSpec §5.5). The server only stores app-native events.
- No server-side full-text search engine in v1 — NL search returns a structured filter the client runs locally (see [§9](#9-ai-proxy-layer)).

**Success metrics (operational)**

| Metric | Target |
| --- | --- |
| Sync push p95 latency | < 300 ms |
| Sync pull p95 latency (typical delta) | < 250 ms |
| Realtime change → other device | < 1.5 s p95 |
| AI parse p95 (fast model) | < 1.5 s |
| API availability | ≥ 99.9% |
| Crash-free / unhandled-error rate | < 0.1% of requests |

---

## 2. Architecture & Stack

```
                          iOS app  ·  widgets  ·  (future web)
                                   │  HTTPS / WSS
                  ┌────────────────┴─────────────────────────────┐
                  │            Fastify app (stateless, N pods)     │
                  │  routes → services → repositories             │
                  │  auth · sync · ai · shares · realtime · push  │
                  └───────▲──────────────▲───────────────▲────────┘
                          │              │               │
              ┌───────────┴──┐   ┌───────┴───────┐   ┌───┴─────────────┐
              │ PostgreSQL 16│   │ Redis          │   │ External        │
              │ source of    │   │ pub/sub (WS    │   │ Apple ID (JWKS) │
              │ truth +      │   │ fan-out),      │   │ APNs (HTTP/2)   │
              │ change_log   │   │ BullMQ queues, │   │ Anthropic API   │
              │ (cursor)     │   │ rate limits    │   │ App Store API   │
              └──────────────┘   └────────────────┘   └─────────────────┘
```

**Why this stack** (decided with the owner): Node + TypeScript gives a first-class Anthropic SDK with prompt caching, trivial WebSocket support, and the option to share DTO/validation types with a future web client. PostgreSQL gives relational integrity, `JSONB` for the flexible/sparse task fields, array + GIN indexing for share-visibility fan-out, and a clean monotonic cursor via `BIGSERIAL`. A managed PaaS keeps ops minimal for a solo owner while still scaling WebSocket horizontally via Redis pub/sub.

**Core libraries**

| Concern | Choice | Notes |
| --- | --- | --- |
| HTTP framework | **Fastify** | Schema-first, fast, plugin model |
| DB access + migrations | **Drizzle ORM + drizzle-kit** | TS-native, SQL-close, versioned migrations |
| Validation | **Zod** | One schema reused for HTTP I/O, AI structured-output validation, and OpenAPI generation |
| Auth | **jose** (verify Apple JWT, sign our JWTs) | ES256/RS256 |
| Realtime | **ws** + **ioredis** pub/sub | Multi-instance fan-out |
| Jobs/queues | **BullMQ** on Redis | Retry, backoff, idempotent workers |
| AI | **@anthropic-ai/sdk** | Prompt caching, tool use, streaming |
| Push | APNs over HTTP/2 (token auth, `.p8`) | `node-apn`-style client or raw `http2` |
| Logging | **pino** | Structured JSON, request-scoped child loggers |
| Tracing/metrics | **OpenTelemetry** + **Sentry** | Traces, metrics, error capture |
| Tests | **Vitest** + **supertest** + **Testcontainers** | Real Postgres in integration tests |

**Concurrency & layering.** Routes are thin (parse → authorize → delegate). Business logic lives in per-module **services**; all SQL lives in **repositories**. No business logic in routes; no SQL in services — mirrors the app's "keep concerns in their layer" rule and the AppSpec's actor/service split (AppSpec §7).

---

## 3. API Conventions

- **Base URL:** `https://doit.app/api/v1` *(placeholder host — set your production domain at deploy)*. Greenfield surface — there is no legacy API to preserve.
- **Transport:** TLS only (PaaS-terminated). HTTP/2 where the platform supports it.
- **Format:** JSON request/response, `Content-Type: application/json; charset=utf-8`. Timestamps are **RFC 3339 UTC** (`2026-06-03T08:30:00Z`); all-day/floating items carry a `floating: true` flag and a date-only `localDate` (AppSpec §5.1 edge cases).
- **IDs:** UUID v4 strings, **client-generated** (AppSpec §6). The server rejects a create whose `id` collides with another user's row (404/409, never cross-tenant leakage).

**Required request headers**

| Header | Purpose |
| --- | --- |
| `Authorization: Bearer <accessJWT>` | Auth on every v1 call except `/auth/*` and `/health` |
| `Idempotency-Key: <uuid>` | On all non-GET requests; dedupes retries (see [§6](#6-sync-protocol)) |
| `X-Client-Version: <semver>` | For compatibility gating + analytics |
| `X-Request-Id: <uuid>` | Optional; echoed back; generated if absent |

**Response envelope.** Success returns the resource/collection directly. Errors always use:

```json
{
  "error": {
    "code": "conflict",
    "message": "serverVersion is ahead of baseVersion",
    "details": { "entity": "task", "id": "…", "serverVersion": 7 },
    "requestId": "0f2c…"
  }
}
```

**Status codes:** `200` ok · `201` created · `204` no content · `400` validation · `401` unauthenticated · `403` unauthorized (role/ownership) · `404` not found / not visible · `409` conflict (version/structural) · `410` gone (revoked invite) · `422` semantic validation · `429` rate-limited · `5xx` server. The full machine-readable `code` enum is in the [Appendix](#21-appendix--error-codes--examples).

**Pagination:** cursor-based — `?cursor=<opaque>&limit=<n≤200>`; responses include `nextCursor` (null at end). No offset pagination (unstable under concurrent writes).

**Rate limiting:** token-bucket per user **and** per IP, in Redis. Standard `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers; `429` with `Retry-After`. AI endpoints have separate, tighter buckets plus a monthly token budget (see [§9](#9-ai-proxy-layer)).

**Validation:** every body/query validated by a Zod schema at the edge; failures return `400` with a `details.fieldErrors` map. The same schemas generate the OpenAPI 3.1 doc served at `/api/v1/openapi.json` and drive contract tests against the app's DTOs.

---

## 4. Authentication & Authorization

### 4.1 Sign in with Apple

The only identity provider at launch (AppSpec §13). Flow:

1. Client performs Sign in with Apple, obtains an Apple **identity token** (JWT) + **authorization code**.
2. `POST /api/v1/auth/apple` `{ identityToken, authorizationCode, nonce, deviceInfo }`.
3. Server verifies the identity token against Apple's JWKS (`https://appleid.apple.com/auth/keys`): signature, `iss = https://appleid.apple.com`, `aud = <app bundle id>`, `exp`, and the `nonce` (replay protection). The stable user key is the `sub` claim.
4. Server exchanges the `authorizationCode` at `https://appleid.apple.com/auth/token` to obtain Apple's refresh token, stored encrypted — used to detect account revocation and to honor Apple's **server-to-server notifications** (`/api/v1/auth/apple/notifications` webhook) for account-deletion compliance.
5. Server upserts the `users` row (by `apple_sub`), then issues **our own** tokens.

### 4.2 Token model

| Token | Lifetime | Storage | Notes |
| --- | --- | --- | --- |
| **Access JWT** | 15 min | not stored (stateless) | Signed ES256 with a rotating key (JWKS at `/api/v1/.well-known/jwks.json`); claims: `sub=userId`, `did=deviceId`, `scope`, `exp` |
| **Refresh token** | 60 days, rotating | hashed (SHA-256) in `refresh_tokens` | Opaque random; single-use — each refresh rotates and revokes the prior (reuse detection ⇒ revoke the whole chain) |

Endpoints: `POST /auth/refresh` (rotate), `POST /auth/logout` (revoke this device), `POST /auth/logout-all` (revoke all). Tokens are bound to a `deviceId` so a lost device can be revoked individually.

> **Client storage** (AppSpec §13): access/refresh tokens live in the iOS Keychain, never `UserDefaults`/App Group.

### 4.3 Authorization

- **Ownership:** every owned row carries `owner_id`; every query is scoped to `auth.userId`. A request for an `id` the user can't see returns `404` (never `403` — don't confirm existence across tenants).
- **Shared access:** for rows under a shared list, visibility and write permission are resolved through `share_members.role` (see [§5](#5-database-schema), [§7.7](#77-shares--collaboration)). Role capability matrix:

  | Capability | Owner | Editor | Commenter | Viewer |
  | --- | --- | --- | --- | --- |
  | Read list & tasks | ✓ | ✓ | ✓ | ✓ |
  | Create/edit/complete tasks | ✓ | ✓ | — | — |
  | Comment / @mention | ✓ | ✓ | ✓ | — |
  | Assign members | ✓ | ✓ | — | — |
  | Manage members / roles / delete list | ✓ | — | — | — |

- **Defense in depth:** PostgreSQL **Row-Level Security** policies on owned tables keyed off a `SET app.user_id` per connection/transaction, so a logic bug can't leak across tenants. Application-level checks remain the primary gate; RLS is the backstop.
- **Service-to-service:** APNs/Anthropic/App Store calls use server-held secrets from the PaaS secret store; never proxied with user tokens.

---

## 5. Database Schema

PostgreSQL 16. **Convention for every synced entity** (stated once, not repeated below): columns `id UUID PRIMARY KEY` (client-generated), `owner_id UUID NOT NULL REFERENCES users(id)`, `created_at TIMESTAMPTZ NOT NULL`, `updated_at TIMESTAMPTZ NOT NULL`, `server_version INT NOT NULL DEFAULT 1` (bumped on each server-applied change; guards lost updates), `deleted_at TIMESTAMPTZ` (soft-delete tombstone — rows are never hard-deleted on the sync path; a GC job purges old tombstones). Mirrors the SwiftData model 1:1 (AppSpec §6) so client and server speak the same shape.

### 5.1 Core tables (full DDL)

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY,
  apple_sub     TEXT UNIQUE NOT NULL,
  email         TEXT,
  display_name  TEXT NOT NULL DEFAULT '',
  settings      JSONB NOT NULL DEFAULT '{}',     -- working hours, quiet hours, AI consent, etc.
  ai_consent    BOOLEAN NOT NULL DEFAULT FALSE,  -- explicit opt-in (AppSpec §13)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE devices (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  apns_token    TEXT,                            -- null until registered; rotates
  platform      TEXT NOT NULL DEFAULT 'ios',
  app_version   TEXT,
  push_prefs    JSONB NOT NULL DEFAULT '{}',     -- which push types are enabled
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);

CREATE TABLE refresh_tokens (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     UUID REFERENCES devices(id) ON DELETE SET NULL,
  token_hash    BYTEA NOT NULL,                  -- SHA-256 of the opaque token
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  replaced_by   UUID                             -- rotation chain (reuse detection)
);

CREATE TABLE tasks (
  id                  UUID PRIMARY KEY,
  owner_id            UUID NOT NULL REFERENCES users(id),
  list_id             UUID REFERENCES task_lists(id) ON DELETE SET NULL,
  parent_task_id      UUID REFERENCES tasks(id) ON DELETE CASCADE,  -- subtasks are first-class
  title               TEXT NOT NULL,
  notes               TEXT,                       -- markdown
  status              SMALLINT NOT NULL DEFAULT 0,-- 0 inbox,1 scheduled,2 inProgress,3 done,4 cancelled
  priority            SMALLINT NOT NULL DEFAULT 0,-- 0 none,1 p4 … 4 p1
  rank                INTEGER NOT NULL DEFAULT 0, -- stable manual ordering within a list
  energy              SMALLINT,                   -- 0 low,1 med,2 high
  due_at              TIMESTAMPTZ,
  scheduled_start     TIMESTAMPTZ,
  scheduled_end       TIMESTAMPTZ,
  estimated_minutes   INTEGER,
  actual_minutes      INTEGER,                    -- from focus timer
  is_all_day          BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence          JSONB,                      -- RFC-5545 subset (see RecurrenceRule)
  recurrence_parent_id UUID,                      -- links instances to template
  routine_instance_of UUID REFERENCES routines(id) ON DELETE SET NULL,
  assignee_user_id    UUID REFERENCES users(id),  -- shared lists
  location            JSONB,                      -- { lat, lon, name }
  url                 TEXT,
  field_meta          JSONB NOT NULL DEFAULT '{}',-- per-field {version, updatedAt} for field-level LWW
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL,
  completed_at        TIMESTAMPTZ,
  archived            BOOLEAN NOT NULL DEFAULT FALSE,
  server_version      INTEGER NOT NULL DEFAULT 1,
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX ON tasks (owner_id, updated_at);
CREATE INDEX ON tasks (list_id) WHERE deleted_at IS NULL;
CREATE INDEX ON tasks (owner_id, status, due_at) WHERE deleted_at IS NULL;
```

### 5.2 The sync journal (cursor source)

Every applied mutation appends one row here. This table **is** the delta-sync cursor and the realtime fan-out source — it cleanly handles shared entities (a change to a shared task is visible to every member) and tombstones.

```sql
CREATE TABLE change_log (
  seq              BIGSERIAL PRIMARY KEY,         -- the opaque cursor (monotonic)
  entity_type      TEXT NOT NULL,                 -- 'task','list','tag','routine',…
  entity_id        UUID NOT NULL,
  op               TEXT NOT NULL,                 -- 'upsert' | 'delete'
  version          INTEGER NOT NULL,              -- entity server_version after this change
  actor_user_id    UUID NOT NULL,                 -- who made the change
  visible_user_ids UUID[] NOT NULL,               -- owner + active share members at write time
  payload          JSONB,                         -- full row snapshot for upsert; null for delete
  committed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX change_log_visible_gin ON change_log USING GIN (visible_user_ids);
CREATE INDEX change_log_seq ON change_log (seq);
```

Pull is then `SELECT … FROM change_log WHERE seq > :cursor AND :userId = ANY(visible_user_ids) ORDER BY seq LIMIT :n`. When a user is **added** to a share, their cursor wouldn't include historic rows, so join triggers a one-time **backfill**: the server emits synthetic `change_log` entries (or the client does a scoped full pull of that list) — see [§6.4](#64-shared-data--membership-changes).

### 5.3 Remaining tables (summary)

All follow the sync convention from §5. Full DDL lives in `src/db/schema/`.

| Table | Key columns (beyond the convention) | Notes |
| --- | --- | --- |
| `task_lists` | `name, color_hex, icon, sort_index, share_id` | == project (AppSpec §6) |
| `tags` | `name, color_hex` | M:N with tasks via `task_tags(task_id, tag_id)` |
| `checklist_items` | `task_id, text, done, ord` | lightweight, no scheduling |
| `routines` | `name, color_hex, anchor_time, anchor_event_id, recurrence, chained, is_habit, streak_current, streak_longest, grace_days` | template; generates task instances client-side |
| `routine_steps` | `routine_id, title, minutes, ord, has_alarm` | synced as children of routine |
| `reminders` | `task_id, kind, fire_at, offset_minutes, region, interruption, notification_id` | client schedules `UNNotification`; server stores + can drive smart/digest pushes |
| `alarms` | `task_id, fire_at, type, sound_name, snooze_minutes, uses_live_activity` | client owns delivery (AppSpec §5.6 caveat) |
| `events` | `title, start, end, is_all_day, color_hex, source` | **app-native** events only; EventKit stays on-device |
| `shares` | `list_id, invite_token, invite_expires_at, public` | one per shared list |
| `share_members` | `share_id, user_id, invited_email, role, status, joined_at` | `user_id` null until an invite is accepted |
| `comments` | `task_id, author_id, body, mentions UUID[]` | @mentions drive notifications |
| `activity` | `share_id, task_id, actor_id, type, payload` | activity feed + **conflict log** (structural conflicts surfaced here, never dropped) |
| `idempotency_keys` | `op_id PK, user_id, response_hash, created_at` | dedupe retried mutations (TTL-GC'd) |
| `ai_usage` | `user_id, endpoint, model, input_tokens, output_tokens, cache_read_tokens, cost_cents` | budget + cost tracking |
| `subscriptions` | `user_id PK, product_id, status, expires_at, original_transaction_id, environment` | Pro entitlement (StoreKit) |

`RecurrenceRule` JSON shape (stored in `recurrence`), the RFC-5545 subset from AppSpec §6:

```jsonc
{ "freq": "weekly", "interval": 1, "byWeekday": [2,4,6], "byMonthDay": null, "count": null, "until": null }
```

---

## 6. Sync Protocol

The heart of the backend. Offline-first with optimistic UI on the client (AppSpec §8); the server reconciles. Two operations: **push** (client → server mutations) and **pull** (server → client deltas).

### 6.1 Push — `POST /api/v1/sync/push`

The client flushes its outbox as a batch. Each op is independently idempotent.

```jsonc
// request
{
  "ops": [
    {
      "opId": "f1e2…",                 // client UUID; dedupe key for retries
      "entityType": "task",
      "entityId": "a3b4…",             // client-generated entity id
      "op": "upsert",                  // 'upsert' | 'delete'
      "baseVersion": 4,                // server_version the client last saw (0 for new)
      "clientUpdatedAt": "2026-06-03T08:30:00Z",
      "fields": {                      // changed fields only (a patch)
        "title": "Lunch with Sam",
        "scheduledStart": "2026-06-04T13:00:00Z",
        "scheduledEnd":   "2026-06-04T14:00:00Z",
        "status": 1
      }
    }
  ]
}
```

```jsonc
// response — one result per op, same order
{
  "results": [
    {
      "opId": "f1e2…",
      "entityId": "a3b4…",
      "status": "applied",            // applied | merged | conflict | rejected | duplicate
      "serverVersion": 5,
      "serverFields": null,           // present on 'merged': the fields the server kept
      "committedSeq": "91432"         // change_log seq (bigint as string), advances the pull cursor
    }
  ]
}
```

**Apply algorithm (per op), in one transaction:**

1. **Idempotency:** if `opId` exists in `idempotency_keys`, return the stored result (`duplicate`) — safe replay (global retry-safe rule).
2. **Authorize:** confirm the caller may write this entity (owner or editor on its share). Else `rejected` (403-equivalent in the per-op status).
3. **Load** current row + `server_version`.
4. **Fast path:** if `baseVersion == server_version`, apply the patch, bump `server_version`, set `updated_at`, append `change_log`. Status `applied`.
5. **Conflict path** (`baseVersion < server_version` — someone else wrote first):
   - **Field-level LWW** (AppSpec §8): for each field in the patch, compare `clientUpdatedAt` to that field's `field_meta[field].updatedAt`. Client wins the field iff `clientUpdatedAt` is newer; otherwise the server value is kept and returned in `serverFields`. Bump version. Status `merged`.
   - **Structural conflict** (e.g., client `upsert` vs server already `delete`d, or vice-versa): do **not** silently drop. Resurrect-or-tombstone per a deterministic rule (delete wins over edit by default), write an `activity` row of type `conflict`, and return status `conflict` with detail. The client surfaces it in the activity log.
6. **Record** `opId` in `idempotency_keys` with the response.

> **Why field-level needs `field_meta`.** Row-level `updated_at` can't tell *which* field changed last. The `field_meta JSONB` map (`{ "title": {"v":5,"updatedAt":"…"}, … }`) gives per-field LWW without a side table. The first cut may ship **row-level** LWW for non-`task` entities (simpler) and field-level only for `tasks`, where concurrent edits are most likely. Flagged as a tunable in [§20](#20-open-questions--risks).

### 6.2 Pull — `GET /api/v1/sync/pull?cursor=<opaque>&limit=500`

Returns every change visible to the user since `cursor`, across all entity types (own + shared), including tombstones.

```jsonc
{
  "changes": [
    { "entityType": "task", "entityId": "a3b4…", "op": "upsert", "version": 5,
      "payload": { /* full row */ }, "seq": "91432" },
    { "entityType": "task", "entityId": "9c10…", "op": "delete", "version": 3, "seq": "91440" }
  ],
  "nextCursor": "kFnAkQ==",          // base64(maxSeq); pass back next pull
  "hasMore": false                    // true ⇒ page again immediately
}
```

The cursor is opaque `base64(seq)`. A fresh client starts with no cursor → full snapshot (paged). The server caps `limit` at 500 and sets `hasMore` to drive paging. Because the cursor is a single monotonic `BIGSERIAL`, ordering is total and gap-free — no "missed a change" race.

> **Wire types.** `seq` and `committedSeq` are PostgreSQL `BIGSERIAL` (bigint) values sent as JSON **strings** (e.g. `"committedSeq": "91432"`) so they stay precise past `2^53`; the client decodes them as strings. The `cursor`/`nextCursor` is an opaque `base64(seq)` token, also a string. `version`, `serverVersion`, and `baseVersion` remain JSON numbers.

### 6.3 Idempotency & retries

- Every mutating request carries `Idempotency-Key` (the request) and each op carries `opId` (the unit of work). Retried flushes are safe.
- `SyncEngine` on the client uses exponential backoff with jitter; the server is stateless per request, so retries cost only a dedupe lookup.
- `idempotency_keys` rows are GC'd after 7 days (a retry older than that is implausible and would re-apply as a normal op).

### 6.4 Shared data & membership changes

- A change to a shared entity is written once with `visible_user_ids = owner + active members`, so it appears in **every** member's pull and realtime stream.
- **On join:** the new member's existing cursor predates the list's history. The `ShareService` enqueues a **backfill** job that emits the current snapshot of the shared list's entities into `change_log` scoped to the new `user_id` (or the client performs a one-time `GET /lists/{id}/snapshot`). Either way the member converges without a global re-sync.
- **On leave/revoke:** future changes drop the user from `visible_user_ids`; the client may keep a local read-only copy per product choice (AppSpec §5.8 edge cases).

### 6.5 Wall-clock, timezones, DST

Instants are UTC (AppSpec §5.1). All-day/floating items carry `floating:true` + `localDate` and are **not** shifted by zone. Anchored-time routines store wall-clock `anchor_time` and are materialized client-side against the local calendar (DST-correct) — the server never expands recurrences into instants, avoiding double-generation (see [§11](#11-background-jobs)).

---

## 7. REST Endpoint Surface

All under `/api/v1`, all authenticated unless noted. CRUD bodies use the same field names as the sync payloads. Most clients mutate through `sync/push`; the direct REST routes exist for simple operations, the future web client, and App Intents.

### 7.1 Auth & account
| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/apple` | Exchange Apple identity token → our tokens *(unauth)* |
| `POST` | `/auth/refresh` | Rotate access/refresh *(unauth, refresh token in body)* |
| `POST` | `/auth/logout` · `/auth/logout-all` | Revoke device / all devices |
| `POST` | `/auth/apple/notifications` | Apple server-to-server webhook (revocation/deletion) *(unauth, signed)* |
| `GET`  | `/me` · `PATCH` `/me` | Profile + settings (working hours, quiet hours, AI consent) |
| `POST` | `/account/export` | Kick off async data export → returns a job id; result is a signed download URL |
| `DELETE` | `/account` | Async account + data deletion (App Store requirement, GDPR) |

### 7.2 Sync
| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/sync/push` | Batch mutations (see [§6.1](#61-push--post-apiv1syncpush)) |
| `GET`  | `/sync/pull` | Deltas since cursor (see [§6.2](#62-pull--get-apiv1syncpullcursoropaquelimit500)) |
| `GET`  | `/lists/{id}/snapshot` | One-shot scoped snapshot (share backfill) |

### 7.3 Tasks, lists, tags
| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/tasks` · `GET/PATCH/DELETE` `/tasks/{id}` | CRUD; `GET` supports `?listId=&status=&due_before=&cursor=` |
| `POST` | `/tasks/{id}/complete` · `/tasks/{id}/reschedule` | Convenience ops (also expressible via patch) |
| `GET/POST` | `/lists` · `GET/PATCH/DELETE` `/lists/{id}` | Lists/projects |
| `GET/POST` | `/tags` · `PATCH/DELETE` `/tags/{id}` | Tags |

### 7.4 Routines & habits
| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/routines` · `GET/PATCH/DELETE` `/routines/{id}` | Routine + nested steps |
| `POST` | `/routines/{id}/steps` · `PATCH/DELETE` `/routines/{id}/steps/{stepId}` | Steps |
| `POST` | `/habits/{id}/log` | Record a completion (advances streak; server is authoritative for streak math across devices) |

### 7.5 Reminders, alarms, events
| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST/PATCH/DELETE` | `/reminders[/{id}]` | Reminder records (delivery is client-side) |
| `GET/POST/PATCH/DELETE` | `/alarms[/{id}]` | Alarm records |
| `GET/POST/PATCH/DELETE` | `/events[/{id}]` | App-native calendar events only |

### 7.6 Devices & push
| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/devices` | Register/refresh APNs token + push prefs |
| `PATCH/DELETE` | `/devices/{id}` | Update prefs / unregister |

### 7.7 Shares & collaboration
| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/lists/{id}/share` | Create a share for a list |
| `GET` | `/shares/{id}` · `DELETE` `/shares/{id}` | Inspect / stop sharing |
| `POST` | `/shares/{id}/invites` | Create an invite (link / email / contact); returns a tokenized link |
| `POST` | `/invites/{token}/accept` | Accept an invite → become a member *(auth required; token in path)* |
| `GET/PATCH/DELETE` | `/shares/{id}/members[/{memberId}]` | List / change role / remove |
| `POST` | `/tasks/{id}/assign` | Assign/reassign a task to a member (notifies) |
| `GET/POST` | `/tasks/{id}/comments` | Activity feed + comments; `@mentions` → notifications |
| `POST` | `/invites/{token}/report` | Abuse/report on a public invite link |

### 7.8 AI
See [§9](#9-ai-proxy-layer). `/ai/parse`, `/ai/schedule`, `/ai/brief`, `/ai/review`, `/ai/search`, `/ai/routine-suggest`.

### 7.9 Billing
| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/billing/receipt` | Submit a StoreKit 2 transaction for validation → entitlement |
| `GET`  | `/billing/status` | Current Pro entitlement state |
| `POST` | `/billing/notifications` | App Store Server Notifications V2 webhook *(unauth, signed JWS)* |

### 7.10 Health
| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` · `/ready` | Liveness / readiness (DB, Redis, APNs, Anthropic reachability) *(unauth)* |

---

## 8. Realtime (WebSocket)

Powers near-real-time collaboration on shared lists (AppSpec §5.8). **Option A** from the AppSpec (custom backend) is the chosen path.

- **Endpoint:** `wss://doit.app/api/v1/ws`. Auth on connect via `Sec-WebSocket-Protocol: bearer,<accessJWT>` (or a short-lived `?ticket=` minted by `POST /ws/ticket`, to avoid logging tokens in URLs). Reject unauthenticated sockets.
- **Subscriptions:** on connect the client is auto-subscribed to its **own user channel** (`user:{id}` — cross-device echo + server pushes) and may `subscribe` to **share channels** (`share:{id}`) it belongs to; the server authorizes each subscription against `share_members`.

**Message envelope** (both directions): `{ "type": …, "channel": …, "data": …, "id": … }`.

| `type` | Dir | Payload |
| --- | --- | --- |
| `sync.bump` | → client | `{ cursor }` — "there are changes ≥ this seq; pull them." The **authoritative** update path (keeps WS and REST from diverging) |
| `comment` | ↔ | New comment (inlined for low latency); also persisted + appears in next pull |
| `presence` | ↔ | member online/offline/typing within a share |
| `activity` | → client | assignment, role change, conflict notice |
| `ping`/`pong` | ↔ | heartbeat (server pings every 30 s; drops dead sockets) |

**Design rule.** The socket sends lightweight **nudges** (`sync.bump`) and small collaboration events (comments/presence). The durable, conflict-resolved truth always flows through `sync/pull`. This avoids two divergent code paths and means a missed socket message is harmless — the next pull is complete.

**Scaling on PaaS.** App instances are stateless and horizontally scaled; a change on instance A must reach a socket on instance B. The committer publishes to **Redis pub/sub** (`channel = share:{id}` / `user:{id}`); every instance subscribes and fans out to its local sockets. (Single-instance deployments can use Postgres `LISTEN/NOTIFY` to avoid the Redis dependency.) Sticky sessions are **not** required. Graceful shutdown drains sockets with a `reconnect` advisory.

**Fallback.** Clients that can't hold a socket (background, flaky network) fall back to **polling** `sync/pull` on an interval + on silent push (see [§10](#10-push-notifications-apns)) — exactly the AppSpec's "falls back to polling" path.

---

## 9. AI Proxy Layer

The server is the **only** place the Claude API key lives (AppSpec §5.10, §13). It proxies Claude with prompt caching, validates structured outputs, enforces consent, and meters cost. The client's on-device NaturalLanguage/Foundation-Models path is the offline fallback — the server is the cloud path.

### 9.1 Endpoints

| Endpoint | Capability | Model tier | Output |
| --- | --- | --- | --- |
| `POST /ai/parse` | NL quick-add → task fields (AppSpec §5.10.1) | fast | structured JSON (tool call) |
| `POST /ai/schedule` | Auto-schedule open tasks into free slots | mid + **solver** | proposed blocks |
| `POST /ai/brief` | Morning brief | mid | streamed text + highlights |
| `POST /ai/review` | Weekly review narrative | strong | streamed text + suggestions |
| `POST /ai/search` | NL query → structured filter | fast | a filter the client runs locally |
| `POST /ai/routine-suggest` | Detect repeated tasks → routine | mid | structured suggestion |

**Model selection** (tiers map to current Claude models — *verify IDs/pricing against current docs before launch*, per global rules):

| Tier | Model (as of this draft) | Used for |
| --- | --- | --- |
| fast | `claude-haiku-4-5` | parsing, NL→filter — latency-sensitive, cheap |
| mid | `claude-sonnet-4-6` | scheduling intent, brief, routine discovery |
| strong | `claude-opus-4-8` *(or sonnet under budget)* | weekly narrative review |

### 9.2 Structured outputs

Every data-producing endpoint forces a **tool call** with a JSON-Schema `input_schema` and `tool_choice: { type: "tool", name }`. The returned `input` is validated with the **same Zod schema**; on mismatch the server **re-prompts once** with the validation error, then fails closed (client falls back to manual/on-device). Example — quick-add:

```ts
const ParsedTask = z.object({
  title: z.string(),
  start: z.string().datetime().nullable(),
  durationMinutes: z.number().int().positive().nullable(),
  due: z.string().datetime().nullable(),
  priority: z.enum(["none","p4","p3","p2","p1"]),
  tags: z.array(z.string()),
  listHint: z.string().nullable(),
});
// → Anthropic tool input_schema generated from this; response.input re-validated by it.
```

The user **always previews** parsed fields before anything writes (AppSpec §5.10 "human-in-the-loop"). AI never writes the data layer directly — it returns a proposal; the client confirms and the write goes through normal `sync/push`.

### 9.3 Auto-scheduling: AI ranks, a solver places

Per AppSpec §5.10.2 the **deterministic constraint solver** (framework-free, unit-tested) does placement; AI only ranks/interprets intent ("mornings for deep work"). `/ai/schedule` therefore: (1) optionally calls the model to produce a ranking/intent vector over the open tasks; (2) runs the solver server-side against free slots + working hours + buffers + deadlines; (3) returns proposed blocks with reasons, including a "couldn't schedule" list. Deterministic placement keeps results explainable and testable, and lets the whole feature degrade to a pure rules-based plan when AI is off.

### 9.4 Prompt caching

To control cost and latency (AppSpec §5.10), cache the stable prefix and vary only the tail:

- **Cache breakpoints** (`cache_control: { type: "ephemeral" }`) on, in order: **tool definitions** → **system prompt** → **stable user context** (lists, tags, working hours, preferences — changes rarely). The volatile request data (today's open tasks, the NL string) comes **after** the last breakpoint and is never cached.
- Cache reads bill at a small fraction of base input tokens; the 5-minute TTL covers a planning session. Use the 1-hour TTL for the per-user stable-context block when warranted.
- Record `cache_read_tokens` in `ai_usage` to verify hit rates.

### 9.5 Streaming

`/ai/brief` and `/ai/review` stream tokens to the client over **SSE** (`text/event-stream`) so narrative appears progressively; a trailing event carries the structured highlights/suggestions.

### 9.6 Consent, privacy, cost control

- **Opt-in gate:** every AI endpoint checks `users.ai_consent`; absent ⇒ `403 ai_consent_required`. The request must carry only consented context; the server logs **what categories** were sent (metadata, not content) so the app can "show exactly what's sent" (AppSpec §5.10, §13).
- **No training** on user data (Anthropic default + stated policy). A **local-only mode** uses no cloud at all (client on-device parse only).
- **Budgets:** per-user monthly token budget (Pro tier higher); over-budget ⇒ `429 ai_budget_exceeded` and the client falls back to on-device/rules. Per-endpoint rate limits, request timeouts (e.g., 20 s), and retry-with-backoff on transient Anthropic errors. Optional model downgrade under sustained load.
- **Graceful degradation** is mandatory: no network / AI off / over budget ⇒ manual entry + rules-based scheduler still work (AppSpec §5.10).

---

## 10. Push Notifications (APNs)

The client schedules its own **local** notifications and alarms (AppSpec §5.6–§5.7, §10) and owns the 64-notification cap. The **server** drives only pushes the client can't originate:

- **Collaboration:** invite accepted, task assigned/reassigned, new comment, `@mention`, role change.
- **Smart reminders / digests** (AI): a better-timed nudge or a bundled low-priority digest (AppSpec §5.7).
- **Silent sync wake:** `content-available: 1` background push when a shared entity changes, nudging the app to `sync/pull` so other members converge while backgrounded.

**Transport:** APNs over HTTP/2 with **token-based auth** (`.p8` AuthKey, ES256 JWT, `apns-topic = <bundle id>`). Headers set `apns-push-type` (`alert` | `background`), `apns-priority`, and `apns-collapse-id` (so a digest replaces rather than stacks). Map product intent to payload `interruption-level` (`passive`/`active`/`time-sensitive`); **critical** alerts require the special entitlement and are gated (AppSpec §5.6 caveat — verify entitlement before promising). Invalid-token responses (410) prune `devices.apns_token`.

**Quiet hours & prefs** from `users.settings` / `devices.push_prefs` are honored server-side before sending (AppSpec §5.7).

---

## 11. Background Jobs

**BullMQ** queues on Redis; every worker is **idempotent and retry-safe** with backoff (global rule). Jobs:

| Job | Trigger | Idempotency |
| --- | --- | --- |
| `share.notify` | share/assign/comment/mention events | keyed by event id |
| `push.silent-sync` | shared entity changed | collapse-id per (user, list) |
| `ai.digest` | schedule / threshold | one digest per (user, window) |
| `share.backfill` | member joins | scoped snapshot; safe to re-run |
| `account.export` | `POST /account/export` | job id; result cached |
| `account.delete` | `DELETE /account` | staged purge, resumable |
| `billing.refresh` | App Store notification / cron | upsert by `original_transaction_id` |
| `gc.tombstones` | nightly cron | purge `deleted_at` + `change_log` older than retention; advance floor cursor |
| `gc.idempotency` | nightly cron | delete `idempotency_keys` > 7 days |

> **Routine materialization stays on the client** (AppSpec §5.2, `BGTaskScheduler`). The server does **not** expand recurrences into task instances — doing so on both sides would double-generate. The server stores routine templates and may, for **shared** routines, emit a single authoritative materialization in a later phase; the first release keeps it client-owned. Flagged in [§20](#20-open-questions--risks).

---

## 12. Billing & Entitlements

- **StoreKit 2** on the client; the server **validates** transactions and is the source of truth for the Pro entitlement (AppSpec §17).
- `POST /billing/receipt` verifies a signed transaction via the **App Store Server API** (JWS verified against Apple root certs) and upserts `subscriptions`.
- `POST /billing/notifications` receives **App Store Server Notifications V2** (renewals, refunds, expirations, billing retries) to keep entitlement current without polling.
- `GET /billing/status` returns the entitlement the client gates features on. A single server-side entitlement check authorizes Pro-only API behavior (e.g., higher AI budgets, sharing); the app mirrors it via its `Entitlements` service.

---

## 13. Versioning & Schema Evolution

Greenfield surface — there is no prior API or external data store to preserve. The contract is versioned from day one and evolves additively.

- **Single surface.** Everything lives under `/api/v1`. There is no legacy/compatibility layer to carry.
- **Additive by default.** New fields are introduced nullable/defaulted so an older app build keeps working against a newer server (forward compatibility); clients ignore fields they don't know. This is the same nullable-additive discipline the app uses for its own model growth (AppSpec §6).
- **Breaking changes** (removing/renaming a field, changing a type or status code, tightening validation) ship only under a new major version `/api/v2`, announced with a deprecation window; both majors run side by side until clients migrate. Check downstream app usage before any such change (global contract-stability rule).
- **Capability negotiation.** Clients send `X-Client-Version`; the server can soft-gate behavior and return a `426`/advisory when a minimum build is required for a feature.

**Schema migrations** run as a gated release step (`drizzle-kit migrate`) before new app code goes live. Because a migration is applied while the *previous* app build is still in the field, each must be backward-compatible — follow **expand → migrate → contract** (add new nullable columns, backfill, switch reads/writes, drop the old column a release later), with an explicit, tested down path for the current release window. State the migration + rollback in each PR (global rule).

---

## 14. Security & Privacy

Mirrors AppSpec §13 from the server side:

- **AuthZ on every call;** ownership + role checks server-side, never trusting the client. **PostgreSQL RLS** as a backstop. Cross-tenant requests return `404`.
- **Input validation** (Zod) at every boundary; parameterized queries only (Drizzle) — no string-built SQL.
- **Secrets** (Apple keys, APNs `.p8`, Anthropic key, JWT signing keys, DB/Redis URLs) live in the **PaaS secret store**, never in the repo or logs. JWT signing keys rotate; old keys stay in the JWKS until their tokens expire.
- **TLS only** (PaaS-terminated). HSTS. No sensitive data in query strings (WS uses a ticket, not a token-in-URL).
- **Rate limiting & abuse:** per-user/IP buckets; public **invite links** are tokenized, **expirable**, revocable, and reportable (`/invites/{token}/report`) (AppSpec §5.8 edge cases).
- **AI privacy:** explicit opt-in; log categories-sent not content; no training; local-only mode (AppSpec §5.10, §13).
- **Compliance:** `POST /account/export` (machine-readable export) and `DELETE /account` (full async purge incl. `change_log`, AI usage, tokens), plus Apple's server-to-server account-deletion notifications — App Store requirement + GDPR.
- **Audit:** share/permission/role changes and conflict resolutions are recorded in `activity` (immutable feed).
- **Privacy manifest alignment:** the data types the server collects must match the app's `PrivacyInfo.xcprivacy` and the App Store nutrition label (AppSpec §13) — keep them in lockstep.

---

## 15. Observability

- **Logging:** `pino` structured JSON; a request-scoped child logger carries `requestId`, `userId`, route, latency. **No PII or tokens** in logs.
- **Metrics & tracing:** OpenTelemetry — RED metrics per route, sync push/pull latency + conflict rate, WS connection count + fan-out lag, AI tokens/cost/cache-hit-rate, queue depth + job failure rate. Export to the PaaS metrics backend.
- **Errors:** Sentry with release tagging and source maps; alert on error-rate and saturation SLO burn.
- **Health:** `/health` (liveness) and `/ready` (checks DB, Redis, APNs token mint, Anthropic reachability) for the platform's health probes.
- **Audit/usage dashboards:** AI spend per user/day (budget guard), sync conflict trends, push delivery/failure.

---

## 16. Infrastructure & Deployment

**Target: managed PaaS** (Fly.io / Railway / Render — portable; pick one). The app is a stateless container scaled to N instances.

| Component | Provision |
| --- | --- |
| **App** | Container from the repo `Dockerfile`; N instances behind the platform LB; health checks → `/ready`; graceful shutdown drains WS |
| **PostgreSQL 16** | Managed instance (platform Postgres / Neon / Supabase); automated backups + PITR; tested restores |
| **Redis** | Managed add-on (pub/sub for WS fan-out, BullMQ queues, rate-limit buckets) |
| **Secrets** | Platform secret manager (§14) |
| **TLS/CDN** | Platform-managed certs; HTTP/2 |

- **WebSocket scaling:** horizontal via Redis pub/sub; **no sticky sessions** needed. Ensure the platform supports long-lived WS and adequate idle timeouts.
- **Migrations:** run `drizzle-kit migrate` as a pre-deploy release command, gated in CI; forward-only with a tested rollback window (§13).
- **Config:** 12-factor; a Zod-validated env schema fails fast at boot if anything is missing/malformed.
- **CI/CD:** GitHub Actions → typecheck + lint + unit + integration (Testcontainers Postgres) → build image → deploy on green to `main`; preview environments per PR where the platform supports them.
- **Backups/DR:** automated PG backups + PITR; periodic restore drills; documented RTO/RPO.
- **Scaling knobs:** app instances stateless (scale on CPU/conns); Postgres connection pooling (PgBouncer/platform pooler) since serverless-ish instances multiply connections; Redis sized for pub/sub + queues.

---

## 17. Project Structure

```
DoItAi-api/
├─ src/
│  ├─ index.ts              # bootstrap Fastify, plugins, graceful shutdown
│  ├─ config/               # zod env schema, app constants
│  ├─ db/                   # drizzle schema, client, RLS policies
│  ├─ auth/                 # apple verify, jwt sign/verify, refresh rotation, middleware
│  ├─ modules/              # feature modules: routes + service + repository
│  │  ├─ tasks/  lists/  tags/  routines/  reminders/  alarms/  events/
│  │  ├─ shares/  comments/
│  │  ├─ sync/              # push/pull, change_log, conflict resolver (pure core)
│  │  ├─ ai/                # claude proxy, tool/Zod schemas, prompts, caching, solver
│  │  ├─ devices/           # apns token registration
│  │  ├─ account/           # export, delete
│  │  └─ billing/           # storekit verify + notifications
│  ├─ realtime/             # ws server, channels, presence, redis pub/sub
│  ├─ jobs/                 # bullmq queues + workers
│  ├─ push/                 # apns http/2 client
│  ├─ lib/                  # errors, pagination, idempotency, clock, logging
│  └─ openapi/              # zod→openapi; served at /api/v1/openapi.json
├─ drizzle/                 # generated migrations
├─ test/                    # vitest, supertest, testcontainers
├─ Dockerfile
├─ fly.toml | railway.json | render.yaml
└─ package.json
```

- **Pure cores** (conflict resolver, scheduler constraint solver, cursor codec, recurrence-free helpers) are framework-free and unit-tested in isolation — mirroring the AppSpec's "pure logic cores" principle (§7).
- A **deterministic clock** is injected everywhere time matters (no direct `new Date()` in logic) — keeps sync/conflict tests reproducible (AppSpec §16).

---

## 18. Testing Strategy

| Layer | What | How |
| --- | --- | --- |
| **Unit** | Conflict resolver (field-level LWW, structural), cursor codec, Apple-token verification, scheduler solver, Zod/AI schema mapping | Vitest on pure cores; property-based for the resolver |
| **Integration** | Sync push/pull/conflict against **real Postgres**, auth + refresh rotation/reuse detection, share authz matrix, RLS isolation, WS subscribe/fan-out | Vitest + supertest + **Testcontainers**; deterministic clock |
| **Contract** | API DTOs match the app's models; responses stay backward-compatible as the schema grows | Generated OpenAPI + golden response fixtures |
| **AI** | Structured-output schema validation, re-prompt on mismatch, golden NL-parse cases | Golden tests against fixed prompts; mock Anthropic at the SDK boundary |
| **Security** | AuthZ denial paths, cross-tenant 404s, RLS, rate limits, invite expiry/revocation | Targeted integration tests |
| **Load** | Sync throughput, WS fan-out under N members, AI budget enforcement | k6/Artillery against a staging deploy |

CI gates merges on unit + integration green. A nightly job runs load + restore drills.

---

## 19. Roadmap & Milestones

Sequenced to unblock each app phase (AppSpec §15). Each phase ships something the app can build against.

- **Phase 0 — Foundation & auth.** Repo scaffold, env/secrets, Postgres schema + migrations, **Sign in with Apple** + token model, RLS, deploy pipeline, observability baseline. *(Unblocks app Phase 0–1.)*
- **Phase 1 — Tasks core + sync.** Tasks/lists/tags/checklists CRUD, **`sync/push` + `sync/pull`** with idempotency and row-level conflict, device registration + silent-sync push. *(Unblocks app Phase 1 MVP + agenda widget.)*
- **Phase 2 — Scheduling fields + events.** Serve the richer scheduling fields the sectograph/planner read (no new server views — they're client-rendered), app-native `events`, field-level conflict for `tasks`. *(Unblocks app Phase 2.)*
- **Phase 3 — Routines, alarms, reminders.** Routine/step/alarm/reminder persistence + sync; habit/streak server math; location-reminder storage. *(Unblocks app Phase 3.)*
- **Phase 4 — AI proxy.** `/ai/*` endpoints, prompt caching, structured-output validation + re-prompt, consent gate, budgets/rate limits, streaming brief/review, server-side solver. *(Unblocks app Phase 4.)*
- **Phase 5 — Sharing & realtime.** Shares/members/roles, invites + accept + report, comments/@mentions, **WebSocket + Redis pub/sub**, push fan-out, share backfill, sharing analytics, **authZ hardening**. *(Unblocks app Phase 5.)*
- **Phase 6 — Billing, compliance, hardening.** StoreKit validation + notifications + entitlements, account export/delete + Apple deletion webhook, load testing, tombstone/idempotency GC, OpenAPI publish, SLO alerting. *(Unblocks app Phase 6 / App Store prep.)*

---

## 20. Open Questions & Risks

| # | Question / Risk | Notes |
| --- | --- | --- |
| 1 | **Conflict granularity** | Ship row-level LWW everywhere first, field-level (`field_meta`) for `tasks` only? Or field-level across the board from day one? Cost vs. correctness. ([§6.1](#61-push--post-apiv1syncpush)) |
| 2 | **Share backfill on join** | Synthetic `change_log` fan-out vs. client one-shot `/snapshot`. Pick one to avoid double-convergence. ([§6.4](#64-shared-data--membership-changes)) |
| 3 | **Routine materialization ownership** | Keep 100% client-side (risk: shared-routine notifications) vs. server-authoritative for shared routines (risk: double-generation). Decide before Phase 5. ([§11](#11-background-jobs)) |
| 4 | **WS cost on PaaS** | Long-lived connections + Redis pub/sub pricing at scale; idle-timeout limits per platform. ([§8](#8-realtime-websocket), [§16](#16-infrastructure--deployment)) |
| 5 | **AI budget model** | Per-user monthly token ceilings + Pro multiplier — tune to keep Claude spend bounded without throttling real use. ([§9.6](#96-consent-privacy--cost-control)) |
| 6 | **change_log growth/retention** | Retention window + compaction; floor-cursor handling so a long-offline client re-syncs cleanly rather than missing GC'd deltas. ([§6.2](#62-pull--get-apiv1syncpullcursoropaquelimit500), [§11](#11-background-jobs)) |
| 7 | **Model IDs / pricing drift** | Verify current Claude model IDs, pricing, and caching limits before launch (global rule). ([§9.1](#91-endpoints)) |
| 8 | **Critical-alert entitlement** | Server can drive pushes, but Critical interruption level needs the app entitlement; confirm before promising in product. ([§10](#10-push-notifications-apns)) |

---

## 21. Appendix — Error Codes & Examples

**Machine-readable `error.code` enum**

| code | HTTP | Meaning |
| --- | --- | --- |
| `validation_error` | 400 | Body/query failed schema; see `details.fieldErrors` |
| `unauthenticated` | 401 | Missing/expired access token |
| `forbidden` | 403 | Authenticated but lacks ownership/role |
| `not_found` | 404 | Unknown id or not visible to caller |
| `conflict` | 409 | Version/structural sync conflict |
| `gone` | 410 | Invite/link expired or revoked |
| `ai_consent_required` | 403 | AI called without opt-in |
| `ai_budget_exceeded` | 429 | Over the user's AI token budget |
| `rate_limited` | 429 | Bucket exhausted; see `Retry-After` |
| `internal` | 500 | Unhandled server error (`requestId` for tracing) |

**Quick-add round trip**

```http
POST /api/v1/ai/parse
Authorization: Bearer <jwt>
Idempotency-Key: 6b1c…

{ "text": "lunch w/ Sam tmrw 1pm 1h #work !!", "now": "2026-06-03T09:00:00Z", "tz": "America/Chicago" }
```
```jsonc
{
  "parsed": {
    "title": "lunch with Sam",
    "start": "2026-06-04T18:00:00Z",   // 1pm local → UTC
    "durationMinutes": 60,
    "due": null,
    "priority": "p2",                  // "!!" → P2
    "tags": ["work"],
    "listHint": null
  },
  "confidence": 0.93
}
```
The client previews these fields; on confirm it creates the task locally and flushes via `POST /sync/push` (entity id minted client-side).

**Sync conflict (merged) example**

```jsonc
// push result for a task two devices edited
{
  "opId": "f1e2…", "entityId": "a3b4…", "status": "merged", "serverVersion": 9,
  "serverFields": { "title": "Lunch with Samir" },  // server kept a newer title…
  "committedSeq": "91710"                            // …client kept its newer scheduledStart
}
```

---

*End of spec. This is a living document — bump the version and date on substantive changes, and keep it in lockstep with `DoIT-AppSpec.md`.*
