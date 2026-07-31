import { describe, expect, it } from 'vitest';

import {
  BLOCKER_SIGNALS,
  RISK_CAUSES,
  THRESHOLDS,
  WIN_MINIMUM_RUNG,
  aggregateReviewQueue,
  assessCalibration,
  assessProgress,
  assessTechnicalDebt,
  assessWorkload,
  compareStable,
  detectBlockers,
  detectRisks,
  detectWins,
  detectYesterdayItems,
  generateStructuredReport,
  indexCommitGraph,
  resolveScope,
  rungAtOrAbove,
  sectionOf,
  severityFor,
  trendFor,
  wholeDaysBetween,
} from '@compass/analysis';
import { instantFromIso } from '@compass/clock';

import { SEED_NOW, buildSeedSnapshot, orphanPullRequestSnapshot } from './helpers/seed-snapshot.js';

/**
 * Blockers, the review queue, workload, risks, wins and the debt signal.
 *
 * The seeded manifest plants each of these deliberately and names the exact
 * identifiers involved, so these assertions check the detectors against a
 * documented expectation rather than against whatever they happen to emit.
 */
const platform = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' } });
const platformScope = resolveScope(platform);
const checkout = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'checkout' } });
const checkoutScope = resolveScope(checkout);

/** R3 and R4 walk parent edges, so every ladder caller is handed the commit graph. */
const ladderOptions = (snapshot: Parameters<typeof indexCommitGraph>[0]) =>
  ({ deploySignalAvailable: false, graph: indexCommitGraph(snapshot) }) as const;

