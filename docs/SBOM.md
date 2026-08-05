# Software bill of materials

Compass publishes the complete dependency inventory of every build as a CycloneDX document. This page is
the retrieval process referenced from [the legal index](../apps/web/app/legal/page.tsx) and from the
`AUTOMATED_DECISIONS`/trust content in `packages/trust`: a controller asking "what is in this thing" gets a
named artifact and a route to it rather than an assurance.

## What is produced, and where

| | |
| --- | --- |
| **Artifact name** | `compass-sbom` |
| **Files inside it** | `compass-sbom.cdx.json` (CycloneDX 1.5), `sbom-tree.json` (the raw `pnpm list` graph it was derived from) |
| **Retention** | 90 days from the run that produced it |
| **Produced by** | the `sbom` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), on every push and pull request |
| **Generator** | [`tools/sbom.mjs`](../tools/sbom.mjs) — no third-party SBOM tool in the chain |
| **On request** | `trust@compass.example` (`TRUST_CONTACT` in `packages/trust/src/content.ts`) |

## Retrieving it

**If you have repository access.** Open the CI run you care about — usually the one for the commit that
built the release — and download the `compass-sbom` artifact from the run summary. Or, with the GitHub CLI:

```bash
gh run download <run-id> --name compass-sbom
```

To get the SBOM for whatever is currently on `master`:

```bash
gh run list --branch master --workflow ci.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh run download <that-id> --name compass-sbom
```

**If you do not have repository access.** Ask `trust@compass.example`. State the release or the date you
need the inventory for, because the answer differs between builds and we will send the document for the
build you actually run rather than the newest one. Expect a reply within five working days; there is no NDA
requirement for the SBOM itself.

**Reproducing it locally.** The generator reads stdin, so it needs no network beyond the install:

```bash
pnpm install --frozen-lockfile
pnpm list --recursive --depth Infinity --json > sbom-tree.json
node tools/sbom.mjs < sbom-tree.json > compass-sbom.cdx.json
```

A local run against the same lockfile produces a byte-identical document to CI's — see *Determinism* below.

## What is in scope

Every dependency at every depth, **production and development alike**, taken from the installed tree
(`pnpm list --depth Infinity`) rather than from the version ranges declared in `package.json`. Two
consequences worth stating plainly, because they are the questions the document gets asked:

- **Transitive dependencies are included.** An inventory generated from manifests would list the couple of
  hundred packages somebody chose and omit the several hundred that arrived with them, which is the half
  that a CVE announcement is usually about.
- **Build-time dependencies are included.** A compromised bundler, test runner or codegen tool reaches the
  shipped artifact as surely as a runtime dependency does. `--prod` would have produced a shorter document
  that answered the easy half of the question, so it is deliberately absent.

Each component carries two Compass-specific properties:

- `compass:workspace` — `true` for the repository's own packages (`@compass/*`), which are recorded rather
  than dropped so a reader tracing "what is in this image" does not have to guess why they are missing.
  These are given the sentinel version `0.0.0-workspace` and no purl, because a workspace link resolves to
  a path and has no meaningful published version.
- `compass:scope` — `runtime` or `build`, reflecting which dependency map the package was first reached
  through.

The current document is on the order of 750 components, of which roughly 30 are workspace packages.

## Determinism

The document contains **no `metadata.timestamp`**. This is a deliberate omission: a timestamp makes two
SBOMs of an identical dependency graph differ, which destroys the most useful thing you can do with two of
them, namely

```bash
diff <(jq -S .components old-sbom.cdx.json) <(jq -S .components new-sbom.cdx.json)
```

Components are sorted by name and then version using byte-order comparison (not `localeCompare`, which is
locale-sensitive), and each component appears once however many paths in the graph reach it. The build that
produced a given document is identified by the CI run holding the artifact, which is a stronger provenance
claim than a self-reported clock reading inside the file.

## Failure behaviour

`tools/sbom.mjs` exits non-zero and writes nothing to stdout when its input cannot be parsed, and also when
the walk finds zero components. The second check exists because **an empty bill of materials is
indistinguishable from a clean one** — a scanner handed a document with no components reports no
vulnerabilities. A missing SBOM is a visible failure; an empty one is a silent false assurance.

The `sbom` job is not a required gate. It publishes an inventory; it does not judge it. The judging happens
in `gate: dependency scan (critical CVE with a fix blocks)`, which fails the build on a critical advisory
that has a published fix, and in the nightly container image scan.

## Related

- [`docs/ENGINEERING.md`](ENGINEERING.md) — the gates, including the dependency and secret scans
- `packages/trust/src/content.ts` — the published subprocessor list and policy documents
- [`docs/budgets.md`](budgets.md) — the numbered performance budgets enforced in CI
