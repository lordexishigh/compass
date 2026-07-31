# Development

Compass is a single pnpm workspace: one TypeScript monorepo of layer-scoped
packages, deployed as two processes (a Next.js web/API app and a pg-boss worker)
over one PostgreSQL database.

## Prerequisites

- **Node.js ≥ 22.12** (`engines` is enforced)
- **pnpm 10**
- **PostgreSQL 17** — only for `pnpm db:migrate` and running the app. The test
  suite needs no database: `packages/db` runs its migrations and its
  scoped-query assertions against PGlite in-process.

## Running & verifying

```bash
pnpm install          # from a clean checkout
pnpm build            # tsc -b for every package, then `next build`
pnpm test             # every package's own suite, reported per package
pnpm lint             # ESLint, including the clock build gates
pnpm typecheck        # packages, tests, and the web app
pnpm verify           # lint + typecheck + test — what CI runs
```

`pnpm build` type-checks through `tsconfig.build.json`, which **excludes tests**:
it compiles only what ships. Tests are type-checked separately, because they are
not all resolved the same way — see *Two TypeScript projects* below.

To run it:

```bash
docker compose up -d postgres   # PostgreSQL 17 on :5432
cp .env.example .env            # local defaults; no secret needed
pnpm db:migrate                 # idempotent — safe to re-run and safe on boot
pnpm dev                        # web app
pnpm worker                     # the pg-boss worker, in a second shell
```

## Workspace layout

Each package owns its own `package.json`, `tsconfig.json` and `vitest.config.ts`,
exports through a `src/index.ts` barrel with implementation in sibling named
modules, and keeps its tests in `tests/`.

| Package | Layer |
| --- | --- |
| `packages/clock` | `Instant`, `TimeWindow`, zone helpers, the `Clock` port. The **only** legal system-clock read in the repo. |
| `packages/connector-port` | The time-windowed query port every data source implements, plus the conformance kit at `@compass/connector-port/testkit`. |
| `packages/seed-connector` | The seeded provider. Runs the shared contract suite unmodified. |
| `packages/db` | Drizzle schema and the scoped-query layer: no query is built without an organization scope. |
| `packages/knowledge-model` | Versioned org model over ingested records. |
| `packages/ingest` | Reconciliation of connector records into the model. |
| `packages/analysis` | The pure, deterministic core. No I/O, no time, no randomness. |
| `packages/pipeline` | Stage composition. Every stage receives `now` as a parameter. |
| `packages/renderers` | Structured report → web / email / Slack output. |
| `apps/web` | Next.js 15 App Router: the report view and route handlers. |
| `apps/worker` | The pg-boss worker process. |
| `tools/eslint-plugin-compass` | The clock build gates, as ESLint rules. Authored in plain JS and loaded directly by `eslint.config.js`. |
| `tools/quality-gates` | Workspace-wide gates: the source scan and the per-package layout contract. |

Dependencies run strictly downhill in that order. `packages/analysis` declares no
dependencies at all and re-declares the `Instant` brand structurally, so the pure
core has no import edge even to the clock.

## Time is a parameter, never ambient

`now` is resolved once at the process edge — a route handler, a worker trigger, a
test — and threaded down as an explicit `now: Instant`. This is what makes the
determinism gate and the time-travel scrubber possible, so it is enforced rather
than documented:

- **`compass/no-system-clock`** fails the build on `new Date()`, `Date.now()`,
  `performance.now()` and friends anywhere under
  `packages/{clock,ingest,knowledge-model,analysis,pipeline}/src`, naming the
  offending `file:line`. `new Date(epochMillis)` and `Date.parse(iso)` are fine —
  they convert a value that already came from the port.
- **`compass/no-time-library-imports`** bans dayjs/luxon/moment/date-fns in the
  same layers: a no-argument `dayjs()` is a wall-clock read the AST rule cannot
  see.
- **`compass/no-clock-instantiation`** stops a pipeline layer constructing a
  clock at all. Injecting a `Clock` into a stage is barely better than calling
  `Date.now()` — the stage still chooses *when* to read.

`SystemClock` carries the single sanctioned `eslint-disable` for the first rule.
`tools/quality-gates` asserts that exactly one such comment exists in the whole
workspace, so the exemption cannot spread by copy-paste, and re-checks the same
trees with a plain textual scan — if the plugin ever stops loading, lint would go
green while the scan stays red.

## Two TypeScript projects

`pnpm typecheck` runs three passes, and the split is deliberate:

1. `tsc -b tsconfig.build.json` — the shipped code, via project references.
2. `tsc -p tsconfig.tests.json` — every test suite that resolves modules the Node
   way, with `@compass/*` mapped to package **sources** so tests never depend on a
   prior build.
3. `pnpm --filter @compass/web run typecheck` — the web app and its tests, which
   compile under `moduleResolution: Bundler` with the `@/*` alias and are
   therefore authored extensionless.

A new test file outside the include globs of (2) is silently unchecked, so add
tests under an existing `<package>/tests/` path.

## Database

Migrations are drizzle-generated into `packages/db/drizzle`. Generate with
`pnpm db:generate` after editing `packages/db/src/schema/tables.ts` — never
hand-write the SQL, and never reuse an index, or the journal and snapshot desync
from a clean database.

Two conventions are enforced by tests rather than by review:

- **Every table carries a non-null `organization_id`.** `packages/db/tests/schema.test.ts`
  enumerates the exported schema objects and fails on any table that lacks it —
  including `organizations` itself, which carries the column equal to its own `id`
  under a check constraint, so there is no exemption list to creep.
- **No query is built without an organization scope.** `ScopedDb` is the only
  data-access path, it applies the organization predicate itself, and it throws
  when constructed without a valid scope. Its tests assert both the emitted SQL
  and a real two-tenant round trip.

## Project layout

- `docs/` — project brief, architecture, and the build plan
- `.nous/` — pipeline session state (safe to ignore / not part of the product)
