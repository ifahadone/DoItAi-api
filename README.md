# DoIT API — `DoItAi-api`

The backend for **DoIT**, an AI-native, offline-first productivity app. This repo
is the engineering counterpart to `DoIT-ApiSpec.md` (authoritative) and
`../DoIT-DevelopmentPlan.md` (§4, Phase 0).

> **This is the Phase 0 walking skeleton.** It proves the core loop end-to-end —
> Sign in with Apple → our JWT/refresh → offline **sync** (push/pull with
> idempotency, row-level conflict, and a `change_log` cursor) — on the thinnest
> runnable slice. Features come in later phases.

**Stack:** Node.js 22 (ESM, strict TS) · Fastify 5 · PostgreSQL 16 via Drizzle
ORM (drizzle-kit migrations) · Zod · jose · pino. `ioredis` is wired into config
for later phases — **Phase 0 boots without Redis.**

---

## What's implemented

| Area | Status | Notes |
| --- | --- | --- |
| Typed env config | ✅ | `src/config/env.ts` — Zod-validated, fail-fast at boot. |
| DB schema + migration | ✅ | `src/db/schema.ts` (Drizzle) + `drizzle/0000_init.sql`. Tables: `users, devices, refresh_tokens, task_lists, tags, tasks, task_tags, change_log` (GIN on `visible_user_ids`), `idempotency_keys`. |
| The contract (single source of truth) | ✅ | `src/contract/schemas.ts` — Zod for `Task`/`TaskList`/`Tag` + auth + sync envelopes; integer enums; RFC3339 timestamps. Drives validation **and** OpenAPI. |
| Sign in with Apple | ✅ (code) | `src/auth/apple.ts` verifies the Apple identity JWT against Apple JWKS (sig, iss, aud, exp, nonce) via `jose`. JWKS fetch happens at request time. Dev stub toggle for non-prod. |
| Our token model | ✅ | `src/auth/tokens.ts` — ES256 access JWT (15 min; `sub`/`did`), opaque rotating refresh (SHA-256 hash stored; single-use; **reuse ⇒ revoke family**). |
| Auth middleware + routes | ✅ | `src/auth/middleware.ts`, `src/auth/routes.ts` — `POST /auth/apple`, `/auth/refresh`, `/auth/logout`. |
| Sync conflict resolver (pure) | ✅ | `src/modules/sync/conflict.ts` — framework-free **row-level LWW**: applied / merged (serverFields on server-win) / structural delete-wins conflict. Unit-tested. |
| Sync push/pull | ✅ | `src/modules/sync/{service,repository}.ts` — per-op idempotency, ownership authz, conflict apply, `server_version` bump, `change_log` append; pull by base64(seq) cursor with `hasMore` paging. |
| Tasks CRUD (worked example) | ✅ | `src/modules/tasks/*` — reads direct; **writes flow through the sync engine** (no out-of-band writes). |
| Lists / Tags routes (light) | ✅ | `src/modules/lists/routes.ts`, `src/modules/tags/routes.ts`. |
| OpenAPI 3.1 | ✅ | `src/openapi/openapi.ts` generated from the Zod contract; served at `GET /api/v1/openapi.json`. |
| App wiring + health | ✅ | `src/app.ts` (error envelope, request id, auth scoping, `/health`, `/ready`) + `src/index.ts` (graceful shutdown). |
| Injected Clock | ✅ | `src/lib/clock.ts` — no `new Date()` in business logic; `FixedClock` for deterministic tests. |
| Tests | ✅ (authored) | `test/sync.conflict.test.ts`, `test/contract.test.ts`. **Not executed here** (no `node_modules` — see "Honesty"). |
| Docker / Compose / CI / fly.toml | ✅ | Multi-stage `Dockerfile`, local `docker-compose.yml` (pg16 + redis7), `.github/workflows/ci.yml` (typecheck + test + build), example `fly.toml`. |

### What's stubbed / deferred (by design, Phase 0 scope)

