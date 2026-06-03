# IUA/SMART Validator — Agent Guide

This file provides guidance to AI coding agents working in this repository.

## Project Overview

Standalone field-validation service for the **IHE Connectathon Taiwan 2026 Track #3**.
Reads HTTP traffic captured by Prism Proxy (read-only), classifies each connection into an OAuth/SMART flow step, checks required fields, and writes results to its own PostgreSQL database.

```
Prism PostgreSQL  ──(read-only)──▶  Validator Service  ──(write)──▶  Validator PostgreSQL
```

No coupling to Prism's application code — only the Prism DB is accessed.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 (Alpine) |
| Framework | Fastify 4 |
| Language | TypeScript 5 (strict, CommonJS) |
| ORM | Prisma 5 (validator DB only) |
| Prism DB access | pg (raw Pool, read-only) |
| UI | Plain HTML + Tailwind CSS CDN (dark mode via `class`) |

---

## Repository Layout

```
validator/
├── compose.yml              Docker Compose (nginx + validator + postgres)
├── Dockerfile               Multi-stage build
├── entrypoint.sh            prisma db push → node dist/api.js
├── nginx.conf               Template: /api/* → validator:${API_PORT}, /* → static UI
│                            Processed by envsubst at nginx startup (not used directly)
├── .env                     Local environment variables (copy from .env.example)
├── .env.example             All supported env vars with defaults
├── prisma/schema.prisma     Validator DB schema
├── tests/
│   └── test-fixtures.json   Fixture test cases (run via POST /test/run)
└── src/
    ├── types.ts             Shared TypeScript interfaces (PrismConnection, ValidationOutput, etc.)
    ├── core.ts              validateConnection() + validateAndSave()
    ├── router.ts            Flow classifier (priority-ordered rule matching from DB cache)
    ├── checker.ts           Field checker (query_params / body_params / headers / response_body)
    ├── writer.ts            Saves ValidationResult rows + upserts ProcessedConnection
    ├── rules-db.ts          DB-backed rules CRUD; seeds defaults on first run;
    │                        every write also calls touchRulesUpdatedAt()
    ├── settings.ts          ValidatorSetting CRUD (prism DB URL, polling, baseUrl,
    │                        rulesUpdatedAt); touchRulesUpdatedAt() clears processed_connections
    ├── poller.ts            Background polling job; skips already-processed IDs
    ├── tester.ts            In-memory fixture runner (no DB required)
    ├── api.ts               Fastify server, session auth, all REST endpoints;
    │                        owns revalidateState + revalidateAllExisting()
    ├── db/
    │   ├── prism.ts         Read-only pg Pool; getRecentConnections, getConnectionById,
    │   │                    getConnectionIdByShareToken, getBackendServers, getServerName (60s cache)
    │   └── validator.ts     Prisma client singleton (VALIDATOR_DATABASE_URL)
    └── ui/
        ├── ui.js            Shared nav render, dark mode toggle (localStorage), escapeHtml/escapeAttr globals
        ├── login.html       Session login
        ├── dashboard.html   Polling status + today's stats
        ├── results.html     Filterable results table (infinite scroll, ShareToken priority filter,
        │                    stale indicator ⚠, copy + Inspect buttons per row)
        ├── rules.html       Flow identifier + field rule management (CRUD)
        ├── settings.html    Prism DB connection, polling config, base URL settings
        ├── validate.html    "Connection Inspect": on-demand validate by connectionId or shareToken;
        │                    hot-update, shows Overall PASS/FAIL X/Y
        └── test.html        Fixture runner UI
```

---

## Commands

```bash
# Install dependencies
npm install

# Development (hot reload)
npm run dev

# Build
npm run build

# Docker (rebuild + restart)
docker compose build validator
docker compose up -d validator

# One-liner
docker compose build validator 2>&1 | tail -8 && docker compose up -d validator 2>&1 | tail -4
```

---

## Environment Variables

All variables are defined in `.env` (copy from `.env.example`).

