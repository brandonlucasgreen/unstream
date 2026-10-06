#!/usr/bin/env bash
# Restores a database backup into an EMPTY Supabase database and proves every row came back.
#
#   .github/scripts/db-restore-check.sh <dump-dir> <empty-db-url>
#
# <dump-dir> holds the schema.sql and data.sql written by .github/workflows/db-backup.yml (decrypted
# and unpacked, if it came from R2). <empty-db-url> must be a fresh Supabase database: a local
# `supabase start` stack, or a brand-new project. Never point this at production; the restore runs
# in one transaction and stops at the first error, but it is still a restore.
#
# The backup workflow runs this on every backup against a throwaway local stack, so "the backup
# restores" is checked daily rather than assumed. docs/database-backups.md uses it for real
# restores too.
#
# psql runs from the postgres:17 image rather than the machine's own client: pg_dump output must be
# read by a psql at least as new as the pg_dump that wrote it.
set -euo pipefail

dump_dir=$(cd "$1" && pwd)
db_url=$2

psql_in_docker() {
  docker run --rm --network host -v "$dump_dir:/dump" -w /dump postgres:17 \
    psql --dbname "$db_url" --no-psqlrc --quiet "$@"
}

# Supabase's documented restore: schema and data in one transaction, with triggers and foreign
# keys held off (session_replication_role = replica) so tables can load in any order.
# roles.sql is deliberately not replayed here: it holds only Supabase's own role settings, which a
# fresh project already has, and replaying it fails on grants only Supabase's admin may make.
# The restore's output goes to a log that is printed only if it fails. A successful restore
# otherwise prints a hundred harmless "no privileges were granted" warnings (grants on pg_trgm
# functions Supabase owns), and the dump's own header resets client_min_messages, so they can't be
# silenced at the source.
restore_log=$(mktemp)
if ! psql_in_docker --single-transaction --variable ON_ERROR_STOP=1 \
  --command 'SET session_replication_role = replica' \
  --file schema.sql --file data.sql > "$restore_log" 2>&1; then
  grep -v 'no privileges were granted' "$restore_log" | tail -n 40
  echo "::error::Restore failed; the transaction was rolled back"
  exit 1
fi

# Every table in data.sql: the rows the dump holds, against the rows the restore produced. COPY
# text format writes one line per row (newlines inside values are escaped), ended by "\.".
expected=$(awk '/^COPY /{t=$2; n=0; next} /^\\\.$/{if (t != "") print t, n; t=""; next} t != ""{n++}' "$dump_dir/data.sql")

if [ -z "$expected" ]; then
  echo "::error::data.sql contains no tables"
  exit 1
fi

failed=0
while read -r table rows; do
  restored=$(psql_in_docker --tuples-only --no-align --command "SELECT count(*) FROM $table")
  if [ "$restored" != "$rows" ]; then
    echo "::error::$table: backup holds $rows rows, restore produced $restored"
    failed=1
  fi
done <<< "$expected"

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "Restore check passed: $(echo "$expected" | wc -l) tables, $(echo "$expected" | awk '{s+=$2} END {print s}') rows."
