import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppendOnlyTableError, corrections as correctionsTable, entityVersions } from '@compass/db';
import {
  believedBlocked,
  describeCorrection,
  detectBlockedButMerged,
  detectDoneButReopened,
  recordContradiction,
} from '@compass/knowledge-model';

import { at, createStoreHarness, ticketFields, type StoreHarness } from './helpers/store.js';

/**
 * Corrections: the product admitting it told you something that turned out to be
 * false. "Reported blocked yesterday, actually merged."
 *
 * The property that matters as much as the row itself is what a Correction does
 * *not* do: it does not touch the belief it corrects. The history-count test below
 * is the one that would catch a well-meaning refactor deciding to "fix" the stale
 * version in place.
 */
let harness: StoreHarness;

const BLOCKED_AT = at('2026-07-30T08:15:00Z');
const MERGED_AT = at('2026-07-30T18:40:00Z');
const DETECTED_AT = at('2026-07-31T06:00:00Z');

const MERGE_EVIDENCE = {
  kind: 'pull_request',
  label: '#9201',
  sourceKey: 'primary-code',
  sourceRecordId: 'pull-request-9201',
} as const;

beforeAll(async () => {
  harness = await createStoreHarness();
  await harness.store.observe({
    kind: 'ticket',
    naturalKey: 'CHK-701',
    fields: ticketFields({ status: 'Blocked', flaggedBlocked: true }),
    observedAt: BLOCKED_AT,
    evidence: { kind: 'issue', label: 'CHK-701', sourceKey: 'primary-tracker', sourceRecordId: 'issue-CHK-701' },
  });
});

afterAll(async () => {
  await harness.close();
});

describe('detecting the contradiction', () => {
  it('reads the stored belief, not the arriving record', async () => {
    const ticket = await harness.store.read('ticket', 'CHK-701');
    if (ticket === null) throw new Error('the ticket was not stored');

    expect(believedBlocked(ticket)).toBe(true);

    const candidate = detectBlockedButMerged(ticket, {
      ticketKey: 'CHK-701',
      mergedAt: MERGED_AT,
      evidence: MERGE_EVIDENCE,
    });

    expect(candidate?.kind).toBe('blocked_but_merged');
    expect(candidate?.priorBelief).toContain('flagged blocked by the tracker');
    expect(candidate?.priorBelief).toContain('2026-07-30T08:15:00.000Z');
    expect(candidate?.newBelief).toContain('#9201');
  });

  it('says nothing when the stored belief was never blocked', async () => {
    await harness.store.observe({
      kind: 'ticket',
      naturalKey: 'CHK-702',
      fields: ticketFields({ itemKey: 'CHK-702', status: 'In Progress', flaggedBlocked: false }),
      observedAt: BLOCKED_AT,
      evidence: null,
    });
    const ticket = await harness.store.read('ticket', 'CHK-702');
    if (ticket === null) throw new Error('the ticket was not stored');

    expect(
      detectBlockedButMerged(ticket, { ticketKey: 'CHK-702', mergedAt: MERGED_AT, evidence: MERGE_EVIDENCE }),
    ).toBeNull();
  });

  it('says nothing when the merged work names a different ticket', async () => {
    const ticket = await harness.store.read('ticket', 'CHK-701');
    if (ticket === null) throw new Error('the ticket was not stored');

    expect(
      detectBlockedButMerged(ticket, { ticketKey: 'CHK-999', mergedAt: MERGED_AT, evidence: MERGE_EVIDENCE }),
    ).toBeNull();
  });
});