| Variable | Default | Description |
|---|---|---|
| `PRISM_DATABASE_URL` | — | **Required.** Full PostgreSQL URL for Prism DB (read-only) |
| `VALIDATOR_DB_HOST` | `postgres` | Hostname of validator postgres (Docker service name) |
| `VALIDATOR_DB_PORT` | `5432` | Port postgres listens on; propagated to `PGPORT` inside the postgres container |
| `VALIDATOR_DB_USER` | `validator` | PostgreSQL username |
| `VALIDATOR_DB_NAME` | `validator` | PostgreSQL database name |
| `VALIDATOR_DB_PASSWORD` | — | **Required.** PostgreSQL password |
| `FRONTEND_PORT` | `80` | Host-side port mapped to nginx (container always listens on 80) |
| `API_PORT` | `3000` | Port the Fastify API listens on inside the validator container; also substituted into nginx.conf via envsubst |
| `ADMIN_USER` | `admin` | UI login username |
| `ADMIN_PASS` | `admin123` | UI login password |

`VALIDATOR_DATABASE_URL` is assembled in `compose.yml` from the five `VALIDATOR_DB_*` vars — do not set it manually.

---

## Validator DB Schema

| Table | Purpose |
|---|---|
| `validation_results` | One row per field per connection; includes `server_id`, `server_name`, `flow_step`, `status`, `detail`, `validated_at` |
| `processed_connections` | Tracks which connection IDs have been validated (deduplicated by poller) |
| `flow_identifiers` | Defines how to classify a connection into a flow step (method, URL pattern, body grant type, priority) |
| `flow_rule_fields` | One row per field rule (field name, location, type, optional regex pattern, sort order) |
| `validator_settings` | Singleton row (id=1): Prism DB URL + verified status, polling config, base URL, `rules_updated_at` |

`prisma db push` runs automatically on container start via `entrypoint.sh`.

---

## Flow Classification

`router.ts` reads the in-memory rule cache (loaded from `flow_identifiers` by `rules-db.ts`) and matches in **priority order**:

| Priority | Flow Step | Default match |
|---|---|---|
| 1 | `smart_metadata` | GET + `/.well-known/smart-configuration` |
| 2 | `authorization_request` | GET + `/protocol/openid-connect/auth` |
| 3 | `token_request_auth_code` | POST + token endpoint + `grant_type=authorization_code` |
| 4 | `token_request_client_cred` | POST + token endpoint + `grant_type=client_credentials` |
| 5 | `fhir_request` | `*` + `/fhir` |
| 6 | `token_request_refresh` | POST + token endpoint + `grant_type=refresh_token` |
| — | `unknown` | No rule matched |

Flow identifiers and their priorities can be edited via the Rules UI or `PUT /rules/flows/:flowStep`.

---

## Field Check Rules

Each flow step has a list of `FlowRuleField` rows. Locations checked:
- `query_params` — parsed from `req_url`
- `body_params` — parsed from `req_body` (form-encoded or JSON)
- `headers` — from `req_headers` (case-insensitive); `pattern` applies regex validation
- `response_body` — parsed from `res_body` JSON

### Field Types

| Type | Present → | Absent → | Notes |
|---|---|---|---|
| `required` | `PASS` | `FAIL` | Must exist |
| `conditional` | `PASS` | `SKIP` | Treated same as optional currently |
| `optional` | `PASS` | `SKIP` | Does not affect overall outcome |
| `forbidden` | `FAIL` | `PASS` | Blacklist — field must NOT be present |

### Rules Change Side Effects

Any write to `FlowIdentifier` or `FlowRuleField` (via `rules-db.ts`) automatically:
1. Reloads the in-memory rule cache (`reloadRulesFromDb`)
2. Calls `touchRulesUpdatedAt()` which sets `rules_updated_at` and **clears `processed_connections`**

This causes the poller to re-process all recent connections on its next tick, and marks existing results as stale in the UI (⚠ indicator when `validated_at < rules_updated_at`).

---

## REST API

All endpoints except `/health` require `Authorization: Bearer <token>`.

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/login` | `{ username, password }` → `{ token }` (8h TTL) |
| `POST` | `/auth/logout` | Invalidate session token |

### System
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/polling/status` | Poller state + config |
| `POST` | `/reload-rules` | Hot-reload rule cache from DB (does NOT touch `rules_updated_at`) |
| `GET` | `/stats` | Today's total/pass/fail counts |

### Settings
| Method | Path | Description |
|---|---|---|
| `GET` | `/settings/prism-db` | Current Prism DB URL + verified status |
| `POST` | `/settings/prism-db/test` | Test + save a new Prism DB URL |
| `GET` | `/settings/polling` | Polling enabled/interval/batchSize |
| `PUT` | `/settings/polling` | Update polling settings + restart poller |
| `GET` | `/settings/base-url` | Prism base URL (used for hyperlinks in UI) |
| `PUT` | `/settings/base-url` | Update base URL |
| `GET` | `/settings/rules-updated-at` | Timestamp of last rule change |

