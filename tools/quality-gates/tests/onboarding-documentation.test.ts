import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NON_SEMANTIC_REPORT_FIELDS } from '@compass/analysis';
import {
  DEMO_ACCOUNT_LOGIN_PATH,
  DEMO_OWNER_EMAIL,
  GENERATED_PASSWORD_BYTES,
  OWNER_EMAIL_ENV_VAR,
  OWNER_PASSWORD_ENV_VAR,
} from '@compass/auth';
import { COLD_START_BUDGET_MILLIS } from '@compass/smoke';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './helpers/workspace.js';

/**
 * The onboarding documents, diffed against the code they describe.
 *
 * ## Why this gate exists at all
 *
 * Every *other* claim these documents make already had one — `budget-table.test.ts` for the numbers,
 * `privacy-documentation.test.ts` for the retention defaults, `security-posture.test.ts` for the
 * headers. `README.md` and the golden-fixture workflow had none, and the consequence showed up
 * exactly as you would predict: the four onboarding documents were once reverted to their generated
 * template — `README.md` from 188 lines to 59, `docs/DEVELOPMENT.md` from 375 to 25 — and **83
 * assertions in this directory went red at once**, none of which were about the README. The cold
 * start, the credentials and the golden workflow were simply gone, and nothing failed for them.
 *
 * So this file covers the three things a person needs on their first hour with the repository, and
 * covers them the way the other gates do: against imported constants and against files on disk,
 * never against a second copy of the same prose.
 *
 * ## The truncation guard is deliberate, and it is first
 *
 * A gate made only of `toContain` calls passes on a document that has been *cut down* to just the
 * phrases it looks for, and fails only once someone deletes the right sentence. The structural
 * assertions — the document is of a plausible size, and every heading a reader navigates by is
 * present — are what make the content assertions mean something.
 */

const readDoc = (relativePath: string): string => {
  const path = join(REPO_ROOT, relativePath);
  expect(existsSync(path), `${relativePath} does not exist`).toBe(true);
  return readFileSync(path, 'utf8');
};

const README = readDoc('README.md');
const DEVELOPMENT = readDoc('docs/DEVELOPMENT.md');

/** Root `package.json` scripts, so a documented command is checked to be a real one. */
const ROOT_SCRIPTS: Readonly<Record<string, string>> = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
).scripts;

describe('the onboarding documents are whole', () => {
  /**
   * Lower bounds, not exact sizes. The point is to distinguish a document from its own stub: the
   * template `README.md` was 59 lines and the template `DEVELOPMENT.md` was 25, so a floor set
   * comfortably above those catches a revert while leaving normal editing alone.
   */
  it.each([
    ['README.md', README, 150],
    ['docs/DEVELOPMENT.md', DEVELOPMENT, 200],
  ])('%s has not been truncated to its template', (_label, contents, minimumLines) => {
    expect(contents.split('\n').length).toBeGreaterThan(minimumLines);
  });

  it('README.md still has the sections a first-time reader navigates by', () => {
    for (const heading of ['## Getting started', '### Signing in', '### The three guarantees']) {
      expect(README, `README.md lost "${heading}"`).toContain(heading);
    }
  });

  it('docs/DEVELOPMENT.md still has its own', () => {
    for (const heading of ['## Running & verifying', '## Project layout', '## Golden fixtures']) {
      expect(DEVELOPMENT, `docs/DEVELOPMENT.md lost "${heading}"`).toContain(heading);
    }
  });

  it('describes this workspace rather than a generic Node or Python project', () => {
    // The template offered `python -m pip install -r requirements.txt` and `npm install` as the
    // options. Both are wrong here, and the second is wrong in the way that costs an afternoon:
    // npm installs a tree in which no workspace import resolves.
    expect(DEVELOPMENT).toContain('pnpm install');
    expect(DEVELOPMENT).not.toContain('requirements.txt');
    expect(DEVELOPMENT).not.toMatch(/^\s*-\s*Node:\s+`npm install`/m);
  });
});

