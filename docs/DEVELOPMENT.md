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

### The confidence collar, and the notches

Under the six sections sits the **confidence collar**: the projected completion date once,
in square brackets, in mono — and two lines beneath it that are allowed to undercut it. Line
one is the band and the method; line two is the calibration verdict in the product's own
voice. When the audit has anything to say, the date itself is set in a lighter weight, so the
typography loses conviction along with the prose.

Beneath it, the **Process Calibration Audit**: seven statistics about whether the data behind
this report means anything, and the six named verdicts they can produce. The seeded platform
team reaches four of them, and the projected date is a cycle-time guess because of one of
those four. That is what the collar is for.

Every **01 Yesterday** line ends in the furthest rung it reached *and the next one it has
not* — `merged, not yet released` — followed by the five-notch meter. The fifth notch is
hollow and reads `no deploy signal available`, because with no CI/CD connector Compass cannot
know, and inferring a deploy from a merge would be the most damaging thing it could say.

Both differentiators, their statistics, their rung detectors and **every threshold as a
number** are documented in [CALIBRATION.md](CALIBRATION.md).

`/goals`, linked from the report footer, is the chain those verdicts resolve
against. Every write there appends an effective-dated revision and leaves the prior
one on disk: edit an objective and the revision number beside it goes up, archive one
and it disappears from today's hierarchy while last week's report still resolves the
wording it was measured against. `GET /api/goals?at=<ISO instant>` answers "what was
Tuesday's report measured against". The rule in full is in
[ARCHITECTURE.md](ARCHITECTURE.md#effective-dating-and-the-freeze-rule).

## Signing in, and the first owner

The report on `/` needs no account, and that is not a shortcut — it is the product's
zero-config promise, and the role matrix carries an explicit `public` entry for the
route so it is a stated rule rather than a gap. Everything *else* needs a seat: a seat
is a role and a set of teams, and the teams decide which reports you can read at all.

### The account you already have

`pnpm run seed` and `docker compose up` both create the first owner, because seats are
invite-only and only an owner can grant the owner role — an organisation with no owner
would have no way in. Unset, it uses the published demonstration credentials, and the
boot log prints them:

```
[compass] owner seat created: owner@compass.demo, scoped to platform, checkout, insights.
          Using the published demonstration password — set COMPASS_OWNER_EMAIL and
          COMPASS_OWNER_PASSWORD before this deployment holds real data.
```

They are on `/account` too, with a button that fills the form, so a reviewer never has
to go looking in a log. For as long as they are in use, `/api/health` reports
`seats: not_configured` — a deployment on a published password must not be able to look
healthy. Setting `COMPASS_OWNER_EMAIL` and `COMPASS_OWNER_PASSWORD` in `.env` is the
whole of changing it; the boot script never overwrites a password you have since
changed from inside the product.

### The three ways in

`/account`, reachable from the report footer and never imposed on the way to it:

- **Email and password.** Argon2id, 12-character floor, no composition rules.
- **An emailed link**, good for **15 minutes** and one use.
- **A reset link**, good for **1 hour** and one use. Setting a password ends every other
  session on the account — someone resetting usually believes somebody else has it.

No mail transport is configured yet (`alpha-delivery-email-and-slack` owns that), so
every link is written to the process log and an invitation's link is also returned in
the response and shown on `/seats`. Nothing is silently dropped, and `/api/health` says
where mail is going.

### Seats

`/seats` is owner and manager. A manager gets the same list with no controls and a
sentence saying so — showing them an empty screen would read as a broken feature.

| role | what it can do |
| --- | --- |
| owner | Everything: seats, roles, the audit log, configuration. There is always at least one — the last one cannot be demoted or removed. |
| manager | Reads their scoped teams' reports and edits the goal hierarchy, because a manager who cannot correct the objective their work is measured against cannot argue with an alignment verdict. Sees the seat list, read-only. |
| member | Reads their scoped teams' reports. |
| viewer | Reads, and nothing else. |

Invitations expire in **7 days** and work once. Resending revokes the previous link, so
there is never more than one that works — which is what makes revoking meaningful.
Changing a role or a team scope **rotates that person's sessions**, so the new access is
in force on their next request rather than whenever their cookie happens to expire.

Owners are unscoped by design. Every other role needs at least one team scope row, and a
seat with none reads nothing rather than everything — the safe direction for that mistake
to fall. Asking for a team you are not scoped to is a `403` naming the team, not a `404`
pretending it does not exist.

Every privileged act — invite, resend, revoke, role change, scope change, removal,
password change, sign-out-everywhere — writes an `AuditLogEntry` with the actor, the
target and the before/after states. `GET /api/audit` reads it, owner only. It is
append-only in the application layer, in a database trigger, and in the absence of any
repository function that could rewrite it.

Sessions end **30 days** after they begin however often they are used, and after **14
days** without use. `/account` lists every device with its dates and reasons, and
"sign out everywhere" ends the lot. The numbers, and why each is what it is, are in
[ARCHITECTURE.md](ARCHITECTURE.md#sessions-tokens-and-the-four-role-matrix).

## Narration and grounding

Narration is off unless `ANTHROPIC_API_KEY` is set, and a deployment without it is
not degraded: the deterministic template renderer produces complete, correct
six-section reports, and the page footer says which renderer wrote it.

With a key set, the pipeline gains one stage after `render`. Each of the six
sections is sent to Claude **on its own**, carrying nothing but the projected
section payload — headlines, details, evidence *labels*, counts, ages, ladder rungs
and alignment verdicts. It never carries a commit message, a pull request body, a
tracker comment or a chat message; `packages/narrator/src/payload.ts` names every
field that travels and `assertNoRawIngestedText` fails the build if a raw-text field
is ever added to the shape. The request has no `tools` key, no MCP servers and no
container, so the narrator cannot search, fetch, read or run anything — the only
network egress is the one POST to the Messages endpoint.

The narrator may choose emphasis, the order of items within its section, and the
wording. It may not originate a fact. Every quantity, percentage, date, pull request
number, commit revision, tracker key, objective key and person name in the returned
prose is extracted and compared against the payload that was sent.

**N is 3.** A section that fails grounding is regenerated from the identical prompt
up to three times in total. If the third attempt is still rejected — or if the model
refuses, times out, or returns markup — **the whole report** renders through the
template renderer, `reports.fallback_renderer` is set with a `fallback_reason`, and
the page discloses it above the report in the product's own voice. The constant is
`NARRATION_MAX_ATTEMPTS` in `packages/narrator/src/narrate.ts`; a test asserts it
equals the number written here.

The fallback is whole-report rather than per-section on purpose. Keeping five
narrated sections and substituting the sixth would change the document's voice
halfway down with nothing on the page saying where, and a reader could not tell which
prose had been validated against what.

Every attempt writes a `narration_traces` row: the model, the prompt version, a
sha256 of the exact prompt, the attempt number, the outcome, and — on a rejection —
the tokens it named. That is the audit trail behind the claim that the model
originated nothing.

```bash
pnpm --filter @compass/narrator test          # the port, the prompt, the validator
pnpm --filter @compass/quality-gates test     # grounding over the whole seeded corpus
```

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