describe('every blocker names its signal, its threshold and its evidence', () => {
  const blockers = [
    ...detectBlockers(platform, SEED_NOW, platformScope),
    ...detectBlockers(checkout, SEED_NOW, checkoutScope),
  ];

  it('finds blockers in the seeded dataset at all', () => {
    expect(blockers.length).toBeGreaterThan(0);
  });

  it('names a signal from the closed vocabulary', () => {
    for (const blocker of blockers) {
      expect(BLOCKER_SIGNALS as readonly string[]).toContain(blocker.signal);
    }
  });

  it('names the numbered threshold that was applied, including T0 for a stated fact', () => {
    for (const blocker of blockers) {
      expect(blocker.threshold.id, `${blocker.stableId} applied no named threshold`).toMatch(/^T\d+[ab]?$/);
      expect(blocker.threshold.statement.length).toBeGreaterThan(10);

      if (blocker.signal === 'tracker_flag' || blocker.signal === 'blocked_status') {
        expect(blocker.threshold.id).toBe('T0');
      } else {
        // An inferred blocker must have crossed the number it cites.
        expect(blocker.measured.value).toBeGreaterThanOrEqual(blocker.threshold.value);
      }
    }
  });

  it('names an evidence artifact — a tracker key or a pull request number', () => {
    for (const blocker of blockers) {
      expect(blocker.evidence.length, `${blocker.stableId} carries no evidence`).toBeGreaterThan(0);
      const labels = blocker.evidence.map((reference) => reference.label);
      const named = labels.some((label) => /^[A-Z]+-\d+$/.test(label) || label.startsWith('#'));
      expect(named, `${blocker.stableId} evidence is not a recognisable artifact: ${labels.join(', ')}`).toBe(true);
    }
  });

  it('names a pull request nobody was asked to review, which the seed has none of', () => {
    // Constructed rather than found: every seeded pull request has a requested
    // reviewer, so the T2 path would otherwise ship untested. A review that was
    // never asked for will not happen on its own, and that is a different fix
    // from nudging a named reviewer.
    const snapshot = orphanPullRequestSnapshot();
    const blockers = detectBlockers(snapshot, SEED_NOW, resolveScope(snapshot));

    expect(blockers.map((blocker) => blocker.signal)).toEqual(['no_reviewer']);
    expect(blockers[0].threshold.id).toBe('T2');
    expect(blockers[0].measured.value).toBeGreaterThanOrEqual(THRESHOLDS.T2.value);
    expect(blockers[0].evidence.map((reference) => reference.label)).toEqual(['#4242']);
  });

  it('reports one blocker per subject, taking the strongest signal', () => {
    const subjects = blockers.map((blocker) => blocker.subject.key);
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it('names a pull request nobody has reviewed yet, distinctly from one with no reviewer', () => {
    // `review-bottleneck-marcus-hale` plants #9101…#9107, all requested from one
    // person and none of them reviewed. Requested-and-ignored is a different
    // problem from never-assigned, and the two must not collapse into one signal.
    const awaiting = detectBlockers(platform, SEED_NOW, platformScope).filter(
      (blocker) => blocker.signal === 'awaiting_first_review',
    );

    expect(awaiting.length).toBeGreaterThan(0);
    expect(awaiting.map((blocker) => blocker.subject.label)).toContain('#9101');
    for (const blocker of awaiting) {
      expect(blocker.threshold.id).toBe('T4');
      expect(blocker.measured.value).toBeGreaterThanOrEqual(THRESHOLDS.T4.value);
      expect(blocker.measured.unit).toBe('working_days');
      // The reviewer was named; that is what makes it "awaiting" rather than "no
      // reviewer", and the detail has to say who was asked.
      expect(blocker.detail).toContain('Marcus Hale');
    }
  });

  it('finds CHK-701 blocked, from the tracker flag rather than by inference', () => {
    const chk701 = detectBlockers(checkout, SEED_NOW, checkoutScope).find(
      (blocker) => blocker.subject.key === 'CHK-701',
    );

    expect(chk701?.signal).toBe('tracker_flag');
    expect(chk701?.threshold.id).toBe('T0');
    expect(chk701?.evidence.map((reference) => reference.label)).toContain('CHK-701');
  });
});

describe('the review queue lists pull requests, never only an average', () => {
  const queue = aggregateReviewQueue(platform, SEED_NOW, platformScope);

  it('lists number, title, author, reviewer, age and time in review for each entry', () => {
    expect(queue.entries.length).toBeGreaterThan(0);

    for (const entry of queue.entries) {
      expect(entry.pullRequestNumber).toMatch(/^#\d+$/);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.authorDeveloperKey ?? entry.authorName).not.toBeNull();
      expect(entry.ageDays).toBeGreaterThanOrEqual(0);
      expect(entry.timeInReviewDays).toBeGreaterThanOrEqual(0);
      expect(entry.timeInReviewDays).toBeLessThanOrEqual(entry.ageDays);
    }
  });

  it('names the reviewers rather than reporting a headcount', () => {
    const withReviewers = queue.entries.filter((entry) => entry.reviewerDeveloperKeys.length > 0);
    expect(withReviewers.length).toBeGreaterThan(0);
    for (const entry of withReviewers) {
      expect(entry.reviewerNames.length).toBe(entry.reviewerDeveloperKeys.length);
    }
  });

  it('finds the planted bottleneck and names the person it is behind', () => {
    // `review-bottleneck-marcus-hale`: 7 open pull requests on platform-api all
    // name Marcus Hale as the requested reviewer.
    expect(queue.concentration).not.toBeNull();
    expect(queue.concentration?.displayName).toBe('Marcus Hale');
    expect(queue.concentration?.openCount).toBeGreaterThanOrEqual(THRESHOLDS.T5.value);
    expect(queue.concentration?.threshold.id).toBe('T5');
  });

  it('orders the per-reviewer depths by developer key, not by depth', () => {
    const keys = queue.openByReviewer.map((load) => load.developerKey);
    expect(keys).toEqual([...keys].sort(compareStable));
  });

  it('still reports an aggregate, alongside the list rather than instead of it', () => {
    expect(queue.totalOpen).toBe(queue.entries.length);
    expect(queue.oldestAgeDays).toBe(Math.max(...queue.entries.map((entry) => entry.ageDays)));
  });
});

describe('workload distribution measures load, never output', () => {
  const workload = assessWorkload(platform, SEED_NOW, platformScope);

  it('lists people in alphabetical order by key', () => {
    const keys = workload.perDeveloper.map((load) => load.developerKey);
    expect(keys).toEqual([...keys].sort(compareStable));
  });

  it('names the items each person is carrying so the count can be checked', () => {
    for (const load of workload.perDeveloper) {
      expect(load.openItemKeys.length).toBe(load.openItems);
    }
  });

  it('counts unassigned work separately rather than losing it', () => {
    const assigned = workload.perDeveloper.reduce((sum, load) => sum + load.openItems, 0);
    expect(assigned + workload.unassignedOpenItems).toBe(workload.totalOpenItems);
    expect(workload.unassignedItemKeys.length).toBe(workload.unassignedOpenItems);
  });

  it('carries no commit count, no lines-of-code figure and no productivity score', () => {
    const json = JSON.stringify(workload);
    for (const banned of ['commitCount', 'linesOfCode', 'linesAdded', 'productivity', 'rank']) {
      expect(json).not.toContain(banned);
    }
  });
});

describe('risks carry severity and a trend with the value it compared against', () => {
  const report = generateStructuredReport(platform, SEED_NOW);
  const risks = report.findings.risks;

  it('detects risks in the seeded dataset', () => {
    expect(risks.length).toBeGreaterThan(0);
  });

  it('gives every risk a severity, a trend, and a stated prior', () => {
    for (const risk of risks) {
      expect(['low', 'medium', 'high']).toContain(risk.severity);
      expect(['new', 'worsened', 'unchanged', 'improving']).toContain(risk.trend);
      expect(RISK_CAUSES as readonly string[]).toContain(risk.cause);
      expect(['measured_at_window_start', 'no_prior_observation']).toContain(risk.priorBasis);

      // The trend must follow from the two numbers, so a reader can check it.
      expect(risk.trend, `${risk.stableId} states a trend its own numbers do not support`).toBe(
        trendFor(risk.measured.value, risk.priorValue),
      );
      if (risk.priorValue === null) {
        expect(risk.trend).toBe('new');
        expect(risk.priorBasis).toBe('no_prior_observation');
        expect(risk.priorAt).toBeNull();
      } else {
        expect(risk.priorBasis).toBe('measured_at_window_start');
        expect(risk.priorAt).not.toBeNull();
      }
    }
  });

  it('derives severity from distance past the threshold rather than by hand', () => {
    expect(severityFor(6, 3)).toBe('high');
    expect(severityFor(3, 3)).toBe('medium');
    expect(severityFor(1, 3)).toBe('low');
  });

  it('finds the review bottleneck as a risk against a named person', () => {
    const bottleneck = risks.find((risk) => risk.cause === 'review_bottleneck');
    expect(bottleneck?.subject.label).toBe('Marcus Hale');
    expect(bottleneck?.threshold.id).toBe('T5');
  });

  it('finds the merged-but-unreleased work the manifest plants', () => {
    // `merged-not-released-platform-api`: 3 pull requests merged after v4.2.0.
    const unreleased = risks.find((risk) => risk.cause === 'unreleased_merged_work');
    expect(unreleased).toBeDefined();
    expect(unreleased?.measured.value).toBeGreaterThanOrEqual(1);
    expect(unreleased?.evidence.some((reference) => reference.kind === 'release')).toBe(true);
  });

  it('names the oldest unreleased item and its age rather than only a count', () => {
    // `merged-not-released-platform-api` plants three merges ahead of `v4.2.0`:
    // #9301 at 2026-07-29T18:05Z, #9302 at 2026-07-30T10:47Z, #9303 at
    // 2026-07-30T16:12Z. The oldest is the one a manager acts on — it is what they
    // cut the next tag for — so it is named, with how long it has been waiting.
    const mergedAt = [
      '2026-07-29T18:05:00.000Z',
      '2026-07-30T10:47:00.000Z',
      '2026-07-30T16:12:00.000Z',
    ].map(instantFromIso);
    const unreleased = risks.find((risk) => risk.cause === 'unreleased_merged_work');

    expect(unreleased).toBeDefined();
    expect(unreleased?.headline).toContain('v4.2.0');
    expect(unreleased?.detail).toContain('#9301');
    expect(unreleased?.detail).toContain('PLAT-753');

    // Computed from the three planted instants rather than asserted as a literal:
    // the age reported has to be the *largest* of them, which is what proves the
    // detector picked the oldest merge and not merely the first one it walked past.
    const oldestAgeDays = Math.max(...mergedAt.map((at) => wholeDaysBetween(at, SEED_NOW)));
    expect(unreleased?.ageDays).toBe(oldestAgeDays);
    expect(unreleased?.detail).toContain(`waiting ${oldestAgeDays} days`);
  });

  it('orders risks most severe first', () => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let index = 1; index < risks.length; index += 1) {
      expect(rank[risks[index].severity]).toBeGreaterThanOrEqual(rank[risks[index - 1].severity]);
    }
  });
});

/**
 * The other half of the ladder-mismatch rule.
 *
 * `unreleased_merged_work` fires when code has landed and not shipped. This one
 * fires on the opposite failure: the tracker says finished and version control has
 * never heard of the work. It is the cheapest event in the chain to produce — one
 * click — and it silently corrupts every points total and every velocity that
 * counts the item, which is why it is named per ticket rather than counted.
 */
describe('a ticket accepted with no pull request becomes a hygiene finding', () => {
  const insights = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'insights' } });
  const report = generateStructuredReport(insights, SEED_NOW);
  const hygiene = report.findings.risks.filter((risk) => risk.cause === 'done_without_pull_request');

  it('names the seeded item the tracker closed with nothing behind it', () => {
    // `done-with-no-pull-request-INS-204`: INS-204 transitions to Done at
    // 2026-07-30T11:05Z with no pull request, no branch and no commit naming it.
    const finding = hygiene.find((risk) => risk.subject.key === 'INS-204');

    expect(hygiene.map((risk) => risk.subject.key), 'the planted pathology must be named').toContain('INS-204');
    expect(finding?.subject.kind).toBe('ticket');
    expect(finding?.headline).toContain('INS-204');
    expect(finding?.detail).toContain('no pull request');
    // T0: the sources state the condition outright, so no number is applied.
    expect(finding?.threshold.id).toBe('T0');
    expect(finding?.measured.value).toBe(1);
  });

  it('fires precisely because the ladder stopped at R1 with R2 uncrossed', () => {
    const item = report.findings.yesterday.find((entry) => entry.ticketKey === 'INS-204');

    expect(item, 'INS-204 completed inside the report window').toBeDefined();
    expect(item?.ladder.notches.find((notch) => notch.rung === 'R1')?.crossed).toBe(true);
    expect(item?.ladder.notches.find((notch) => notch.rung === 'R2')?.crossed).toBe(false);
    expect(item?.ladder.highestCrossed).toBe('R1');
  });

  it('reaches the Risks section rather than staying inside findings', () => {
    const named = sectionOf(report, 'risks').items.filter((item) => item.headline.includes('INS-204'));

    expect(named.length, 'the finding must be on the page a manager reads').toBe(1);
  });

  it('does not name a completion that does have a pull request behind it', () => {
    // A detector that named every completion would satisfy the assertions above, so
    // the platform team — which merges its work — must produce no finding for any
    // item whose ladder reached R2.
    const platformReport = generateStructuredReport(platform, SEED_NOW);
    const merged = platformReport.findings.yesterday.filter(
      (entry) => entry.ladder.notches.find((notch) => notch.rung === 'R2')?.crossed === true,
    );
    const flagged = new Set(
      platformReport.findings.risks
        .filter((risk) => risk.cause === 'done_without_pull_request')
        .map((risk) => risk.subject.key),
    );

    expect(merged.length, 'the platform team merges its work').toBeGreaterThan(0);
    for (const entry of merged) {
      const subject = entry.ticketKey ?? entry.unitOfWork;
      expect(flagged.has(subject), `${subject} merged, yet was named a hygiene finding`).toBe(false);
    }
  });
});

