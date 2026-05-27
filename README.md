# SMART on FHIR Validator

A lightweight validator for SMART on FHIR / IUA traffic captured by a Prism proxy.

The service reads Prism `connections` records, classifies each request into a SMART/FHIR flow, checks configured fields, and stores validation results in its own PostgreSQL database. Rules, Prism database connection settings, and polling settings are managed from the web UI.

## Features

- Fastify backend with static admin UI
- Docker Compose deployment with Nginx, validator API, and PostgreSQL
- Prism database connection test before polling starts
- Editable validation rules stored in the validator database
- Editable flow endpoint paths for different OAuth/FHIR deployments
- On-demand validation by connection ID
- Polling dashboard, results list, and fixture-based test page

## Requirements

- Docker and Docker Compose
- Access to a Prism proxy PostgreSQL database

## Configuration

Create a local `.env` from the example:

```bash
cp .env.example .env
```

Set at least:

```env
VALIDATOR_DB_PASSWORD=change_me
ADMIN_USER=admin
ADMIN_PASS=admin123
API_PORT=3000
```

`PRISM_DATABASE_URL` can be set in `.env` as an initial value, but the recommended setup is to configure and test the Prism database from the Settings page.

## Run

```bash
docker compose -f compose.yml up -d --build
```

Open the UI:

```text
http://localhost/
```

Default pages:

- `/dashboard.html` polling status and daily stats
- `/settings.html` Prism DB and polling settings
- `/rules.html` editable flow endpoints and field validation rules
- `/validate.html` on-demand validation
- `/results.html` stored validation results
- `/test.html` fixture checks

## Development

Install dependencies:

```bash
npm install
```

Run the backend locally:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Push the Prisma schema to the validator database:

```bash
npm run db:push
```

## Notes

- Rules are stored in database tables, not in a YAML file.
- `required` fields fail when missing.
- `conditional` and `optional` fields are recorded as `SKIP` when missing.
- Extra request parameters or body fields do not fail validation.
- Parameter order does not affect validation.