describe('the cold start is documented as one command with its expected result', () => {
  it('names the one command', () => {
    expect(README).toContain('docker compose up');
    expect(existsSync(join(REPO_ROOT, 'docker-compose.yml'))).toBe(true);
  });

  it('states the under-60-second expectation, in the seconds the budget actually allows', () => {
    /**
     * Derived from `COLD_START_BUDGET_MILLIS` rather than typed as "60". This is the assertion that
     * catches the drift that matters: the budget is raised or lowered in `tools/smoke`, every test
     * still passes because they all import the constant, and the README goes on promising the old
     * number to the one audience that cannot check it.
     */
    const seconds = COLD_START_BUDGET_MILLIS / 1000;
    expect(README).toMatch(new RegExp(String.raw`under ${seconds}[\s-]seconds?`, 'i'));
  });

  it('promises a rendered report at the end of it, not a running process', () => {
    expect(README).toContain('http://localhost:3000');
    expect(README.toLowerCase()).toMatch(/no login wall/);
  });

  it('documents the seed as the non-Docker equivalent, and the script exists', () => {
    expect(README).toContain('pnpm run seed');
    expect(ROOT_SCRIPTS).toHaveProperty('seed');
  });
});

describe('the demo credentials are documented where they actually are', () => {
  it('names the owner address the bootstrap defaults to', () => {
    expect(README).toContain(DEMO_OWNER_EMAIL);
  });

  it('names both owner variables, since setting one is a refusal', () => {
    expect(README).toContain(OWNER_EMAIL_ENV_VAR);
    expect(README).toContain(OWNER_PASSWORD_ENV_VAR);
  });

  it('does not print a password value in the credentials table', () => {
    /**
     * The check on the drift that actually happened. `@compass/auth` used to export a working owner
     * password as a literal; when it was replaced by `generateOwnerPassword`, the README went on
     * publishing the old value in a table — documentation that was not merely stale but a wrong
     * credential, for the one reader who has no other source.
     *
     * So the row is parsed rather than the file searched: whatever the Password cell says, it has to
     * point at the variable or at the generator, and cannot be a value.
     */
    const row = README.split('\n').find((line) => /^\|\s*Password\s*\|/.test(line));
    expect(row, 'the credentials table has no Password row').toBeDefined();
    expect(row).toContain(OWNER_PASSWORD_ENV_VAR);
    expect(row, 'the Password row names no mechanism for an unconfigured deployment').toMatch(
      /random|generated|minted/i,
    );
  });

  it('states how many bytes an unconfigured deployment generates', () => {
    expect(README).toContain(String(GENERATED_PASSWORD_BYTES));
  });

  it('names the file a harness reads, and that file is the one the worker writes', () => {
    const writer = readFileSync(join(REPO_ROOT, 'apps/worker/src/demo-account.ts'), 'utf8');

    // Both halves, because the criterion is that the *location* is documented: the README names a
    // path, and the writer is checked to be the module that puts a file there under that name.
    expect(README).toContain('.nous/demo_account.json');
    expect(writer).toContain("DEMO_ACCOUNT_DIRECTORY_NAME = '.nous'");
    expect(writer).toContain("DEMO_ACCOUNT_FILE_NAME = 'demo_account.json'");
  });

  it('names the path those credentials are posted to', () => {
    expect(README).toContain(DEMO_ACCOUNT_LOGIN_PATH);
  });
});

