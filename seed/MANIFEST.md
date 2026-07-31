# Seed manifest

**Generated file — do not edit.** Run `pnpm seed:generate` after changing anything under `seed/fixtures/`.

Dataset `northwind-v1` for Northwind Systems, organization `00000000-0000-4000-8000-000000000001`.

- Dataset window: `2026-05-18T00:00:00.000Z` → `2026-07-31T00:00:00.000Z` (half-open)
- One daily report covers: `2026-07-30T00:00:00.000Z` → `2026-07-31T00:00:00.000Z`
- The seeded `now`: `2026-07-31T09:00:00.000Z`
- Sources: `primary-code` (code), `primary-tracker` (tracker), `team-chat` (chat), `archive-code` (code, deliberately down)

## How to regenerate

The fixtures are the input and are hand-edited; everything under `seed/generated/` and this file are output.

- `seed/fixtures/organization.json`
- `seed/fixtures/people.json`
- `seed/fixtures/projects.json`
- `seed/fixtures/narrative.json`
- `seed/fixtures/pathologies.json`

Running the generator twice produces byte-identical files: there is no clock read, no `Math.random` and no
locale-sensitive comparison anywhere in the expansion. `pnpm seed:generate` followed by `git diff --exit-code`
is therefore a determinism check, and the test suite runs the equivalent in memory.

## Volume

| Requirement | Required | In this dataset | Met |
| --- | --- | --- | --- |
| Projects | 3 | 3 | yes |
| Developers | 12 | 12 | yes |
| Completed sprints | 4 | 10 | yes |
| In-flight sprints | 1 | 2 | yes |
| Commits | 600 | 913 | yes |
| Pull requests | 120 | 155 | yes |
| Issues | 300 | 382 | yes |
| Messages | 800 | 867 | yes |
| Conversations carrying messages | 3 | 4 | yes |
| Commits from unmapped git addresses | 5 | 9 | yes |

Record counts by artifact family, as the connector returns them:

| Artifact | Rows | File |
| --- | --- | --- |
| commits | 913 | `seed/generated/commits.json` |
| pull_requests | 155 | `seed/generated/pull_requests.json` |
| reviews | 299 | `seed/generated/reviews.json` |
| branch_refs | 160 | `seed/generated/branch_refs.json` |
| release_tags | 8 | `seed/generated/release_tags.json` |
| issues | 382 | `seed/generated/issues.json` |
| issue_transitions | 888 | `seed/generated/issue_transitions.json` |
| sprints | 12 | `seed/generated/sprints.json` |
| sprint_scope_changes | 18 | `seed/generated/sprint_scope_changes.json` |
| messages | 867 | `seed/generated/messages.json` |

Total: **3702** records across 3 projects, 3 teams, 4 repositories and 4 conversations.

## Objectives

| Key | Title | Current at `now` | Effective |
| --- | --- | --- | --- |
| `OBJ-CO-1` | Make Northwind the fastest way to take a payment on the web | yes | 2026-01-01T00:00:00Z → 2026-12-31T00:00:00Z |
| `OBJ-Q3-PLAT` | Cut p95 payment gateway latency below 400 ms | yes | 2026-07-01T00:00:00Z → 2026-09-30T00:00:00Z |
| `OBJ-Q3-CHK` | Ship guest checkout to every merchant | yes | 2026-07-01T00:00:00Z → 2026-09-30T00:00:00Z |
| `OBJ-Q3-INS` | Give merchants same-day settlement insight | yes | 2026-07-01T00:00:00Z → 2026-09-30T00:00:00Z |
| `OBJ-Q2-BILL` | Migrate every merchant off the legacy billing client | no | 2026-04-01T00:00:00Z → 2026-06-30T00:00:00Z |

## Fragmented identities

Every developer holds two or more git author emails, exactly one tracker account and exactly one chat handle.
Nothing in the dataset lets a consumer assume one address is one person.

