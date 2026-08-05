#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
database_url=${TEST_DATABASE_URL:-}

if [[ -z "$database_url" ]]; then
  echo "TEST_DATABASE_URL is required" >&2
  exit 2
fi

psql "$database_url" -X -v ON_ERROR_STOP=1 \
  -f "$repo_root/supabase/tests/bootstrap.sql"

while IFS= read -r migration; do
  if [[ "$(basename "$migration")" == "20260715000000_shared_backend.sql" ]]; then
    psql "$database_url" -X -v ON_ERROR_STOP=1 \
      -f "$repo_root/supabase/tests/pre_shared_backend.sql"
  fi
  if [[ "$(basename "$migration")" == "20260805200000_restore_user_ownership.sql" ]]; then
    psql "$database_url" -X -v ON_ERROR_STOP=1 \
      -f "$repo_root/supabase/tests/pre_restore_user_ownership.sql"
  fi
  psql "$database_url" -X -v ON_ERROR_STOP=1 -f "$migration"
done < <(find "$repo_root/supabase/migrations" -maxdepth 1 -type f -name '*.sql' | sort)

psql "$database_url" -X -v ON_ERROR_STOP=1 \
  -f "$repo_root/supabase/tests/assertions.sql"