describe('the three guarantees name their allowlist and their enforcing tests', () => {
  it('lists every non-semantic field the determinism gate excludes', () => {
    // The allowlist is the part of the determinism claim a reader is entitled to see in full: a
    // guarantee with an undisclosed set of exceptions is not one.
    for (const field of NON_SEMANTIC_REPORT_FIELDS) {
      expect(README, `the determinism allowlist in README.md omits ${field}`).toContain(field);
    }
    expect(README).toContain('NON_SEMANTIC_REPORT_FIELDS');
  });

  it('names where the allowlist is declared, and it is declared there', () => {
    expect(README).toContain('packages/analysis/src/determinism.ts');
    expect(readFileSync(join(REPO_ROOT, 'packages/analysis/src/determinism.ts'), 'utf8')).toContain(
      'export const NON_SEMANTIC_REPORT_FIELDS',
    );
  });

  it('documents the grounding rule, and the corpus gate it names exists', () => {
    expect(README.toLowerCase()).toContain('grounding');
    expect(README).toContain('tools/quality-gates/tests/grounding-corpus.test.ts');
    expect(DEVELOPMENT).toContain('## Narration and grounding');
  });

  /**
   * Every test path the README cites is resolved on disk. A guarantee whose "enforced by" column
   * names a file that was renamed is indistinguishable, to a reader, from one that is not enforced —
   * and this is the same check `budget-table.test.ts` makes on the owning-test column.
   */
  it.each(
    [...README.matchAll(/`((?:packages|apps|tools)\/[\w./-]*tests?\/[\w./-]+\.test\.[cm]?tsx?)`/g)].map(
      (match) => [match[1]!] as const,
    ),
  )('%s, cited by README.md, exists', (path) => {
    expect(existsSync(join(REPO_ROOT, path)), `README.md cites ${path}, which is not on disk`).toBe(
      true,
    );
  });

  it('found citations to check, so an empty match cannot pass the assertion above', () => {
    expect(
      [...README.matchAll(/`((?:packages|apps|tools)\/[\w./-]*tests?\/[\w./-]+\.test\.[cm]?tsx?)`/g)]
        .length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('points at the budgets document for the numbers rather than restating them', () => {
    expect(README).toContain('docs/budgets.md');
    expect(existsSync(join(REPO_ROOT, 'docs/budgets.md'))).toBe(true);
  });
});

describe('the golden-fixture workflow is documented with its review workflow', () => {
  it.each([['test:golden'], ['golden:update']])(
    '%s is documented and is a real root script',
    (script) => {
      expect(README, `README.md does not mention ${script}`).toContain(script);
      expect(DEVELOPMENT, `docs/DEVELOPMENT.md does not mention ${script}`).toContain(script);
      expect(ROOT_SCRIPTS, `${script} is documented but not a root script`).toHaveProperty(script);
    },
  );

  it('README links to the review workflow, and the anchor it links to exists', () => {
    expect(README).toContain('docs/DEVELOPMENT.md#golden-fixtures');
    // GitHub derives `#golden-fixtures` from this heading. If the heading is renamed the link
    // silently lands at the top of the page, which is the failure a reader cannot see.
    expect(DEVELOPMENT).toContain('## Golden fixtures');
  });

  it('the review workflow says what to actually do with a diff', () => {
    /**
     * Four steps, because "regenerates a reviewable diff" is a description of a command and not a
     * workflow. What a reviewer needs is the command to read the diff, the instruction to read it at
     * all, the blast-radius check, and the separate-commit rule — the last being the one that keeps
     * forty rewritten fixtures from riding along inside a detector change nobody can review.
     */
    expect(DEVELOPMENT).toContain('git diff -- fixtures/');
    expect(DEVELOPMENT.toLowerCase()).toMatch(/separately|separate commit/);
    expect(DEVELOPMENT.toLowerCase()).toMatch(/blast radius/);
    expect(DEVELOPMENT.toLowerCase()).toMatch(/only ever written by|only ever rewritten/);
  });

  it('describes the fixture layout the golden tool actually writes', () => {
    expect(DEVELOPMENT).toContain('fixtures/reports/');
    expect(existsSync(join(REPO_ROOT, 'fixtures/reports'))).toBe(true);
  });
});