- **Apple `authorizationCode` exchange** at `appleid.apple.com/auth/token` and the
  server-to-server **revocation/deletion webhook** (ApiSpec §4.1 step 4) — not in
  Phase 0. Only identity-token verification + our token issuance are implemented.
- **Field-level LWW with `field_meta`** (ApiSpec §6.1) — Phase 0 ships **row-level**
  LWW (the simpler tunable, ApiSpec §20.1). The `tasks.field_meta` column and the
  resolver's `fieldMeta` parameter already exist so Phase 2 can light it up with no
  migration.
- **Shares / collaboration** — `change_log.visible_user_ids` is populated with the
  owner only; share fan-out is Phase 5.
- **Redis, WebSocket, BullMQ jobs, AI proxy, APNs push, billing** — later phases.
  `REDIS_URL` is optional and unused at runtime in Phase 0.
- **Postgres RLS** — the `withUser()` seam in `src/db/client.ts` issues
  `SET app.user_id` per transaction, but RLS **policies are not yet created**.
  Application-level ownership checks are the Phase 0 gate.
- **`@anthropic-ai/sdk`** is listed as a dependency for Phase 4 but not imported.

---

## Real secrets / credentials YOU must provide

Copy `.env.example` → `.env` and fill these. Everything in `.env.example` is a
placeholder. In production these come from the **PaaS secret store**, never the repo.

| Var | Required for | How to get it |
| --- | --- | --- |
| `DATABASE_URL` | everything | Local: the `docker-compose` Postgres (`postgres://doit:doit@localhost:5432/doit`). Prod: managed PG. |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | issuing/verifying our JWTs | Generate an **ES256** (P-256) PEM pair — see commands below. |
| `APPLE_BUNDLE_ID` | verifying Apple tokens (`aud`) | Your app's bundle id from Apple Developer. |
| `ANTHROPIC_API_KEY` | Phase 4 AI (not used in Phase 0) | Anthropic console. Leave placeholder for now. |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_AUTH_KEY` | Phase 1+ push (not used in Phase 0) | Apple `.p8` AuthKey. Leave placeholder for now. |
| `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_CLIENT_SECRET_PRIVATE_KEY` | Apple code-exchange (deferred) | Apple Developer. Optional in Phase 0. |
| `REDIS_URL` | Phase 1+ | Leave **blank** in Phase 0 (the app boots without Redis). |

`APPLE_STUB_VERIFICATION=true` (only when `NODE_ENV != production`) lets you test
the sign-in flow without Apple: the identity token is decoded but **not** verified
and its `sub` is trusted. The env loader **refuses** this in production.

**Generate an ES256 JWT key pair:**

```bash
openssl ecparam -genkey -name prime256v1 -noout -out ec_private.pem
openssl pkcs8 -topk8 -nocrypt -in ec_private.pem -out jwt_private_pkcs8.pem
openssl ec -in ec_private.pem -pubout -out jwt_public.pem
# Paste each PEM into .env (newlines may be escaped as \n on one line; the loader un-escapes).
```

---

## Quickstart — install → migrate → run → test

> Requires **Node 22+** and Docker (for local Postgres). No network/`npm install`
> was run while scaffolding this repo — these are the steps **you** run.

```bash
# 0) from repo root: DoItAi-api/
cp .env.example .env            # then fill JWT_* and APPLE_BUNDLE_ID at minimum

# 1) install dependencies
npm install

# 2) start local Postgres (+ Redis, unused in Phase 0)
docker compose up -d

# 3) apply migrations
npm run db:migrate              # applies drizzle/0000_init.sql

# 4) run the API (hot reload)
npm run dev                     # listens on http://localhost:3000