describe('writing the Correction', () => {
  let historyCountBefore: number;
  let priorBeliefBefore: string;

  beforeAll(async () => {
    const versions = await harness.store.versions({ entityKind: 'ticket', entityNaturalKey: 'CHK-701' });
    historyCountBefore = versions.length;
    priorBeliefBefore = JSON.stringify(versions);

    const ticket = await harness.store.read('ticket', 'CHK-701');
    if (ticket === null) throw new Error('the ticket was not stored');
    const candidate = detectBlockedButMerged(ticket, {
      ticketKey: 'CHK-701',
      mergedAt: MERGED_AT,
      evidence: MERGE_EVIDENCE,
    });
    if (candidate === null) throw new Error('the contradiction was not detected');

    await recordContradiction(harness.store, candidate, ticket.version, DETECTED_AT);
  });

  it('captures the prior belief, the new belief, the evidence artifact and detected_at', async () => {
    const written = await harness.store.corrections();

    expect(written).toHaveLength(1);
    const correction = written[0];
    expect(correction?.subjectKind).toBe('ticket');
    expect(correction?.subjectKey).toBe('CHK-701');
    expect(correction?.contradiction).toBe('blocked_but_merged');
    expect(correction?.priorBelief).toContain('CHK-701 was flagged blocked by the tracker');
    expect(correction?.newBelief).toContain('merged in #9201');
    expect(correction?.evidenceSourceRecordId).toBe('pull-request-9201');
    expect(correction?.evidenceLabel).toBe('#9201');
    expect(correction?.detectedAt.toISOString()).toBe('2026-07-31T06:00:00.000Z');
    expect(correction?.observedAt.toISOString()).toBe('2026-07-30T18:40:00.000Z');
    expect(correction?.priorVersion).toBe(1);
  });

  it('mutates and deletes nothing: the history count and the prior belief are untouched', async () => {
    const versions = await harness.store.versions({ entityKind: 'ticket', entityNaturalKey: 'CHK-701' });

    expect(versions).toHaveLength(historyCountBefore);
    expect(JSON.stringify(versions)).toBe(priorBeliefBefore);
  });

  it('produces exactly one row when the same contradiction is seen again', async () => {
    const ticket = await harness.store.read('ticket', 'CHK-701');
    if (ticket === null) throw new Error('the ticket was not stored');
    const candidate = detectBlockedButMerged(ticket, {
      ticketKey: 'CHK-701',
      mergedAt: MERGED_AT,
      evidence: MERGE_EVIDENCE,
    });
    if (candidate === null) throw new Error('the contradiction was not detected');

    // Twice more, as an overlapping window would.
    await recordContradiction(harness.store, candidate, ticket.version, DETECTED_AT);
    await recordContradiction(harness.store, candidate, ticket.version, at('2026-08-01T06:00:00Z'));

    expect(await harness.store.corrections()).toHaveLength(1);
  });

  it('refuses to be edited or removed, at both layers', async () => {
    expect(() => harness.store.scoped.updateIn(correctionsTable, { priorBelief: 'never mind' })).toThrow(
      AppendOnlyTableError,
    );
    expect(() => harness.store.scoped.deleteFrom(correctionsTable)).toThrow(AppendOnlyTableError);
    expect(() => harness.store.scoped.updateIn(entityVersions, { version: 99 })).toThrow(AppendOnlyTableError);

    await expect(harness.database.client.query('update corrections set prior_belief = $1', ['never mind'])).rejects.toThrow(
      /append-only/i,
    );
  });

  it('is stated in the product voice, as a clause rather than a badge', () => {
    expect(
      describeCorrection({ contradiction: 'blocked_but_merged', subjectKey: 'CHK-701', evidenceLabel: '#9201' }),
    ).toBe('CHK-701 was reported blocked — it had already merged in #9201.');
    expect(
      describeCorrection({ contradiction: 'done_but_reopened', subjectKey: 'PLAT-12', evidenceLabel: 'issue' }),
    ).toBe('PLAT-12 was reported done — it has been reopened.');
    expect(
      describeCorrection({ contradiction: 'something_new', subjectKey: 'PLAT-13', evidenceLabel: '#1' }),
    ).toContain('says otherwise');
  });
});

describe('the belief moving on afterwards', () => {
  it('appends a version rather than editing the one the Correction points at', async () => {
    const before = await harness.store.versions({ entityKind: 'ticket', entityNaturalKey: 'CHK-701' });

    await harness.store.observe({
      kind: 'ticket',
      naturalKey: 'CHK-701',
      fields: ticketFields({
        status: 'Done',
        statusCategory: 'done',
        flaggedBlocked: false,
        resolvedAt: MERGED_AT,
      }),
      observedAt: MERGED_AT,
      evidence: { kind: 'issue', label: 'CHK-701', sourceKey: 'primary-tracker', sourceRecordId: 'issue-CHK-701' },
    });

    const after = await harness.store.versions({ entityKind: 'ticket', entityNaturalKey: 'CHK-701' });

    expect(after).toHaveLength(before.length + 1);
    // Version 1 — the belief the Correction cites — is still exactly as it was.
    expect(JSON.stringify(after[0])).toBe(JSON.stringify(before[0]));
    expect(after.at(-1)?.trackedFields['status']).toBe('Done');
  });

  it('notices the mirror image too: work reported done that came back', async () => {
    const ticket = await harness.store.read('ticket', 'CHK-701');
    if (ticket === null) throw new Error('the ticket was not stored');

    const candidate = detectDoneButReopened(
      ticket,
      { status: 'In Progress', statusCategory: 'in_progress' },
      { kind: 'issue', label: 'CHK-701', sourceKey: 'primary-tracker', sourceRecordId: 'issue-CHK-701-reopen' },
      at('2026-08-02T09:00:00Z'),
    );

    expect(candidate?.kind).toBe('done_but_reopened');
    expect(candidate?.priorBelief).toContain('reported done');

    if (candidate === null) throw new Error('unreachable');
    await recordContradiction(harness.store, candidate, ticket.version, at('2026-08-02T09:30:00Z'));

    const written = await harness.store.corrections();
    expect(written.map((row) => row.contradiction).sort()).toEqual(['blocked_but_merged', 'done_but_reopened']);
  });
});
