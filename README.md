# SMART on FHIR / IUA Validator

A field-validation service for SMART on FHIR / IUA traffic captured by a Prism proxy.

Reads Prism `connections` records, classifies each request into a SMART/FHIR flow step, checks configured fields, and stores results in its own PostgreSQL database. Rules, Prism DB connection, polling settings, and base URL are all managed from the web UI.

## Features

- Fastify backend with static admin UI (dark/light mode, persisted in localStorage)
- Docker Compose deployment: Nginx + validator API + PostgreSQL
- All ports and DB credentials configurable via `.env`
- Editable validation rules stored in the validator database (no YAML files)
- Four field types: `required`, `conditional`, `optional`, `forbidden` (blacklist)
- Flow endpoint patterns editable per deployment
- On-demand **Connection Inspect** page: validate by Connection ID or Share Token, shows per-field values with copy buttons and horizontal scroll
- Re-validation: manually trigger re-validation of all existing results against current rules
- Stale result indicator (⚠) when results pre-date the last rule change
- ShareToken filter with automatic URL prefix stripping
- Polling dashboard, filterable results list, and fixture-based test page

## Requirements

- Docker and Docker Compose
- Access to a Prism proxy PostgreSQL database

## Configuration

Copy `.env.example` to `.env` and fill in required values:

```bash
cp .env.example .env
```

| Variable | Default | Notes |
|---|---|---|
| `PRISM_DATABASE_URL` | — | **Required.** Prism DB read-only connection URL |
| `VALIDATOR_DB_PASSWORD` | — | **Required.** Validator postgres password |
| `VALIDATOR_DB_HOST` | `postgres` | Postgres hostname (Docker service name) |
| `VALIDATOR_DB_PORT` | `5432` | Postgres port; sets `PGPORT` inside the container |
| `VALIDATOR_DB_USER` | `validator` | Postgres username |
| `VALIDATOR_DB_NAME` | `validator` | Postgres database name |
| `FRONTEND_PORT` | `80` | Host port mapped to nginx |
| `API_PORT` | `3000` | Fastify listen port; substituted into nginx.conf at startup |
| `BASE_PATH` | — (root) | Sub-path prefix when served behind a path-routing reverse proxy (e.g. `/validator`); substituted into nginx.conf and injected into the UI |
| `ADMIN_USER` | `admin` | UI login username |
| `ADMIN_PASS` | `admin123` | UI login password |
| `BASE_URL` | — | Prism web base URL (e.g. `https://host/prism`); used for Connection ID / Share Token hyperlinks |

`VALIDATOR_DATABASE_URL` is assembled automatically in `compose.yml` from the `VALIDATOR_DB_*` vars. Do not set it manually.

`BASE_URL` seeds the database on first startup and can also be overridden at any time from the Settings page.

## Run

```bash
docker compose up -d --build
```

Open the UI at `http://localhost/` (or the configured `FRONTEND_PORT`).

| Page | Path | Description |
|---|---|---|
| Dashboard | `/dashboard.html` | Polling status and daily PASS/FAIL counts |
| Results | `/results.html` | Filterable results table with infinite scroll |
| Inspect | `/validate.html` | On-demand validate by Connection ID or Share Token |
| Rules | `/rules.html` | Edit flow identifiers and field rules |
| Settings | `/settings.html` | Prism DB, polling config, base URL |
| Test | `/test.html` | Fixture-based test runner |

## Development

```bash
npm install
npm run dev       # hot-reload backend
npm run build     # compile TypeScript + (optional) Vite
```

Push the Prisma schema:

```bash
VALIDATOR_DATABASE_URL="postgresql://validator:password@localhost:5432/validator?sslmode=disable" \
  npx prisma db push --schema=prisma/schema.prisma
```

## Field Type Reference

| Type | Field present | Field absent |
|---|---|---|
| `required` | PASS | FAIL |
| `conditional` | PASS | SKIP |
| `optional` | PASS | SKIP |
| `forbidden` | **FAIL** | PASS |

`forbidden` is a blacklist type — the field must **not** appear in the request/response.

## Notes

- Rules changes automatically clear `processed_connections`, causing the poller to re-validate all recent connections on the next tick.
- The Inspect page opens in a new tab when launched from the Results list.
- `nginx.conf` is a template; `${API_PORT}` and `${BASE_PATH}` are substituted by `envsubst` at nginx startup. Only those two are substituted — nginx's own `$host`, `$uri` etc. are preserved.
- **Serving under a sub-path:** set `BASE_PATH` (e.g. `/validator`, no trailing slash). nginx then serves the UI and `/api` under that prefix, and the UI emits prefixed URLs (`window.BASE_PATH` is injected into each page and used by `withBase()` in `ui.js`). The upstream reverse proxy must forward the prefix through — do **not** strip it. Example upstream block: `location /validator/ { proxy_pass http://prism-validator-host; }` (no trailing slash on `proxy_pass`).
- Query params are parsed directly from the URL's `?` position using `URLSearchParams`, so both absolute and relative `req_url` formats are supported.