| Developer | Git emails | Tracker account | Chat handle |
| --- | --- | --- | --- |
| `Priya Raman` | `priya.raman@northwind.example` `praman@platform.northwind.example` `priya@laptop.local` | `acct-priya-raman` | `user-priya-raman` |
| `Marcus Hale` | `marcus.hale@northwind.example` `mhale@platform.northwind.example` | `acct-marcus-hale` | `user-marcus-hale` |
| `Elena Sokolova` | `elena.sokolova@northwind.example` `esokolova@platform.northwind.example` `elena@devbox.local` | `acct-elena-sokolova` | `user-elena-sokolova` |
| `Tom Whitfield` | `tom.whitfield@northwind.example` `twhitfield@platform.northwind.example` | `acct-tom-whitfield` | `user-tom-whitfield` |
| `Aisha Bello` | `aisha.bello@northwind.example` `abello@platform.northwind.example` | `acct-aisha-bello` | `user-aisha-bello` |
| `Daniel Ortiz` | `daniel.ortiz@northwind.example` `dortiz@checkout.northwind.example` `danielo@mac.local` | `acct-daniel-ortiz` | `user-daniel-ortiz` |
| `Naomi Chen` | `naomi.chen@northwind.example` `nchen@checkout.northwind.example` | `acct-naomi-chen` | `user-naomi-chen` |
| `Rafael Lima` | `rafael.lima@northwind.example` `rlima@checkout.northwind.example` | `acct-rafael-lima` | `user-rafael-lima` |
| `Ingrid Falk` | `ingrid.falk@northwind.example` `ifalk@checkout.northwind.example` `ingrid@thinkpad.local` | `acct-ingrid-falk` | `user-ingrid-falk` |
| `Yusuf Demir` | `yusuf.demir@northwind.example` `ydemir@insights.northwind.example` | `acct-yusuf-demir` | `user-yusuf-demir` |
| `Clara Mbeki` | `clara.mbeki@northwind.example` `cmbeki@insights.northwind.example` | `acct-clara-mbeki` | `user-clara-mbeki` |
| `Oskar Lindqvist` | `oskar.lindqvist@northwind.example` `olindqvist@insights.northwind.example` | `acct-oskar-lindqvist` | `user-oskar-lindqvist` |

### Addresses that must land in the unmatched queue

These addresses author commits and belong to no developer. Attribution by name similarity is forbidden, which is
why one of them is a near-miss for a real person.

| Address | Commits | Why it is here |
| --- | --- | --- |
| `ci-bot@build.northwind.example` | 2 | The build robot's merge commits. Belongs to no person and never should. |
| `root@ip-10-0-4-27.internal` | 1 | A hotfix committed from a bastion host with an unconfigured git identity. |
| `contractor.jm@vendorlabs.example` | 2 | A contractor with no seat in the tracker or the chat workspace. |
| `p.raman@personal.example` | 1 | Looks like Priya Raman and is NOT linked to her. Attribution by name similarity is forbidden; this address exists to prove it. |
| `noreply@dependency-updater.example` | 2 | Automated dependency bumps. |
| `dev@localhost.localdomain` | 1 | A commit made before anyone ran `git config user.email`. |

## The Kanban team

Team `insights` (project `INS`) runs Kanban: it has **0 sprint rows**, and **0 of its 71 tickets carry story points**.

Sprint completion percentage, velocity and a sprint goal do not exist for this team, and the report must not
invent them. Alignment for its work resolves against the quarter objective instead.

## Planted pathologies

Each of these is planted deliberately and named here by the exact identifiers involved. A test resolves every
identifier below against a real row in the generated dataset.

### A billing-client migration stream running inside the current sprint

**id:** `off-goal-billing-migration`

3 tickets and 6 commits inside `Sprint 46` serve `OBJ-Q2-BILL`, an objective that stopped being current on 2026-06-30T00:00:00Z. The current objective for that team is `OBJ-Q3-PLAT`. Window 2026-07-27T00:00:00Z to 2026-07-31T00:00:00Z.

**Entities:** `PLAT-742`, `PLAT-743`, `PLAT-744`, `0f1a2b3`, `1f2a3b4`, `2f3a4b5`, `3f4a5b6`, `4f5a6b7`, `5f6a7b8`, `OBJ-Q2-BILL`, `OBJ-Q3-PLAT`, `Sprint 46`

### Every open platform review is queued behind one person

**id:** `review-bottleneck-marcus-hale`

7 open pull requests on `platform-api` all name `Marcus Hale` as the requested reviewer, the oldest opened 2026-07-20T10:05:00Z. Window 2026-07-20T00:00:00Z to 2026-07-31T00:00:00Z.

**Entities:** `Marcus Hale`, `#9101`, `#9102`, `#9103`, `#9104`, `#9105`, `#9106`, `#9107`, `PLAT-746`, `PLAT-747`, `PLAT-748`, `PLAT-749`, `PLAT-750`, `PLAT-751`, `PLAT-752`

### Release 2 slipped five days across a multi-day window

**id:** `release-slip-v4-2-0`

`v4.2.0` was planned for 2026-07-24T16:00:00Z and cut at 2026-07-29T17:20:00Z; `v4.2.0-rc.1` is the candidate that preceded it. The slip is tracked by `PLAT-745` and narrated day by day in the release conversation. Window 2026-07-24T00:00:00Z to 2026-07-30T00:00:00Z.

**Entities:** `v4.2.0`, `v4.2.0-rc.1`, `PLAT-745`

### Reported blocked in the morning, merged the same evening

**id:** `blocked-then-merged-CHK-701`

