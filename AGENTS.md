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
| Language | TypeScript 5 (strict, CommonJS) — `lib: ["ES2022", "dom"]` |
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
├── nginx.conf               Template: ${BASE_PATH}/api/* → validator:${API_PORT}, ${BASE_PATH}/* → static UI
│                            Processed by envsubst at nginx startup — only $API_PORT and $BASE_PATH substituted
├── .env                     Local environment variables (copy from .env.example)
├── .env.example             All supported env vars with defaults
├── prisma/schema.prisma     Validator DB schema
├── tests/
│   └── test-fixtures.json   Fixture test cases (run via POST /test/run)
└── src/
    ├── types.ts             Shared TypeScript interfaces (PrismConnection, ValidationOutput,
    │                        FieldResult — includes optional `value?: string` field)
    ├── core.ts              validateConnection() + validateAndSave()
    ├── router.ts            Flow classifier (priority-ordered rule matching from DB cache)
    │                        Uses req_url.includes() — works for relative and absolute URLs
    ├── checker.ts           Field checker; extracts actual field values into FieldResult.value;
    │                        parseQueryParams uses URLSearchParams(url.slice(idx+1)) — no URL base needed
    ├── writer.ts            Saves ValidationResult rows + upserts ProcessedConnection
    ├── rules-db.ts          DB-backed rules CRUD; seeds defaults on first run;
    │                        every write calls touchRulesUpdatedAt()
    ├── settings.ts          ValidatorSetting CRUD; BASE_URL seeded from env on first run,
    │                        getBaseUrl() falls back to process.env.BASE_URL if DB is empty
    ├── poller.ts            Background polling job; skips already-processed IDs
    ├── tester.ts            In-memory fixture runner (no DB required)
    ├── api.ts               Fastify server, session auth, all REST endpoints;
    │                        owns revalidateState + revalidateAllExisting()
    ├── db/
    │   ├── prism.ts         Read-only pg Pool; getRecentConnections, getConnectionById,
    │   │                    getConnectionIdByShareToken, getBackendServers, getServerName (60s cache)
    │   │                    PrismConnection includes share_token field
    │   └── validator.ts     Prisma client singleton (VALIDATOR_DATABASE_URL)
    └── ui/
        ├── ui.js            Shared nav render, dark mode toggle (localStorage),
        │                    escapeHtml/escapeAttr globals
        ├── login.html       Session login
        ├── dashboard.html   Polling status + today's stats
        ├── results.html     Infinite scroll; ShareToken priority filter (strips BASE_URL/view/c/ prefix);
        │                    Connection ID fuzzy filter; stale ⚠ indicator;
        │                    copy + Inspect button per row (Inspect opens in new tab)
        ├── rules.html       CRUD for flow identifiers and field rules;
        │                    badges: required=red, conditional=amber, optional=gray, forbidden=purple
        ├── settings.html    Prism DB URL verify, polling config, base URL
        ├── validate.html    "Connection Inspect": hot-update by shareToken (priority) or connectionId;
        │                    info card: Connection ID link, Share Token link, Flow Step + raw URL tooltip (!),
        │                    Overall PASS/FAIL X/Y; table: Field, Location, Req, Status+detail-icon, Value
        │                    (Value col: copy btn left, whitespace-nowrap, table scrolls horizontally)
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

All variables defined in `.env` (copy from `.env.example`).

| Variable | Default | Description |
|---|---|---|
| `PRISM_DATABASE_URL` | — | **Required.** Full PostgreSQL URL for Prism DB (read-only) |
| `VALIDATOR_DB_HOST` | `postgres` | Hostname of validator postgres (Docker service name) |
| `VALIDATOR_DB_PORT` | `5432` | Port postgres listens on; propagated to `PGPORT` inside the postgres container |
| `VALIDATOR_DB_USER` | `validator` | PostgreSQL username |
| `VALIDATOR_DB_NAME` | `validator` | PostgreSQL database name |
| `VALIDATOR_DB_PASSWORD` | — | **Required.** PostgreSQL password |
| `FRONTEND_PORT` | `80` | Host-side port mapped to nginx (container always listens on 80) |
| `API_PORT` | `3000` | Fastify listen port inside the validator container; substituted into nginx.conf via envsubst |
| `BASE_PATH` | — (root) | Sub-path prefix for serving behind a path-routing reverse proxy (e.g. `/validator`, no trailing slash); substituted into nginx.conf via envsubst and injected into each HTML page as `window.BASE_PATH` |
| `ADMIN_USER` | `admin` | UI login username |
| `ADMIN_PASS` | `admin123` | UI login password |
| `BASE_URL` | — | Prism web base URL (e.g. `https://host/prism`); seeds DB on first run; used for Connection ID / Share Token hyperlinks and ShareToken URL prefix stripping |

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

URL matching uses `req_url.includes(urlContains)` — works for both relative paths and absolute URLs.

---

## Field Check Rules

Each flow step has a list of `FlowRuleField` rows. Locations checked:
- `query_params` — parsed from `req_url` using `URLSearchParams(url.slice(url.indexOf('?') + 1))`
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

### FieldResult.value

`checker.ts` extracts the actual value of each field and includes it in `FieldResult.value`:
- `undefined` — field was absent (FAIL/SKIP due to absence)
- `""` (empty string) — field key present but value is empty
- `"string"` — the actual value (objects/arrays are `JSON.stringify`'d)

This is returned by `/validate` but **not stored in the DB** (only shown in the Inspect UI).

### Rules Change Side Effects

Any write to `FlowIdentifier` or `FlowRuleField` (via `rules-db.ts`) automatically:
1. Reloads the in-memory rule cache (`reloadRulesFromDb`)
2. Calls `touchRulesUpdatedAt()` which sets `rules_updated_at` and **clears `processed_connections`**

This causes the poller to re-process all recent connections on its next tick, and marks existing results as stale in the UI (⚠ when `validated_at < rules_updated_at`).

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
| `GET` | `/settings/base-url` | Prism base URL |
| `PUT` | `/settings/base-url` | Update base URL |
| `GET` | `/settings/rules-updated-at` | Timestamp of last rule change |

### Rules
| Method | Path | Description |
|---|---|---|
| `GET` | `/rules` | List all flow identifiers + field rules |
| `PUT` | `/rules/flows/:flowStep` | Update flow identifier |
| `POST` | `/rules/fields` | Create a new field rule |
| `PUT` | `/rules/fields/:id` | Update a field rule |
| `DELETE` | `/rules/fields/:id` | Delete a field rule |

### Validation
| Method | Path | Description |
|---|---|---|
| `POST` | `/validate` | `{ connectionId }` OR `{ shareToken }`. Returns `{ connectionId, shareToken, flowStep, reqUrl, results[] }`. Each result includes `value?: string` (actual field value, not persisted). |
| `POST` | `/revalidate` | Stop poller → re-validate ALL existing `ValidationResult` entries → restart poller (runs in background, returns immediately) |
| `GET` | `/revalidate/status` | `{ running, progress, total, revalidated, failed, completedAt }` |

### Results
| Method | Path | Description |
|---|---|---|
| `GET` | `/results` | Params: `shareToken` (priority), `connectionId` (fuzzy), `serverId`, `flowStep`, `status`, `from`, `to`, `limit`, `offset` |
| `GET` | `/results/:connectionId` | All results for one connection |

### Other
| Method | Path | Description |
|---|---|---|
| `GET` | `/prism/servers` | Backend server list from Prism DB (for filter dropdown) |
| `POST` | `/test/run` | Run all fixture test cases |

Nginx prefixes all API paths with `/api/` for the browser.

---

## UI Pages

All pages share `ui.js` for nav rendering and dark mode. Correct `<head>` order (**must be maintained**):
```html
<script>if(localStorage.getItem('darkMode')==='1')document.documentElement.classList.add('dark')</script>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={darkMode:'class'}</script>
<script src="/ui.js?v=2"></script>
```
Breaking this order (e.g. ui.js before CDN) breaks the dark/light toggle.

| Page | Nav label | Key features |
|---|---|---|
| `login.html` | — | Username/password → session token in localStorage |
| `dashboard.html` | Dashboard | Poller status, today's PASS/FAIL counts |
| `results.html` | Results | Infinite scroll; ShareToken filter (priority, auto-strips `BASE_URL/view/c/` prefix); Connection ID fuzzy filter; stale ⚠; copy + Inspect (new tab) per row |
| `rules.html` | Rules | CRUD for flow identifiers and field rules; badges: required=red, conditional=amber, optional=gray, forbidden=purple |
| `settings.html` | Settings | Prism DB URL verify, polling config, base URL |
| `validate.html` | Inspect | Hot-update by shareToken (priority) or connectionId; info card: Connection ID + link, Share Token + link, Flow Step + raw URL `!` tooltip, Overall PASS/FAIL X/Y; results table has Value column (copy btn, horizontal scroll via `min-w-full` + `overflow-auto` outer container) |
| `test.html` | Test | Run fixture tests, display pass/fail per case |

### ShareToken URL prefix stripping

Both `results.html` and `validate.html` strip a known URL prefix from the ShareToken input:
```javascript
let SHARE_URL_PREFIX = '';
// Set in init() after fetching baseUrl:
SHARE_URL_PREFIX = baseUrl + '/view/c/';
// extractShareToken strips it if present, passes raw value otherwise
```
The prefix is derived from `BASE_URL` at runtime — not hardcoded.

---

## Key Design Decisions

- **Rules in DB, not YAML** — `FlowIdentifier` and `FlowRuleField` tables. Seeded with defaults on first run by `initRules()`.
- **No migration files** — `prisma db push` on every startup.
- **SSL disabled** — both DB connections use `ssl: false` / `?sslmode=disable` (internal VPC deployment).
- **Poller dedup** — fetches last-24h connections from Prism, filters out IDs already in `processed_connections`, validates the remainder up to `batchSize`.
- **Re-validation** — rule changes clear `processed_connections` (poller auto-re-validates next tick). `POST /revalidate` re-validates all *existing results* immediately: stops poller, fetches each `connectionId` from Prism, re-runs validation, restarts poller.
- **Stale indicator** — `results.html` fetches `rules_updated_at` on load; rows with `validated_at < rules_updated_at` show ⚠.
- **ShareToken resolution** — both `/results?shareToken=X` and `POST /validate { shareToken }` query Prism DB (`connections WHERE share_token = $1`) to resolve to a connectionId.
- **Server name cache** — `getServerName()` in `prism.ts` caches `backend_servers` for 60 s.
- **Session auth** — in-memory token map with 8h TTL; suitable for single-instance intranet tool.
- **nginx template** — `nginx.conf` has `${API_PORT}` and `${BASE_PATH}` placeholders; `compose.yml` runs `envsubst '$API_PORT $BASE_PATH'` (single-quoted variable list preserves nginx's own `$host`, `$uri` etc.).
- **BASE_PATH / sub-path serving** — `BASE_PATH` (empty = root) prefixes both the `${BASE_PATH}/api/` proxy location and the `${BASE_PATH}/` static location. The api location's trailing-slash `proxy_pass http://validator:.../` strips the prefix so the backend still sees `/auth/login` etc. (no backend change needed). nginx `sub_filter` injects the value into each HTML page as `window.BASE_PATH` (placeholder token `@@BASE_PATH@@`); `ui.js` reads it into `withBase()`, which prefixes every API call, redirect, and nav link. The upstream path-routing proxy must forward the prefix through (no strip).
- **parseQueryParams fix** — uses `new URLSearchParams(url.slice(url.indexOf('?') + 1))` instead of `new URL(url)`, so relative `req_url` paths (the format Prism stores) parse correctly without a dummy base URL.
- **`value` in FieldResult** — `checker.ts` extracts the actual runtime value for each checked field. Returned by `/validate` for the Inspect UI but intentionally not persisted in `validation_results` (would bloat the table).
- **DB port propagation** — `VALIDATOR_DB_PORT` sets `PGPORT` env var inside the postgres container (makes PostgreSQL listen on that port) AND is used in `VALIDATOR_DATABASE_URL`. Changing the port in `.env` propagates to all three places automatically.
- **BASE_URL seed** — `settings.ts:ensureSettingsRow()` seeds `baseUrl` from `process.env.BASE_URL` on first startup. `getBaseUrl()` falls back to env if the DB value is null (allows env-only config without a Settings page visit).
