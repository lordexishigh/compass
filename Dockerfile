# syntax=docker/dockerfile:1
#
# One image, run as two processes.
#
# `docker compose up` on a clean checkout has to end with a manager reading a
# report, so this image carries everything that takes: the built packages, the
# built Next.js app, the checked-in seed under `seed/`, and the migrations. The
# entrypoint decides which process it is — `web` or `worker` — because the two
# share every layer below the edge and building them twice would let them drift.
#
# Dev dependencies are deliberately kept in the final stage. The boot path runs
# `tsx src/cold-start.ts`, and a pruned image would have to ship a second compiled
# entry point for the one script whose whole job is being easy to read.

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base

# `npm install -g` rather than corepack, for one reason: corepack caches the pnpm
# it prepares under the *invoking user's* home, and the final stage runs as `node`.
# A corepack-prepared pnpm therefore resolves at build time as root and then tries
# to re-download itself at container start as `node`, which fails with no network —
# a boot failure that reproduces only in the built image. A global install lands in
# a world-readable prefix and needs nothing at runtime.
ENV CI=true
RUN npm install --global pnpm@10.15.0 && pnpm --version
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS build

# Only the build stage names a store: the cache mount below needs a fixed target,
# and carrying the variable into the runtime stage would have pnpm try to create
# `/pnpm/store` as the unprivileged `node` user, where it has no write access and
# no reason to want one.
ENV PNPM_STORE_DIR=/pnpm/store

# The whole workspace at once. Splitting the manifests into their own layer would
# cache better, but a pnpm workspace of thirteen packages means thirteen COPY
# lines that silently stop matching the moment a package is added — and a stale
# install is a much worse failure than a slow build.
COPY . .

RUN --mount=type=cache,id=compass-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Packages first, then the app: Next.js consumes the workspace packages from
# their built `dist`, exactly as `pnpm build` does on a laptop.
RUN pnpm run build

# ---------------------------------------------------------------------------
FROM base AS runtime

# `HOSTNAME` is deliberately not set here: Docker already populates it with the
# container id, and the entrypoint passes `--hostname 0.0.0.0` to `next start`
# explicitly instead. `COMPASS_SEED_DIR` is absolute so the seed loader cannot be
# confused by where a process happens to have been started from.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    COMPASS_SEED_DIR=/app/seed

# `--chown` on the COPY rather than a following `chown -R`: the latter rewrites
# every file and doubles the image on disk for no gain.
COPY --from=build --chown=node:node /app /app
COPY tools/docker/entrypoint.sh /usr/local/bin/compass-entrypoint
RUN chmod +x /usr/local/bin/compass-entrypoint

# Non-root: nothing in the running image needs to write outside /tmp.
USER node

EXPOSE 3000

# `/api/health` names every capability and its condition, and answers 200 even
# when an optional integration is absent — so an unhealthy container here means
# something is actually wrong rather than merely unconfigured.
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=6 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["compass-entrypoint"]
CMD ["web"]
