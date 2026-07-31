# Engineering — How this project is built

This project was built by **nous**, an autonomous development pipeline modelled on how
the best-run engineering organisations operate. These are the principles its agents work
under — and a good baseline for anyone continuing the project.

## Operating principles

- **Work backwards from the user.** Start from the outcome and who it's for (Amazon's
  working-backwards). Features exist to serve a real user need, stated plainly.
- **Design before code.** Architecture and (for anything user-facing) a design brief are
  written and agreed before implementation — decisions are made on purpose, not by accident.
- **One owner per piece.** Every task has a single directly-responsible agent; reviews are
  done by a *different* agent than the author (separation of build and check).
- **Improvement over perfection.** Code review approves work that genuinely improves the
  product and meets the task's acceptance criteria; it flags real bugs, not stylistic nits or
  speculative future-proofing. Solve today's known problem, not an imagined one.
- **Current and non-deprecated.** Use the modern, recommended APIs for each library's current
  major version — never legacy "old way" patterns.
- **Ship real, working software.** No stubs, TODOs, or mocked returns standing in for the
  implementation the acceptance criteria require. The code runs.
- **Craft is part of the spec.** For user-facing work, "beautiful and polished" is a
  requirement, not a nice-to-have. Consistency comes from shared design tokens, not ad-hoc styles.
- **Make assumptions visible.** When the spec leaves a decision open, pick the most reasonable
  option that fits existing conventions and state the assumption — never silently guess.
- **Verify, then trust.** The assembled product is installed, built, and tested before it's
  considered done; failures are fixed, not papered over.

## Roles in the build

- **Discovery / PM** — turns the idea into a precise spec and a phased plan.
- **Architect** — designs the system and picks the (current, proven) tech stack.
- **Designer** — for user-facing products, authors the design brief (see `docs/DESIGN.md`).
- **Coders** — fixed general coder + per-domain specialists, each with project context.
- **Reviewer** — an independent, skeptical check on every task (anti-hallucination).
- **Verifier / QA** — runs tests, linting and builds across the assembled product.
- **Team Lead** — unblocks stuck loops and decides strategy before escalating.
