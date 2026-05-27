#!/bin/sh
set -e
npx prisma db push --schema=/app/prisma/schema.prisma --skip-generate
exec node /app/dist/api.js