# 5) typecheck + tests
npm run typecheck
npm test
```

Build & run the production bundle:

```bash
npm run build                   # tsc -> dist/
npm start                       # node --import ./loader.mjs dist/index.js
```

Smoke-test once running:

```bash
curl localhost:3000/health                 # {"status":"ok"}
curl localhost:3000/ready                   # db check; 200 when reachable
curl localhost:3000/api/v1/openapi.json     # generated OpenAPI 3.1
```

### Regenerating the migration

`drizzle/0000_init.sql` was **hand-authored** to mirror `src/db/schema.ts` (the
generator needs deps the scaffold run didn't have). After `npm install`, you can
regenerate against the schema:

```bash
npm run db:generate             # diffs schema.ts; should be a no-op vs 0000 on a fresh DB
```

If `db:generate` emits a follow-up migration, review it — it indicates a drift
between the hand-written SQL and the Drizzle schema that should be reconciled.

---

## Path alias / runtime resolution

`@/*` → `src/*` is configured in `tsconfig.json` (`paths`). Resolution per runtime:

- **`npm run dev`** (`tsx`) and **`npm test`** (`vitest`, alias in `vitest.config.ts`)
  resolve `@/` natively.
- **`npm start`** runs the compiled `dist/` with `node --import ./loader.mjs`.
  `loader.mjs` is a tiny ESM resolver hook that rewrites a leading `@/` to the
  matching file under `dist/` — **no extra dependency** (no `tsc-alias`).

---

## Project layout (Phase 0 subset)

```
src/
  index.ts            bootstrap + graceful shutdown
  app.ts              buildApp: plugins, error envelope, auth scoping, /health, /ready, OpenAPI
  config/env.ts       Zod-validated env (fail-fast)
  lib/                errors, logger, clock, ids (+ cursor codec), validate
  db/                 client (pool, withUser seam), schema (Drizzle)
  contract/schemas.ts THE contract — Zod single source of truth
  auth/               apple (JWKS verify), tokens (JWT + refresh rotation), middleware, service, repository, routes
  modules/
    sync/             conflict (pure), service, repository, mapping, restBridge, routes
    tasks/            repository, service, routes (worked CRUD example)
    lists/  tags/     light routes
  openapi/openapi.ts  zod -> OpenAPI 3.1
drizzle/              0000_init.sql + meta/_journal.json
test/                 sync.conflict.test.ts, contract.test.ts
```

## API surface (Phase 0)

All under `/api/v1`. Auth required on everything except `/auth/*`, `/health`,
`/ready`, and `/openapi.json`.

- `POST /auth/apple` · `POST /auth/refresh` · `POST /auth/logout`
- `POST /sync/push` · `GET /sync/pull?cursor=&limit=`
- `GET/POST /tasks` · `GET/PATCH/DELETE /tasks/{id}`
- `GET/POST /lists` · `GET/PATCH/DELETE /lists/{id}`
- `GET/POST /tags` · `PATCH/DELETE /tags/{id}`
- `GET /health` · `GET /ready` · `GET /openapi.json`

Errors use the typed envelope `{ error: { code, message, details?, requestId } }`
with the `code` enum from ApiSpec §21.

## Deployment

`fly.toml` is an example for **Fly.io** (stateless container; `release_command`
runs `drizzle-kit migrate` before traffic; health check on `/ready`). Set your app
name/region and load secrets with `fly secrets set …` (never commit them).

**Render alternative:** add a `render.yaml` with a `web` service `env: docker`
(this `Dockerfile`), a managed PostgreSQL, a health check path `/ready`, and a
pre-deploy/`buildCommand` step running `npm run db:migrate`. Provide the same env
vars via Render's dashboard/secret files.

## Honesty / not verified

- **`tsc`, `vitest`, `drizzle-kit`, `docker`, `npm install` were NOT run** while
  building this scaffold — there is no `node_modules` and no network in the
  authoring environment. Dependency versions in `package.json` are stated, not
  installed/locked; there is **no `package-lock.json` yet** (created by your first
  `npm install`).
- The two test files are authored to be correct but are **unexecuted** here. Run
  `npm test` after `npm install` to confirm.
- `drizzle/meta/_journal.json` is provided so `drizzle-kit migrate` recognizes
  `0000_init`. The drizzle **snapshot** (`meta/0000_snapshot.json`, used only by
  `generate` for diffing) is intentionally omitted — it is regenerated on your
  first `npm run db:generate`.
```
