import { instantFromIso, type Instant } from '@compass/clock';
import {
  MATERIAL_WORSENING_DELTA,
  applyFeedback,
  feedbackOffersFor,
  offGoalFlagCause,
  type FeedbackRecord,
  type ItemCause,
  type ReportItem,
  type ReportSection,
} from '@compass/analysis';
import {
  ScopedDb,
  claimFeedbackLink,
  feedbackLinkUses,
  memberships,
  orgScope,
  organizations,
  readCorrections,
  readFeedbackByAction,
  readFeedbackLedger,
  reportItems,
  reportSections,
  reports,
  users,
} from '@compass/db';
import { createTestDatabase, type TestDatabase } from '@compass/db/testing';
import { hashFeedbackToken, mintFeedbackToken, verifyFeedbackToken } from '@compass/delivery';
import { feedbackRecordFrom } from '@compass/pipeline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyManagerFeedback } from '../lib/feedback-source';

/**
 * The feedback loop, end to end, against a real migrated database.
 *
 * The unit tests in `packages/analysis` prove the *rules*. This proves the **loop**: a verdict
 * recorded through the same function all three channels call, read back out of Postgres, turned into
 * the ledger the analysis core applies, and actually changing what the next report would carry.
 *
 * That chain is where the interesting failures live. A verdict keyed on the wrong coordinates writes
 * a row that no item will ever match — nothing throws, nothing looks wrong, and every button on the
 * page silently does nothing. So the assertions here always end at "and the item is gone from the
 * next report", never at "and a row exists".
 */

const ORG = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const USER = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
const MEMBERSHIP = '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c';
const REPORT = '8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8d8d';
const SECTION = '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e';

const at = (iso: string): Instant => instantFromIso(iso);
const NOW = at('2026-08-03T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));
const DAY = 86_400_000;

/** The risk item the manager is looking at: `review_bottleneck` on Priya, medium severity. */
const RISK_ID = 'v1:8f2c1a0b3d4e5f60';
const RISK_CAUSE: ItemCause = {
  entityRef: 'developer:priya',
  causeKind: 'review_bottleneck',
  causeDiscriminator: '',
};
const RISK_SEVERITY = 210;

/** The off-goal flag, whose correction writes a second row. */
const FLAG_ID = 'v1:00000000000000f1';
const FLAG_CAUSE = offGoalFlagCause('OBJ-Q2-BILL');

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORG));

