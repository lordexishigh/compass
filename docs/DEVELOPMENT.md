# Development

## Zero-config cold start

Compass has one hard promise about getting started: a clean checkout, one command,
and you are reading a fully generated six-section report. No login wall, no
connector wizard, no empty state, and no `.env` to write first.

### With Docker (the canonical path)

```bash
docker compose up
# then open http://localhost:3000
```

That is all of it. The compose file supplies working defaults for every value, so
there is nothing to configure — a demo that needs configuration is not a
zero-config demo, and CI proves it by running exactly this on a clean runner.

The web container does four things before it binds the port, in
`tools/docker/entrypoint.sh`:

1. waits for PostgreSQL,
2. applies migrations,
3. provisions the tenant and the roster from `seed/fixtures`,
4. **generates today's report** through the real pipeline.

Step 4 is why the first request is fast. Without it, opening `/` would ingest the
whole seeded substrate — two and a half months of history — while you waited. The
request path can still generate, and must (a container restarted past midnight has
no report for the new day), but it usually does not have to.

The scheduled worker is in a profile, so it does not hold up the first read:

```bash
docker compose --profile worker up
```

### Without Docker

You need a PostgreSQL 17 on `localhost:5432`. Then:

```bash
cp .env.example .env      # optional; these are the defaults
pnpm install
pnpm run seed             # generate the seed, migrate, provision, warm the report
pnpm run dev              # then open http://localhost:3000
```

`pnpm run seed` is the same cold start the container runs, minus the container. It
is idempotent, so running it again is safe and cheap.

### What you should see

Six sections, in this order, forever: **01 Yesterday, 02 Progress, 03 Blockers,
04 Risks, 05 Recommendations, 06 Wins**. Every computed claim carries a superscript
marker linking to an artifact page for the commit SHA, pull request number or
tracker key behind it. Above the report, a per-source freshness line states what
was ingested and when — and names the source the seed deliberately reports as
rate-limited, because the seeded org includes one, and a report that called itself
complete anyway would be the dishonesty this product exists to replace.

The seeded history ends on a fixed date. Once the host clock passes it, the page
reports the last day it has real data for and says so in a sentence rather than
showing you six honest, useless absences.

### Alignment, and how to argue with it

Inside **04 Risks** you will find two alignment findings the seeded org plants on
purpose.

- One **OFF-GOAL** verdict, naming `OBJ-Q2-BILL` — an objective that stopped being
  current at the end of Q2 — and the billing-migration tickets and commits running
  inside the current sprint that serve it.
- One **unattributed** question: the commits with no tracker key in a message or a
  branch, asked about rather than judged, with no developer named.

Both carry a disclosure reading *How Compass resolved this* / *What Compass
compared*. Open it and you get the tier that actually resolved the verdict — the
chain of node ids, or the matched tracker key underlined in the branch it was found
in, or both compared texts with the score — plus the confidence and the threshold it
was measured against, always together. It is a native `<details>`, so it opens in one
click with JavaScript switched off.

`/goals`, linked from the report footer, is the chain those verdicts resolve
against. Every write there appends an effective-dated revision and leaves the prior
one on disk: edit an objective and the revision number beside it goes up, archive one
and it disappears from today's hierarchy while last week's report still resolves the
wording it was measured against. `GET /api/goals?at=<ISO instant>` answers "what was
Tuesday's report measured against". The rule in full is in
[ARCHITECTURE.md](ARCHITECTURE.md#effective-dating-and-the-freeze-rule).

## Verifying

```bash
pnpm run verify           # lint, architecture rules, typecheck, every test
```

The four gates, and what each one is actually for:

| Command | Enforces |
| --- | --- |
| `pnpm run lint` | The clock rules: no `Date.now()` below the process edge, `now` is always a parameter. Plus the analysis core's purity at the import site. |
| `pnpm run arch` | The layer order, as a dependency fact. `packages/analysis` may depend on nothing at all; nothing below the connector port may name the seed package. |
| `pnpm run typecheck` | The project-reference graph, the test suites, and `apps/web` under its own Next.js config. |
| `pnpm run test` | Every package's suite, including `tools/quality-gates` (which re-implements the clock and seed-isolation rules independently, so editing an ESLint glob cannot switch enforcement off) and `tools/smoke`. |

### The cold-start smoke test

```bash
pnpm run smoke            # against something already running on :3000
pnpm run smoke:docker     # docker compose up --build, then smoke
```

`@compass/smoke` fetches `/`, waits for a report inside a budget, and asserts all
six headings in the fixed order, at least one source link — which it then
**follows**, because a dead link satisfies "a link is present" and fails the
criterion the link exists for — and the absence of a login form, a setup wizard, an
empty state and any chart element.

The same function runs against the real rendered page in
`apps/web/tests/cold-start.test.tsx`. That pairing is deliberate: a smoke test that
checked something different from what the suite checks could be green while
asserting the wrong thing, and nobody would find out until they read the workflow
file.

## Other commands

| Command | What it does |
| --- | --- |
| `pnpm run build` | Builds the workspace packages, then `apps/web`. |
| `pnpm run seed:generate` | Expands `seed/fixtures/**` into `seed/generated/**` and `seed/MANIFEST.md`. Deterministic: CI fails if regenerating changes a byte. |
| `pnpm run cold-start` | Migrate, provision, generate today's report. Add `--force` to regenerate. |
| `pnpm run db:migrate` | Migrations only. |
| `pnpm run db:generate` | Writes a new migration from the Drizzle schema. |
| `pnpm run worker` | The pg-boss worker in the foreground. |

## Layout

```
apps/web        the report view and the HTTP surface (Server Components)
apps/worker     the pg-boss worker, plus the cold-start entry point
packages/       one package per layer, in dependency order:
                clock, connector-port, seed-connector, db,
                knowledge-model, ingest, analysis, renderers, pipeline
tools/          quality-gates, smoke, the ESLint plugin, the Docker entrypoint
seed/           fixtures (hand-edited) and generated/ (derived, checked in)
docs/           the brief, the architecture, the build plan
```

Two conventions are load-bearing. **Cross-package imports go through
`@compass/<pkg>`**, never a relative path into another package's `src` — `pnpm run
arch` enforces it. **Tests live in `<package>/tests/`** with shared builders under
`tests/helpers/`, and every package names its Vitest project after itself so
`pnpm test` output is attributable.

## Time

Nothing below the process edge reads a clock. `now` threads through as an explicit
parameter, and there are exactly two places allowed to construct one: the web
request edge (`apps/web/lib/report-source.ts`) and the worker. `packages/clock`
holds the single legal `Date.now()` in the repo, with one documented
`eslint-disable` that `tools/quality-gates` counts — so the exemption cannot
quietly spread.

Which report the seeded deployment is about — organization, team, timezone,
instant, both windows — is decided in one place, `resolveSeededRun` in
`@compass/seed-connector`. Both edges call it. If they each derived it, the boot
script and the first request would write two reports for what a manager thinks is
one day and race to overwrite each other.

---

This project was generated by **nous**, an autonomous development pipeline.
`.nous/` is pipeline session state and is not part of the product.