describe('wins follow rule W1 and nothing else', () => {
  const wins = [
    ...detectWins(platform, SEED_NOW, detectYesterdayItems(platform, SEED_NOW, platformScope, ladderOptions(platform))),
    ...detectWins(checkout, SEED_NOW, detectYesterdayItems(checkout, SEED_NOW, checkoutScope, ladderOptions(checkout))),
  ];

  it('yields at least two wins from the seeded dataset', () => {
    expect(wins.length).toBeGreaterThanOrEqual(2);
  });

  it('names a ticket key and the crossed rung on every win', () => {
    for (const win of wins) {
      expect(win.ticketKey ?? win.unitOfWork).toBeTruthy();
      expect(win.rungLabel).toMatch(/^R[1-5] \w+$/);
      expect(win.headline).toContain(win.rungLabel);
    }
    // At least two of them name a real tracker key, which is the criterion.
    expect(wins.filter((win) => win.ticketKey !== null).length).toBeGreaterThanOrEqual(2);
  });

  it('emits nothing below rung R2', () => {
    for (const win of wins) {
      expect(rungAtOrAbove(win.rung, WIN_MINIMUM_RUNG), `${win.stableId} is only ${win.rung}`).toBe(true);
    }
  });

  it('emits nothing that is neither three points nor five working days old', () => {
    for (const win of wins) {
      const bigEnough = win.points !== null && win.points >= THRESHOLDS.T8a.value;
      const oldEnough = win.ageWorkingDays >= THRESHOLDS.T8b.value;

      expect(bigEnough || oldEnough, `${win.stableId} met neither limb of W1`).toBe(true);
      expect(win.qualifiedBy).toBe(bigEnough && oldEnough ? 'both' : bigEnough ? 'story_points' : 'elapsed_age');
      expect(win.thresholds.map((threshold) => threshold.id)).toEqual(['T8a', 'T8b']);
    }
  });

  it('does not award a win to a tracker-only completion with no code', () => {
    const insights = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'insights' } });
    const insightsScope = resolveScope(insights);
    const insightsWins = detectWins(
      insights,
      SEED_NOW,
      detectYesterdayItems(insights, SEED_NOW, insightsScope, ladderOptions(insights)),
    );

    expect(insightsWins.some((win) => win.ticketKey === 'INS-204')).toBe(false);
  });
});