const persistedItem = async (input: {
  readonly id: string;
  readonly ordinal: number;
  readonly stableId: string;
  readonly cause: ItemCause;
  readonly headline: string;
  readonly severityScore: number;
}): Promise<void> => {
  await scoped()
    .insertInto(reportItems, {
      id: input.id,
      reportId: REPORT,
      reportSectionId: SECTION,
      ordinal: input.ordinal,
      stableId: input.stableId,
      causeEntityRef: input.cause.entityRef,
      causeKind: input.cause.causeKind,
      causeDiscriminator: input.cause.causeDiscriminator,
      headline: input.headline,
      detail: 'The detail.',
      prose: 'The claim, in prose.',
      changeTag: 'unchanged',
      ageDays: 5,
      firstSeenAt: asDate('2026-07-29T06:00:00Z'),
      severityScore: input.severityScore,
      signalOnsetAt: asDate('2026-07-29T06:00:00Z'),
      feedbackState: null,
      changeClause: null,
      ladder: null,
      hasLadder: false,
      payload: {},
    })
    .execute();
};

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();

  await database.db
    .insert(organizations)
    .values({
      id: ORG,
      organizationId: ORG,
      name: 'Acme',
      slug: 'acme-feedback',
      timezone: 'Europe/London',
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .onConflictDoNothing()
    .execute();

  await scoped()
    .insertInto(users, {
      id: USER,
      email: 'priya@acme.example',
      displayName: 'Priya Raman',
      passwordHash: null,
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  await scoped()
    .insertInto(memberships, {
      id: MEMBERSHIP,
      userId: USER,
      role: 'manager',
      status: 'active',
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  await scoped()
    .insertInto(reports, {
      id: REPORT,
      scopeKind: 'team',
      scopeKey: 'platform',
      schemaVersion: 2,
      reportInstant: asDate('2026-08-03T06:00:00Z'),
      reportDate: '2026-08-03',
      timezone: 'Europe/London',
      windowStart: asDate('2026-08-02T00:00:00Z'),
      windowEnd: asDate('2026-08-03T00:00:00Z'),
      contentHash: 'c'.repeat(64),
      payloadJson: '{}',
      payload: {},
      prose: 'The whole report.',
      changeLine: 'Nothing material changed since yesterday.',
      rendererId: 'template',
      fallbackRenderer: false,
      fallbackReason: null,
      coverageStatus: 'complete',
      ingestRunId: null,
      generatedAt: asDate('2026-08-03T06:00:00Z'),
    })
    .execute();

  await scoped()
    .insertInto(reportSections, {
      id: SECTION,
      reportId: REPORT,
      sectionKey: 'risks',
      ordinal: 4,
      title: 'Risks',
      prose: 'The risks prose.',
      payload: {},
      itemCount: 2,
      emptyStatement: 'No risk crossed a threshold.',
      summary: '2 risks crossed a threshold.',
    })
    .execute();

  await persistedItem({
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    ordinal: 1,
    stableId: RISK_ID,
    cause: RISK_CAUSE,
    headline: 'Priya has reviewed 6 of the 8 open pull requests',
    severityScore: RISK_SEVERITY,
  });

  await persistedItem({
    id: 'aaaaaaaa-0000-4000-8000-000000000002',
    ordinal: 2,
    stableId: FLAG_ID,
    cause: FLAG_CAUSE,
    headline: 'OFF-GOAL — 4 commits serve OBJ-Q2-BILL, which is not a current objective',
    severityScore: 40,
  });
}, 120_000);

afterAll(async () => {
  await database?.close();
});

/** The item as the next report's assembly would carry it, before suppression. */
const itemFor = (stableId: string, cause: ItemCause, severityScore: number): ReportItem => ({
  stableId,
  cause,
  headline: 'The claim.',
  detail: 'The detail.',
  changeTag: 'unchanged',
  ageDays: 5,
  firstSeenAt: at('2026-07-29T06:00:00Z'),
  severityScore,
  signalOnsetAt: at('2026-07-29T06:00:00Z'),
  evidence: [{ kind: 'pull_request', label: '#9201', sourceKey: 'code', sourceRecordId: 'pr-9201' }],
});

const risksSection = (items: readonly ReportItem[]): ReportSection => ({
  key: 'risks',
  index: 4,
  title: 'Risks',
  items,
  emptyStatement: 'No risk crossed a threshold.',
});

/**
 * The next report's Risks section, with the *stored* ledger applied.
 *
 * The whole chain in one helper: rows out of Postgres, through the pipeline's translation, into the
 * pure suppression pass. If any link is keyed differently from the others, this returns the item.
 */
const nextReportRisks = async (
  items: readonly ReportItem[],
  instant: Instant = (NOW + DAY) as Instant,
): Promise<ReturnType<typeof applyFeedback>> => {
  const rows = await readFeedbackLedger(scoped());
  const records = rows
    .map(feedbackRecordFrom)
    .filter((entry): entry is FeedbackRecord => entry !== null);

  return applyFeedback([risksSection(items)], { records }, {
    instant,
    priorInstant: NOW,
    priorStableIds: new Set(items.map((item) => item.stableId)),
  });
};

describe('a dismissal recorded through the web channel changes the next report', () => {
  it('refuses a dismissal with no reason, before writing anything', async () => {
    const refused = await applyManagerFeedback(scoped(), {
      stableId: RISK_ID,
      action: 'dismiss_risk',
      reason: null,
      channel: 'web',
      authorUserId: USER,
      now: NOW,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe('reason_required');
    expect(refused.detail).toContain(`${MATERIAL_WORSENING_DELTA} points`);
    expect(await readFeedbackByAction(scoped(), 'dismiss_risk')).toEqual([]);
  });

  it('records the coordinates, not the digest, and keeps the item out of the next report', async () => {
    const applied = await applyManagerFeedback(scoped(), {
      stableId: RISK_ID,
      action: 'dismiss_risk',
      reason: 'Priya is covering for Marcus this sprint; it is deliberate.',
      channel: 'web',
      authorUserId: USER,
      now: NOW,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // Keyed on the condition. A row keyed on the `v1:` digest would be orphaned the day
    // STABLE_ID_VERSION moved, which is exactly the deliberate reset that tag exists to permit.
    expect(applied.entry.causeEntityRef).toBe(RISK_CAUSE.entityRef);
    expect(applied.entry.causeKind).toBe(RISK_CAUSE.causeKind);
    // The severity at the moment of the verdict, read off the item the manager was looking at.
    expect(applied.entry.severityScoreAtVerdict).toBe(RISK_SEVERITY);
    expect(applied.entry.sourceChannel).toBe('web');
    expect(applied.entry.authorUserId).toBe(USER);
    // The sentence names the effect on future reports rather than acknowledging the click.
    expect(applied.sentence).toContain(`${MATERIAL_WORSENING_DELTA} points`);

    const next = await nextReportRisks([itemFor(RISK_ID, RISK_CAUSE, RISK_SEVERITY)]);
    expect(next.sections[0]?.items).toEqual([]);
    expect(next.suppressed[0]?.action).toBe('dismiss_risk');
  });

  it('is still suppressed six weeks later, unmoved', async () => {
    const next = await nextReportRisks(
      [itemFor(RISK_ID, RISK_CAUSE, RISK_SEVERITY + MATERIAL_WORSENING_DELTA - 1)],
      (NOW + 42 * DAY) as Instant,
    );

    expect(next.sections[0]?.items).toEqual([]);
  });

  it('resurfaces once the severity has risen by the documented threshold, saying what worsened', async () => {
    const worse = RISK_SEVERITY + MATERIAL_WORSENING_DELTA;
    const next = await nextReportRisks([itemFor(RISK_ID, RISK_CAUSE, worse)]);

    const returned = next.sections[0]?.items[0];
    expect(returned).toBeDefined();
    expect(returned?.feedback?.state).toBe('resurfaced');
    expect(returned?.changeClause).toContain(String(RISK_SEVERITY));
    expect(returned?.changeClause).toContain(String(worse));
  });

  it('does not accumulate a second row when the same verdict is given twice', async () => {
    await applyManagerFeedback(scoped(), {
      stableId: RISK_ID,
      action: 'dismiss_risk',
      reason: 'Still deliberate.',
      channel: 'slack',
      authorUserId: USER,
      now: (NOW + DAY) as Instant,
    });

    const rows = await readFeedbackByAction(scoped(), 'dismiss_risk');
    expect(rows).toHaveLength(1);
    // The later verdict wins, and the channel it came from is recorded.
    expect(rows[0]?.reason).toBe('Still deliberate.');
    expect(rows[0]?.sourceChannel).toBe('slack');
  });
});

describe('marking an off-goal flag wrong writes a Correction as well', () => {
  it('records the manager’s verdict, the original verdict and the evidence', async () => {
    const applied = await applyManagerFeedback(scoped(), {
      stableId: FLAG_ID,
      action: 'off_goal_flag_wrong',
      reason: 'The PM asked for this in the Q2 replan.',
      channel: 'web',
      authorUserId: USER,
      now: NOW,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.correctionWritten).toBe(true);

    const corrections = await readCorrections(scoped(), 'off_goal_flag_wrong');
    expect(corrections).toHaveLength(1);
    // Compass's own claim, verbatim — never a paraphrase of its own verdict.
    expect(corrections[0]?.priorBelief).toContain('OFF-GOAL');
    expect(corrections[0]?.newBelief).toContain('Q2 replan');
    expect(corrections[0]?.subjectKind).toBe('objective');
    expect(corrections[0]?.subjectKey).toBe('OBJ-Q2-BILL');
    expect(corrections[0]?.evidenceLabel).toBe(FLAG_ID);
  });

  it('suppresses that flag on every future report', async () => {
    for (const days of [1, 90, 900]) {
      const next = await nextReportRisks([itemFor(FLAG_ID, FLAG_CAUSE, 40)], (NOW + days * DAY) as Instant);
      expect(next.sections[0]?.items, `day ${days}`).toEqual([]);
    }
  });

  it('writes one Correction however often the manager clicks', async () => {
    // `corrections` is append-only, so a repeated correction has to be the same row rather than a
    // second contradiction about the same verdict.
    const again = await applyManagerFeedback(scoped(), {
      stableId: FLAG_ID,
      action: 'off_goal_flag_wrong',
      reason: 'Still wrong.',
      channel: 'email',
      authorUserId: null,
      now: (NOW + DAY) as Instant,
    });

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.correctionWritten).toBe(false);
    expect(await readCorrections(scoped(), 'off_goal_flag_wrong')).toHaveLength(1);
  });

  it('is visible on the corrections screen’s own reads', async () => {
    // The two reads `/corrections` performs. A suppression a manager cannot find is
    // indistinguishable from a detector that broke.
    const corrected = await readFeedbackByAction(scoped(), 'off_goal_flag_wrong');
    expect(corrected).toHaveLength(1);
    expect(corrected[0]?.reason).toBe('Still wrong.');
    expect((await readFeedbackLedger(scoped())).length).toBeGreaterThanOrEqual(2);
  });
});

describe('an action the item does not offer is refused', () => {
  it('will not mark a risk as an accepted recommendation', async () => {
    // Checked against `feedbackOffersFor` rather than trusted from the request: a hand-crafted POST
    // could otherwise write a row that nothing will ever read.
    expect(feedbackOffersFor('risks', RISK_CAUSE).map((offer) => offer.action)).not.toContain('accept_recommendation');

    const refused = await applyManagerFeedback(scoped(), {
      stableId: RISK_ID,
      action: 'accept_recommendation',
      reason: null,
      channel: 'web',
      authorUserId: USER,
      now: NOW,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe('action_not_offered');
    expect(await readFeedbackByAction(scoped(), 'accept_recommendation')).toEqual([]);
  });

  it('will not record a verdict against an item Compass does not hold', async () => {
    const refused = await applyManagerFeedback(scoped(), {
      stableId: 'v1:ffffffffffffffff',
      action: 'snooze',
      reason: null,
      channel: 'web',
      authorUserId: USER,
      now: NOW,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe('unknown_item');
  });

  it('refuses a snooze longer than the documented maximum', async () => {
    const refused = await applyManagerFeedback(scoped(), {
      stableId: RISK_ID,
      action: 'snooze',
      reason: null,
      snoozeDays: 400,
      channel: 'web',
      authorUserId: USER,
      now: NOW,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe('invalid_snooze');
  });
});

describe('a snooze recorded from Slack expires against the injected clock', () => {
  it('suppresses until the end instant, then falls back to the dismissal underneath it', async () => {
    // Submitted *after* the dismissal this suite already recorded, because that is the sequence
    // being tested: a manager who dismissed a risk and then, later, snoozed it. Precedence is
    // newest-first, so a snooze back-dated behind the dismissal would legitimately lose — and
    // asserting on it would be asserting the wrong rule.
    const snoozedAt = (NOW + 2 * DAY) as Instant;
    const applied = await applyManagerFeedback(scoped(), {
      stableId: RISK_ID,
      action: 'snooze',
      reason: null,
      snoozeDays: 7,
      channel: 'slack',
      authorUserId: USER,
      now: snoozedAt,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.entry.snoozeUntil).toBe(snoozedAt + 7 * DAY);

    // Six days on: the snooze is the newest thing with something to say.
    const during = await nextReportRisks(
      [itemFor(RISK_ID, RISK_CAUSE, RISK_SEVERITY)],
      (snoozedAt + 6 * DAY) as Instant,
    );
    expect(during.sections[0]?.items).toEqual([]);
    expect(during.suppressed[0]?.action).toBe('snooze');

    // Past the end the snooze has nothing left to say, and the dismissal underneath it still holds —
    // the item does not silently return just because a snooze lapsed.
    const after = await nextReportRisks(
      [itemFor(RISK_ID, RISK_CAUSE, RISK_SEVERITY)],
      (snoozedAt + 8 * DAY) as Instant,
    );
    expect(after.sections[0]?.items).toEqual([]);
    expect(after.suppressed[0]?.action).toBe('dismiss_risk');
  });
});

describe('an email feedback link is single-use for a state-changing action', () => {
  const SECRET = 'a-long-random-string-that-is-not-a-default';

  it('is claimed once and refused the second time', async () => {
    const minted = mintFeedbackToken(
      { organizationId: ORG, itemStableId: RISK_ID, action: 'snooze' },
      NOW,
      SECRET,
    );
    const verified = verifyFeedbackToken(minted.token, NOW, SECRET);
    expect(verified.verdict).toBe('accepted');
    if (verified.verdict !== 'accepted') return;

    const first = await claimFeedbackLink(scoped(), {
      tokenDigest: verified.tokenDigest,
      reportItemStableId: RISK_ID,
      action: 'snooze',
      usedAt: NOW,
    });
    const second = await claimFeedbackLink(scoped(), {
      tokenDigest: verified.tokenDigest,
      reportItemStableId: RISK_ID,
      action: 'snooze',
      usedAt: (NOW + 1000) as Instant,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('stores the digest and never the token', async () => {
    const minted = mintFeedbackToken(
      { organizationId: ORG, itemStableId: RISK_ID, action: 'dismiss_risk' },
      NOW,
      SECRET,
    );
    await claimFeedbackLink(scoped(), {
      tokenDigest: hashFeedbackToken(minted.token),
      reportItemStableId: RISK_ID,
      action: 'dismiss_risk',
      usedAt: NOW,
    });

    const rows = await scoped().selectFrom(feedbackLinkUses);
    const digests = rows.map((row) => row.tokenDigest);

    expect(digests).toContain(hashFeedbackToken(minted.token));
    // The token itself is never in the table. A stolen backup yields no working links, the same rule
    // `auth_tokens`, `share_links` and `subscriptions` follow.
    expect(digests).not.toContain(minted.token);
  });

  it('gives each email its own link, so Monday’s click does not burn Thursday’s', async () => {
    const monday = mintFeedbackToken({ organizationId: ORG, itemStableId: RISK_ID, action: 'snooze' }, NOW, SECRET);
    const thursday = mintFeedbackToken(
      { organizationId: ORG, itemStableId: RISK_ID, action: 'snooze' },
      (NOW + 3 * DAY) as Instant,
      SECRET,
    );

    expect(
      await claimFeedbackLink(scoped(), {
        tokenDigest: hashFeedbackToken(monday.token),
        reportItemStableId: RISK_ID,
        action: 'snooze',
        usedAt: NOW,
      }),
    ).toBe(true);

    expect(
      await claimFeedbackLink(scoped(), {
        tokenDigest: hashFeedbackToken(thursday.token),
        reportItemStableId: RISK_ID,
        action: 'snooze',
        usedAt: (NOW + 3 * DAY) as Instant,
      }),
    ).toBe(true);
  });
});