### Rules
| Method | Path | Description |
|---|---|---|
| `GET` | `/rules` | List all flow identifiers + field rules |
| `PUT` | `/rules/flows/:flowStep` | Update flow identifier (method, urlContains, etc.) |
| `POST` | `/rules/fields` | Create a new field rule |
| `PUT` | `/rules/fields/:id` | Update a field rule |
| `DELETE` | `/rules/fields/:id` | Delete a field rule |

### Validation
| Method | Path | Description |
|---|---|---|
| `POST` | `/validate` | On-demand validate: `{ connectionId }` OR `{ shareToken }`. Resolves shareToken → connectionId via Prism DB. Returns `connectionId`, `shareToken`, `flowStep`, `results[]` |
| `POST` | `/revalidate` | Stop poller → re-validate ALL existing `ValidationResult` entries from Prism DB using current rules → restart poller (background) |
| `GET` | `/revalidate/status` | `{ running, progress, total, revalidated, failed, completedAt }` |

### Results
| Method | Path | Description |
|---|---|---|
| `GET` | `/results` | Query results. Params: `shareToken` (priority, resolves via Prism), `connectionId` (fuzzy contains), `serverId`, `flowStep`, `status`, `from`, `to`, `limit`, `offset` |
| `GET` | `/results/:connectionId` | All results for one connection |

### Other
| Method | Path | Description |
|---|---|---|
| `GET` | `/prism/servers` | Backend server list from Prism DB (for filter dropdown) |
| `POST` | `/test/run` | Run all fixture test cases |

Nginx prefixes all API paths with `/api/` for the browser.

---

## UI Pages

All pages share `ui.js` for nav rendering and dark mode toggle (persisted in `localStorage`).
Correct `<head>` script order (must be maintained):
```html
<script>if(localStorage.getItem('darkMode')==='1')document.documentElement.classList.add('dark')</script>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={darkMode:'class'}</script>
<script src="/ui.js?v=2"></script>
```

| Page | Nav label | Key features |
|---|---|---|
| `login.html` | — | Username/password → session token stored in localStorage |
| `dashboard.html` | Dashboard | Poller status, today's PASS/FAIL counts |
| `results.html` | Results | Infinite scroll; ShareToken filter (priority, strips known URL prefix); Connection ID fuzzy filter; stale ⚠ indicator; copy + Inspect button per row |
| `rules.html` | Rules | CRUD for flow identifiers and field rules; field type badges (required=red, conditional=amber, optional=gray, forbidden=purple) |
| `settings.html` | Settings | Prism DB URL verify, polling config, base URL |
| `validate.html` | Inspect | Hot-update validate by shareToken (priority) or connectionId; shows Connection ID link, Share Token link, Flow Step, Overall PASS / FAIL X/Y |
| `test.html` | Test | Run fixture tests, display pass/fail per case |

---

## Key Design Decisions

- **Rules in DB, not YAML** — `FlowIdentifier` and `FlowRuleField` tables replace the old `rules.yaml`. Seeded with defaults on first run by `initRules()`.
- **No migration files** — `prisma db push` on every startup.
- **SSL disabled** — both DB connections use `ssl: false` / `?sslmode=disable` (internal VPC, no TLS between services).
- **Poller dedup** — fetches last-24h connections from Prism, filters out IDs already in `processed_connections`, validates the remainder up to `batchSize`.
- **Re-validation** — any rule change clears `processed_connections` (poller auto-re-validates on next tick). The `POST /revalidate` endpoint re-validates all *existing results* immediately by stopping the poller, fetching each stored `connectionId` from Prism, and re-running validation.
- **Stale indicator** — `results.html` fetches `rules_updated_at` on load; rows with `validated_at < rules_updated_at` are shown with ⚠.
- **ShareToken resolution** — `GET /results?shareToken=X` and `POST /validate { shareToken }` both resolve the token to a `connectionId` via a direct Prism DB query (`connections WHERE share_token = $1`).
- **Server name cache** — `getServerName()` in `prism.ts` caches the `backend_servers` table for 60 s to avoid per-connection queries.
- **Session auth** — in-memory token map with 8h TTL; suitable for single-instance intranet tool.
- **nginx template** — `nginx.conf` contains `${API_PORT}` placeholder; `compose.yml` runs `envsubst '$API_PORT'` at nginx startup to produce the real config, so changing `API_PORT` in `.env` propagates correctly.
