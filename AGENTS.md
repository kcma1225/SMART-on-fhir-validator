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
| ORM | Prisma 5 (validator DB) |
| Prism DB access | pg (raw Pool, read-only) |
| Config | js-yaml |
| UI | Plain HTML + Tailwind CSS CDN |

---

## Repository Layout

```
validator/
├── compose.yml              Docker Compose (nginx + validator + postgres)
├── Dockerfile               Multi-stage build
├── entrypoint.sh            prisma db push → node dist/api.js
├── nginx.conf               /api/* → validator:3000, /* → static UI
├── config.yaml              Polling interval, batch size, API port
├── rules.yaml               Flow identification + field check rules
├── prisma/schema.prisma     Validator DB schema (validation_results, processed_connections)
├── tests/
│   └── test-fixtures.json   14 test cases (run via POST /test/run)
└── src/
    ├── types.ts             Shared TypeScript interfaces
    ├── config.ts            Config + rules loader (env-var interpolation)
    ├── core.ts              validateConnection() + validateAndSave()
    ├── router.ts            Flow classifier (priority-ordered rule matching)
    ├── checker.ts           Field checker (query_params / body_params / headers / response_body)
    ├── writer.ts            Saves ValidationResult rows + marks ProcessedConnection
    ├── poller.ts            Background polling job; cross-checks validator DB to skip duplicates
    ├── tester.ts            In-memory fixture runner (no DB required)
    ├── api.ts               Fastify server, session auth, all REST endpoints
    ├── db/
    │   ├── prism.ts         Read-only pg Pool (PRISM_DATABASE_URL, ssl: false)
    │   └── validator.ts     Prisma client singleton (VALIDATOR_DATABASE_URL)
    └── ui/
        ├── login.html       Session login (admin / admin123)
        ├── dashboard.html   Polling status + today's stats
        ├── results.html     Filterable results table
        ├── validate.html    On-demand single-connection validate
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

| Variable | Required | Description |
|---|---|---|
| `PRISM_DATABASE_URL` | Yes | Read-only connection to Prism PostgreSQL |
| `VALIDATOR_DB_PASSWORD` | Yes | Password for the local validator postgres service |
| `ADMIN_USER` | No | UI login username (default: `admin`) |
| `ADMIN_PASS` | No | UI login password (default: `admin123`) |

Copy `.env.example` → `.env` and fill in `PRISM_DATABASE_URL` and `VALIDATOR_DB_PASSWORD`.

The `VALIDATOR_DATABASE_URL` is constructed automatically in `compose.yml` and includes `?sslmode=disable`.

---

## Flow Classification (Router)

`router.ts` matches connections in this fixed priority order:

| Priority | Flow Step | Identify |
|---|---|---|
| 1 | `smart_metadata` | GET + URL contains `/.well-known/smart-configuration` |
| 2 | `token_request_refresh` | POST + token endpoint + body `grant_type=refresh_token` |
| 3 | `token_request_client_cred` | POST + token endpoint + body `grant_type=client_credentials` |
| 4 | `token_request_auth_code` | POST + token endpoint + body `grant_type=authorization_code` |
| 5 | `authorization_request` | GET + URL contains `/protocol/openid-connect/auth` |
| 6 | `fhir_request` | Any method + URL contains `/fhir` |
| — | `unknown` | No rule matched |

Body parsing supports both `application/x-www-form-urlencoded` and JSON.

---

## Field Check Rules (`rules.yaml`)

Each flow defines what to check:
- `query_params` — parsed from `req_url`
- `body_params` — parsed from `req_body` (form-encoded or JSON)
- `headers` — from `req_headers` (case-insensitive); supports `patterns` for regex validation
- `response_body` — parsed from `res_body` JSON (used by `smart_metadata`)

Result status per field:
- `PASS` — field present (and matches pattern if defined)
- `FAIL` — field missing or pattern mismatch
- `SKIP` — optional/conditional field not present

---

## REST API

All endpoints except `/health` require `Authorization: Bearer <token>` (obtained via `POST /auth/login`).

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/login` | `{ username, password }` → `{ token }` |
| `POST` | `/auth/logout` | Invalidate session |
| `GET` | `/health` | Service health check |
| `GET` | `/polling/status` | Current poller state |
| `GET` | `/stats` | Today's PASS/FAIL counts |
| `POST` | `/validate` | On-demand validate `{ connectionId }` |
| `GET` | `/results` | Query results (`institutionId`, `flowStep`, `status`, `from`, `to`) |
| `GET` | `/results/:connectionId` | All results for one connection |
| `POST` | `/test/run` | Run all 14 fixture test cases |
| `POST` | `/reload-rules` | Hot-reload `rules.yaml` without restart |

Nginx prefixes all API paths with `/api/` for the UI.

---

## Validator DB Schema

```sql
validation_results      -- one row per field per connection
processed_connections   -- tracks which connection IDs have been validated
```

`prisma db push` runs automatically on container start via `entrypoint.sh`.

---

## Coding Style

- Follows Prism project conventions: semicolons, single quotes, trailing commas, 2-space indent.
- TypeScript strict mode; CommonJS modules.
- `camelCase` for functions/variables, `PascalCase` for interfaces/types.
- No comments unless the WHY is non-obvious.

---

## Key Design Decisions

- **No migration files** — `prisma db push` on every startup.
- **SSL disabled** — both DB connections use `ssl: false` / `?sslmode=disable` (internal VPC deployment, no TLS between services).
- **Poller cross-DB dedup** — fetches last-24h connections from Prism, then checks validator DB to skip already-processed IDs (avoids cross-database JOIN).
- **Rules hot-reload** — `POST /reload-rules` resets the in-memory rules cache; no restart needed.
- **Session auth** — in-memory token map with 8h TTL; suitable for single-instance intranet tool.