`CHK-701` carries the tracker's blocked flag from 2026-07-30T08:15:00Z and its pull request `#9201` merged at 2026-07-30T18:40:00Z — the same day. The merge commit is `7a8b9c0`; the claim of being blocked is in the checkout conversation at 2026-07-30T08:20:00Z.

**Entities:** `CHK-701`, `#9201`, `7a8b9c0`, `6a7b8c9`, `Sprint 17`

### Story points that have not tracked elapsed days for five sprints

**id:** `estimation-noise-plat`

14 completed tickets carry a story-point estimate and a measured elapsed duration whose Pearson correlation sits below the documented threshold of 0.3 at n ≥ 10, which is what a `points_uninformative` verdict is computed from.

**Entities:** `PLAT-760`, `PLAT-761`, `PLAT-762`, `PLAT-763`, `PLAT-764`, `PLAT-765`, `PLAT-766`, `PLAT-767`, `PLAT-768`, `PLAT-769`, `PLAT-770`, `PLAT-771`, `PLAT-772`, `PLAT-773`

### Marked Done with nothing in version control to show for it

**id:** `done-with-no-pull-request-INS-204`

`INS-204` transitions to Done at 2026-07-30T11:05:00Z with no pull request, no branch and no commit referencing it anywhere in the dataset.

**Entities:** `INS-204`

### Merged work sitting ahead of the newest release tag

**id:** `merged-not-released-platform-api`

3 pull requests merged into `platform-api` after `v4.2.0` was cut at 2026-07-29T17:20:00Z. The oldest unreleased item is `#9301`.

**Entities:** `v4.2.0`, `#9301`, `#9302`, `#9303`, `PLAT-753`, `PLAT-754`, `PLAT-755`, `8b9c0d1`, `9c0d1e2`, `0d1e2f3`

### A story estimated alongside its own estimated sub-tasks, and a ticket that entered In Progress and was never touched again

**id:** `process-hygiene-plat`

`PLAT-901` carries 8 points and its 2 sub-tasks carry 5 and 3, so a total spanning both levels counts it twice.
`PLAT-905` entered In Progress at 2026-07-22T10:00:00Z and sat for 7 working days with no commit and no pull request.
Negative controls: `PLAT-906` moved yesterday; `PLAT-907` is older but was committed to as `fa11ed7`.

**Entities:** `PLAT-901`, `PLAT-902`, `PLAT-903`, `PLAT-905`, `PLAT-906`, `PLAT-907`, `fa11ed7`

### Tech-debt tickets opened per sprint, rising for four sprints

**id:** `tech-debt-growth-plat`

Tickets labelled `tech-debt` opened per sprint: Sprint 43 → 2, Sprint 44 → 3, Sprint 45 → 4, Sprint 46 → 7. The count rises every sprint, which is the growth signal.

**Entities:** `Sprint 43`, `PLAT-781`, `PLAT-782`, `Sprint 44`, `PLAT-783`, `PLAT-784`, `PLAT-785`, `Sprint 45`, `PLAT-786`, `PLAT-787`, `PLAT-788`, `PLAT-789`, `Sprint 46`, `PLAT-790`, `PLAT-791`, `PLAT-792`, `PLAT-793`, `PLAT-794`, `PLAT-795`, `PLAT-796`

## Traceability classes

Commits are distributed across four classes on purpose. The resolution order is: a ticket key in the commit
message for a ticket that sits on a sprint with a goal (`structural`); a ticket key in the branch name only, or a
ticket with no goal chain (`inferred`); no key at all but wording that clears the documented Sørensen–Dice
threshold of `0.3` against a goal or objective (`semantic`); nothing (`unattributed`).

### Across the whole dataset

| Class | Commits | Share | Design target |
| --- | --- | --- | --- |
| `structural` | 497 | 54.4% | 55% |
| `inferred` | 227 | 24.9% | 25% |
| `semantic` | 107 | 11.7% | 12% |
| `unattributed` | 82 | 9.0% | 8% |

### Inside the single report window

All four resolution paths are exercised by one report, so the alignment section can never be tested against a
dataset that quietly avoids its hardest case.

| Class | Commits | Share |
| --- | --- | --- |
| `structural` | 14 | 53.8% |
| `inferred` | 4 | 15.4% |
| `semantic` | 3 | 11.5% |
| `unattributed` | 5 | 19.2% |

## Generated files

- `seed/generated/commits.json`
- `seed/generated/pull_requests.json`
- `seed/generated/reviews.json`
- `seed/generated/branch_refs.json`
- `seed/generated/release_tags.json`
- `seed/generated/issues.json`
- `seed/generated/issue_transitions.json`
- `seed/generated/sprints.json`
- `seed/generated/sprint_scope_changes.json`
- `seed/generated/messages.json`
- `seed/generated/dataset.json`
- `seed/generated/manifest.json`
- `seed/MANIFEST.md`