describe('the technical-debt signal is a named set, not a score', () => {
  const debt = assessTechnicalDebt(platform, SEED_NOW, platformScope);

  it('is non-empty for the seeded debt pathology, and carries its inputs', () => {
    // `tech-debt-growth-plat`: tech-debt tickets opened per sprint rise 2, 3, 4, 7.
    expect(debt.signals.openTechDebtItems.value).toBeGreaterThan(0);
    expect(debt.signals.openTechDebtItems.ticketKeys.length).toBe(debt.signals.openTechDebtItems.value);
    expect(debt.signals.meanOpenAgeDays.sampleSize).toBe(debt.signals.openTechDebtItems.value);
    expect(debt.signals.netChangeOverTrailingWindow.openedTicketKeys.length).toBeGreaterThan(0);
    expect(debt.signals.reworkedMergedPullRequestShare.denominator).toBeGreaterThan(0);
  });

  it('names the four inputs it composes', () => {
    expect(Object.keys(debt.signals).sort()).toEqual([
      'meanOpenAgeDays',
      'netChangeOverTrailingWindow',
      'openTechDebtItems',
      'reworkedMergedPullRequestShare',
    ]);
    for (const signal of Object.values(debt.signals)) {
      expect(signal.name.length).toBeGreaterThan(0);
    }
  });

  it('labels the rework share as per-pull-request, not per-file', () => {
    expect(debt.signals.reworkedMergedPullRequestShare.granularity).toBe('perPullRequest');
    expect(debt.signals.reworkedMergedPullRequestShare.cycleCount).toBe(3);
  });

  it('applies a numbered growth threshold and explains the verdict', () => {
    expect(debt.thresholdsApplied.map((threshold) => threshold.id)).toContain('T9');
    expect(['growing', 'flat', 'shrinking']).toContain(debt.growth);
    expect(debt.reasons.length).toBeGreaterThan(0);
    expect(debt.reasons.join(' ')).toContain('T9');
  });

  it('emits the per-sprint series the weekly digest reads, one point per sprint', () => {
    const series = debt.openedPerSprint;
    expect(series.length).toBeGreaterThan(3);

    for (const point of series) {
      expect(point.ticketKeys.length).toBe(point.opened);
      expect(point.startAt).toBeLessThan(point.endAt);
    }
    // Oldest sprint first, which is what the digest's trend reading depends on.
    const starts = series.map((point) => point.startAt);
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
  });

  it('marks the sprint still running as incomplete rather than letting it read as a fall', () => {
    // Sprint 46 opened on 2026-07-28 and the seeded `now` is 2026-07-31, so its
    // bucket is three days into a fortnight. Compared as a finished observation
    // it would say debt had halved.
    const series = debt.openedPerSprint;
    const last = series[series.length - 1];

    expect(last.complete).toBe(false);
    expect(last.endAt).toBeGreaterThan(SEED_NOW);
    for (const point of series.slice(0, -1)) {
      expect(point.complete, `${point.sprintName} should have closed before the reporting instant`).toBe(true);
      expect(point.endAt).toBeLessThanOrEqual(SEED_NOW);
    }
  });

  it('carries the planted cohort, rising 2 → 3 → 4 → 7 exactly as the manifest documents', () => {
    // `tech-debt-growth-plat` files these keys in these sprints. The project also
    // carries ordinary background tickets labelled tech-debt, so the pathology is
    // checked by its own keys rather than by the bucket totals, which include
    // both and would let the planted curve pass unnoticed.
    const cohorts = [
      { sprintName: 'Sprint 43', ticketKeys: ['PLAT-781', 'PLAT-782'] },
      { sprintName: 'Sprint 44', ticketKeys: ['PLAT-783', 'PLAT-784', 'PLAT-785'] },
      { sprintName: 'Sprint 45', ticketKeys: ['PLAT-786', 'PLAT-787', 'PLAT-788', 'PLAT-789'] },
      {
        sprintName: 'Sprint 46',
        ticketKeys: ['PLAT-790', 'PLAT-791', 'PLAT-792', 'PLAT-793', 'PLAT-794', 'PLAT-795', 'PLAT-796'],
      },
    ];

    const plantedKeys = new Set(cohorts.flatMap((cohort) => cohort.ticketKeys));

    const attributed = cohorts.map((cohort) => {
      const point = debt.openedPerSprint.find((candidate) => candidate.sprintName === cohort.sprintName);
      expect(point, `${cohort.sprintName} is missing from the series`).toBeDefined();
      // Every planted key lands in its own sprint's bucket, and no planted key
      // from another cohort leaks into it.
      return (point?.ticketKeys ?? []).filter((key) => plantedKeys.has(key));
    });

    expect(attributed).toEqual(cohorts.map((cohort) => cohort.ticketKeys));
    expect(attributed.map((keys) => keys.length)).toEqual([2, 3, 4, 7]);
  });

  it('reports the debt growth as a risk with the numbers behind it', () => {
    const risks = detectRisks(platform, SEED_NOW, platformScope, {
      progress: assessProgress(platform, SEED_NOW, platformScope),
      reviewQueue: aggregateReviewQueue(platform, SEED_NOW, platformScope),
      workload: assessWorkload(platform, SEED_NOW, platformScope),
      technicalDebt: debt,
      calibration: assessCalibration(platform, SEED_NOW, platformScope),
      yesterday: detectYesterdayItems(platform, SEED_NOW, platformScope, ladderOptions(platform)),
    });

    if (debt.growth === 'growing') {
      const risk = risks.find((candidate) => candidate.cause === 'technical_debt_growth');
      expect(risk).toBeDefined();
      expect(risk?.threshold.id).toBe('T9');
      expect(risk?.detail).toContain('Sprint');
    }
  });
});
