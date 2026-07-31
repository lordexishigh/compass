#!/usr/bin/env bash
#
# The container's boot path.
#
#   compass-entrypoint web      migrate, provision, generate today's report, serve
#   compass-entrypoint worker   migrate, provision, then take jobs
#   compass-entrypoint seed     migrate, provision, generate the report, exit
#
# The `web` path warms the report before binding the port. That ordering is the
# whole of the 60-second promise: the first request finds a row and reads it,
# rather than ingesting the entire seeded substrate while a manager waits. The
# request path can still generate — a container restarted past midnight must —
# this only means it usually does not have to.
#
# `set -euo pipefail` matters more here than in most scripts: a cold start that
# failed to migrate and then served anyway would answer `/` with a stack trace,
# which is the one outcome worse than a slow boot.
set -euo pipefail

cd /app

MODE="${1:-web}"

# A boot that cannot reach PostgreSQL should say so once per second for a bounded
# time and then fail loudly, not hang until an orchestrator's patience runs out.
# Compose's `service_healthy` normally makes this a no-op; it exists for the run
# without compose, and for the first boot where initdb is still finishing.
#
# The check is a raw TCP connect via `node:net` rather than a `pg` client: pnpm
# does not hoist transitive dependencies, so `require('pg')` from /app is not
# guaranteed to resolve, and a wait loop that fails to load its own driver would
# report "database unreachable" for a database that was up.
wait_for_database() {
  local attempts="${COMPASS_DB_WAIT_ATTEMPTS:-60}"
  local attempt=1

  while [ "${attempt}" -le "${attempts}" ]; do
    if node -e "
      const net = require('node:net');
      const raw = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
      if (!raw) { console.error('neither DATABASE_URL_DIRECT nor DATABASE_URL is set'); process.exit(2); }
      const url = new URL(raw);
      const socket = net.connect({ host: url.hostname, port: Number(url.port || 5432) });
      socket.setTimeout(2000);
      socket.once('connect', () => { socket.end(); process.exit(0); });
      socket.once('timeout', () => { socket.destroy(); process.exit(1); });
      socket.once('error', () => process.exit(1));
    " 2>/dev/null; then
      return 0
    fi

    if [ "${attempt}" -eq 1 ]; then
      echo "[compass] waiting for PostgreSQL (up to ${attempts}s)..."
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  echo "[compass] PostgreSQL did not accept a connection within ${attempts}s. Check DATABASE_URL_DIRECT." >&2
  return 1
}

cold_start() {
  # Migrations, the tenant row, the roster, then the report — all idempotent, so
  # this runs on every boot rather than once behind a marker file that would go
  # stale the first time somebody dropped the volume.
  pnpm --filter @compass/worker run cold-start
}

case "${MODE}" in
  web)
    wait_for_database
    cold_start
    echo "[compass] serving on http://0.0.0.0:${PORT:-3000}"
    # Host and port are passed explicitly rather than left to `HOSTNAME`: Docker
    # already sets that variable to the container id, and a server that bound the
    # container id would be unreachable from the published port with no error to
    # explain why.
    exec pnpm --filter @compass/web exec next start --hostname 0.0.0.0 --port "${PORT:-3000}"
    ;;
  worker)
    wait_for_database
    # The worker does not warm a report: the web container has already done it,
    # and two processes generating the same day would race to overwrite one row.
    pnpm --filter @compass/worker run bootstrap
    exec pnpm --filter @compass/worker run start
    ;;
  seed)
    wait_for_database
    cold_start
    ;;
  *)
    # Anything else is run verbatim, so `docker compose run web bash` still works.
    exec "$@"
    ;;
esac
