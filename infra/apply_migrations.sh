#!/usr/bin/env bash
set -euo pipefail

# Apply SQL files in infra/migrations to the DATABASE_URL
# Usage: DATABASE_URL="postgresql://..." ./infra/apply_migrations.sh

if [ -z "${DATABASE_URL-}" ]; then
  echo "Please set DATABASE_URL environment variable. Example:"
  echo "  export DATABASE_URL=\"postgresql://user:pass@host:5432/dbname\""
  exit 1
fi

for f in infra/migrations/*.sql; do
  echo "Applying $f"
  psql "$DATABASE_URL" -f "$f"
done

echo "All migrations applied."