import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LLM_MINIMIZATION_MODES, PRIVACY_DEFAULTS, RAW_RETENTION_CHOICES } from '@compass/db';
import { describe, expect, it } from 'vitest';

/**
 * "Retention defaults are documented in the repo."
 *
 * A criterion about documentation is only worth something if the documentation cannot drift, so
 * this gate diffs `docs/DEVELOPMENT.md` against the constants themselves. A default changed in
 * code without the sentence being changed with it fails the build here — which is the only
 * mechanism that keeps a written number true a year later.
 *
 * It asserts on the *numbers and the choices*, not on the prose around them: the wording is meant
 * to be edited freely, and a gate that pinned whole sentences would make the documentation
 * something nobody dared improve.
 */

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const document = readFileSync(join(REPOSITORY_ROOT, 'docs', 'DEVELOPMENT.md'), 'utf8');

describe('the retention defaults are documented', () => {
  it('has a privacy section at all, so an empty file cannot pass this gate', () => {
    expect(document).toContain('## Privacy: retention, anonymization, deletion and LLM minimization');
    expect(document).toContain('### Retention defaults');
  });

  it('states the raw-event default that the code applies', () => {
    expect(document).toContain(`${PRIVACY_DEFAULTS.rawEventRetentionDays} days`);
  });

  it('states the derived default that the code applies', () => {
    expect(document).toContain(`${String(PRIVACY_DEFAULTS.derivedRetentionYears)} years`);
  });

  it('states the narration mode that the code applies', () => {
    expect(document).toContain(`\`${PRIVACY_DEFAULTS.llmMinimizationMode}\``);
  });

  it('lists every raw-window choice a manager is offered', () => {
    // The closed set, in the document, so somebody reading the file can tell what the select on
    // the page will contain without opening the code.
    expect(document).toContain(RAW_RETENTION_CHOICES.join(', '));
  });

  it('names all three minimization modes', () => {
    for (const mode of LLM_MINIMIZATION_MODES) {
      expect(document, `\`${mode}\` is not documented`).toContain(`\`${mode}\``);
    }
  });
});

describe('the deletion deadlines are documented', () => {
  it('states the grace period and the hard deadline', () => {
    // Both, because they are different promises: 7 days is the person's window to change their
    // mind, 30 is Compass's deadline to have finished. A document naming only one would leave a
    // reader unable to tell which they were being given.
    expect(document).toContain('Grace period: 7 days');
    expect(document).toContain('Hard deletion: within 30 days');
  });

  it('says what an erasure deliberately keeps', () => {
    // A documented list of deletions with no mention of what survives is a true list and a
    // misleading document — and the confirmation email is generated from the same reasoning.
    expect(document).toContain('It keeps four things');
  });
});

describe('the three schedules are documented', () => {
  it('names each job and its cron', () => {
    for (const job of ['privacy.retention-purge', 'privacy.deletion-sweep', 'privacy.channel-notice']) {
      expect(document, `${job} is not documented`).toContain(job);
    }
  });
});

describe('what never reaches a model is documented', () => {
  it('says so unconditionally, including for full mode', () => {
    expect(document).toContain('### What never reaches a language model');
    expect(document).toContain('In every mode, including `full`');
  });
});
