import { describe, expect, it } from 'vitest';

import { allAuthoredSourceFiles, codeWithoutComments, type SourceFile } from './helpers/workspace.js';

/**
 * One derivation for every report item id, enforced by scanning the analysis core.
 *
 * ## Why this is a gate rather than a convention
 *
 * Every detector used to build its own id by hand — `` `blocker:ticket:${key}:${signal}` ``,
 * `` `risk:developer:${key}:review_bottleneck` ``, `'alignment:unattributed:commits'` — twenty-four
 * templates across eight modules. That is not a tidiness problem. A report item's id is what every
 * feedback action is keyed on: a dismissal, a snooze, a correction, the "day 6" counter and the
 * change tag all look the condition up by id. Two schemes means feedback recorded against one id
 * cannot match the item rendered under the other, so a manager dismisses a finding and it returns
 * the next morning with no explanation.
 *
 * The templates also carried no tenant, so two organizations with a ticket called `DEV-1` stalled
 * for the same reason produced *the same id* — one manager's dismissal suppressing another
 * organization's finding.
 *
 * So the rule is: ids come from `stableItemId`, and a detector that writes its own is a build
 * failure rather than a review comment. This gate is what makes the twenty-fourth conversion stick.
 */

const ANALYSIS_SOURCES: readonly SourceFile[] = allAuthoredSourceFiles().filter(
  (file) => file.relativePath.startsWith('packages/analysis/src/') && !file.relativePath.endsWith('.test.ts'),
);

describe('every report item id comes from one derivation', () => {
  it('finds the analysis core at all, so an empty scan cannot pass this file', () => {
    expect(ANALYSIS_SOURCES.length).toBeGreaterThan(20);
    expect(ANALYSIS_SOURCES.map((file) => file.relativePath)).toContain('packages/analysis/src/identity.ts');
  });

  it('has no hand-built `stableId` literal anywhere in the analysis core', () => {
    // Code, not prose: the doc comments in `identity.ts` and in this gate quote the old templates in
    // order to explain what they replaced, and a scan of raw text would be failed by its own
    // explanation. Same reasoning as the roster single-writer gate.
    const offenders = ANALYSIS_SOURCES.filter((file) => {
      const code = codeWithoutComments(file);
      // `stableId:` followed by a template literal or a quoted string — either is a hand-built id.
      return /stableId:\s*(`|'|")/.test(code);
    }).map((file) => file.relativePath);

    expect(
      offenders,
      'these modules build a report item id by hand. Ids must come from `stableItemId({ organizationId, ' +
        'entityRef, causeKind })` — every feedback action is keyed on that id, and a second scheme means a ' +
        "dismissal recorded against one id cannot match the item rendered under the other.",
    ).toEqual([]);
  });

  it('assigns `stableId` only from the derivation', () => {
    // The positive form of the same rule: every assignment names `stableItemId`, spreads
    // `identifyItem(...)`, or passes through an id a detector already derived. This catches an id
    // built by a helper whose call would not match the literal scan above.
    //
    // There is no longer an exemption. The Progress section's four ids used to come from a frozen
    // `PROGRESS_ITEM_IDS` map of `progress:velocity`-style strings — a single derivation point, but
    // one carrying no `organizationId`, so two organizations' velocity items shared one id and a
    // dismissal of one would have suppressed the other's. They now go through `stableItemId` like
    // everything else, keyed on a `progress` pseudo-entity and a `PROGRESS_CAUSE_KINDS` cause, and
    // the renderer joins on the *cause kind* rather than on a magic id string.
    const offenders: string[] = [];

    for (const file of ANALYSIS_SOURCES) {
      if (file.relativePath.endsWith('/identity.ts')) continue;

      const code = codeWithoutComments(file);
      // Not preceded by `readonly`: an interface's `readonly stableId: string;` is a *declaration*,
      // not an assignment, and flagging it would make the gate fail on the very types it protects.
      for (const match of code.matchAll(/(?<!readonly )stableId:\s*([^,\n]*)/g)) {
        const assigned = (match[1] ?? '').trim();
        if (assigned.length === 0) continue;
        // A type position rather than a value (`stableId: string;` in a constructor signature).
        if (/^string;?$/.test(assigned)) continue;
        if (assigned.startsWith('stableItemId(')) continue;
        // A pass-through of an id a detector already derived (`blocker.stableId`).
        if (/^[\w.?[\]']+$/.test(assigned)) continue;
        offenders.push(`${file.relativePath}: stableId: ${assigned}`);
      }
    }

    expect(offenders, 'these assignments do not come from `stableItemId`').toEqual([]);
  });

  it('has no id scheme left that is not the derivation', () => {
    // The exemption's replacement. `PROGRESS_ITEM_IDS` was the last one; this fails the day it — or
    // anything shaped like it — comes back, rather than leaving a permissive regex behind that
    // nobody remembers granting.
    const offenders = ANALYSIS_SOURCES.filter((file) => /PROGRESS_ITEM_IDS/.test(codeWithoutComments(file))).map(
      (file) => file.relativePath,
    );

    expect(
      offenders,
      'PROGRESS_ITEM_IDS is a second identity scheme carrying no tenant. Ids come from `stableItemId`.',
    ).toEqual([]);
  });

  it('carries the cause beside every id, so feedback can be keyed on the condition', () => {
    // The half of the scheme that makes feedback durable. A dismissal is recorded against
    // `(entityRef, causeKind, causeDiscriminator)` — not against the `v1:` digest, which is a
    // function of `STABLE_ID_VERSION` and would orphan every dismissal the day that moved.
    const identity = ANALYSIS_SOURCES.find((file) => file.relativePath.endsWith('/identity.ts'));
    const code = codeWithoutComments(identity!);

    expect(code, 'the three tenant-independent coordinates must be a named type').toContain(
      'export interface ItemCause',
    );
    expect(code, 'a detector must be able to emit the id and the cause in one call').toContain(
      'export const identifyItem',
    );
  });

  it('derives the id pattern from the version constant, so a bump is one line', () => {
    const identity = ANALYSIS_SOURCES.find((file) => file.relativePath.endsWith('/identity.ts'));
    const code = codeWithoutComments(identity!);

    // A hard-coded `/^v1:/` would leave the validator rejecting every id the same file had just
    // minted the day the version moved.
    expect(code).toContain('new RegExp(`^${STABLE_ID_VERSION}');
    expect(code, 'the pattern must not spell the version a second time').not.toMatch(/STABLE_ID_PATTERN = \/\^v\d/);
  });
});
