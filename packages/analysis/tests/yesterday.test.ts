import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  NO_DEPLOY_SIGNAL_STATEMENT,
  QUALIFYING_YESTERDAY_EVENTS,
  YESTERDAY_DEDUP_KEY,
  YESTERDAY_ORDER_KEY,
  compareStable,
  detectYesterdayItems,
  entitiesOfKind,
  indexCommitGraph,
  instantField,
  resolveScope,
  scopedPullRequests,
  textField,
  windowContains,
  type AnalysisSnapshot,
  type Instant,
} from '@compass/analysis';

import { SEED_NOW, SEED_WINDOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

/**
 * Yesterday: the half-open window, the dedup key and the stable ordering.
 *
 * The seeded pathology `blocked-then-merged-CHK-701` is the case this section
 * exists to get right: CHK-701 carries the tracker's blocked flag from the
 * morning of 2026-07-30 and its pull request #9201 merged at 18:40 the same day.
 * One item, both artifacts named.
 */
const checkout = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'checkout' } });
const checkoutScope = resolveScope(checkout);

/**
 * The ladder's R3 and R4 detectors walk parent edges, so every caller supplies the
 * graph. Built per snapshot rather than shared, because a graph indexed from one
 * snapshot and used against another would answer reachability questions about the
 * wrong repository history.
 */
const optionsFor = (snapshot: AnalysisSnapshot) =>
  ({ deploySignalAvailable: false, graph: indexCommitGraph(snapshot) }) as const;

const options = optionsFor(checkout);

const items = detectYesterdayItems(checkout, SEED_NOW, checkoutScope, options);

describe('the qualifying-event set is documented in code', () => {
  it('names exactly three qualifying events and the rule for each', () => {
    expect(QUALIFYING_YESTERDAY_EVENTS.map((event) => event.kind)).toEqual([
      'ticket_accepted',
      'pull_request_merged',
      'release_cut',
    ]);
    for (const event of QUALIFYING_YESTERDAY_EVENTS) {
      expect(event.rule).toContain('window');
      expect(event.source.length).toBeGreaterThan(0);
    }
  });

  it('documents the dedup key and the ordering key as prose a reviewer can check', () => {
    expect(YESTERDAY_DEDUP_KEY).toContain('ticket:');
    expect(YESTERDAY_DEDUP_KEY).toContain('pull_request:');
    expect(YESTERDAY_ORDER_KEY).toContain('completedAt');
  });
});

describe('only events inside the half-open window qualify', () => {
  it('emits nothing whose contributing events fall outside [start, end)', () => {
    for (const item of items) {
      expect(windowContains(SEED_WINDOW, item.completedAt as Instant), `${item.unitOfWork} is outside the window`).toBe(
        true,
      );
      for (const event of item.events) {
        expect(windowContains(SEED_WINDOW, event.at as Instant), `${event.label} is outside the window`).toBe(true);
      }
    }
  });

  it('excludes a merge exactly at window.end and includes one exactly at window.start', () => {
    // Constructed rather than found: the boundary is the case a dataset is least
    // likely to contain and the one most likely to be got wrong.
    const merges = scopedPullRequests(checkout, checkoutScope)
      .map((pullRequest) => instantField(pullRequest, 'mergedAt'))
      .filter((value): value is Instant => value !== null)
      .sort((left, right) => left - right);
    const chosen = merges[Math.floor(merges.length / 2)];
    expect(chosen, 'the scoped dataset must contain a merge to sit on the boundary').toBeDefined();

    const endsAtMerge = buildSeedSnapshot({
      scope: { kind: 'team', teamKey: 'checkout' },
      instant: SEED_NOW,
      window: timeWindow(instantFromIso('2026-05-18T00:00:00.000Z'), chosen),
    });
    const startsAtMerge = buildSeedSnapshot({
      scope: { kind: 'team', teamKey: 'checkout' },
      instant: SEED_NOW,
      window: timeWindow(chosen, instantFromIso('2026-08-01T00:00:00.000Z')),
    });

    const excluded = detectYesterdayItems(endsAtMerge, SEED_NOW, checkoutScope, options).flatMap((item) => item.events);
    const included = detectYesterdayItems(startsAtMerge, SEED_NOW, checkoutScope, options).flatMap(
      (item) => item.events,
    );

    expect(excluded.some((event) => event.at === chosen)).toBe(false);
    expect(included.some((event) => event.at === chosen)).toBe(true);
  });
});

describe('a ticket and its merged pull request are one item naming both', () => {
  const chk701 = items.find((item) => item.ticketKey === 'CHK-701');

  it('emits exactly one item for CHK-701', () => {
    expect(items.filter((item) => item.ticketKey === 'CHK-701')).toHaveLength(1);
    expect(chk701).toBeDefined();
  });

  it('names the ticket key and the pull request number on the one item', () => {
    const labels = (chk701?.artifacts ?? []).map((reference) => reference.label);

    expect(labels).toContain('CHK-701');
    expect(labels).toContain('#9201');
  });

  it('does not also emit a bare pull-request item for the same merge', () => {
    expect(items.some((item) => item.unitOfWork.includes('pull-request-9201'))).toBe(false);
  });

  it('finishes at the later of the two events — the merge, not the tracker transition', () => {
    const merge = chk701?.events.find((event) => event.kind === 'pull_request_merged');
    expect(merge).toBeDefined();
    expect(chk701?.completedAt).toBe(merge?.at);
  });
});

describe('ordering is stable and documented', () => {
  it('orders by completion instant then unit of work', () => {
    for (let index = 1; index < items.length; index += 1) {
      const previous = items[index - 1];
      const current = items[index];
      const ordered =
        previous.completedAt < current.completedAt ||
        (previous.completedAt === current.completedAt && compareStable(previous.unitOfWork, current.unitOfWork) <= 0);
      expect(ordered, `${previous.unitOfWork} must not follow ${current.unitOfWork}`).toBe(true);
    }
  });

  it('emits an identical sequence on two runs over the same snapshot', () => {
    const first = detectYesterdayItems(checkout, SEED_NOW, checkoutScope, options);
    const second = detectYesterdayItems(checkout, SEED_NOW, checkoutScope, options);

    expect(second.map((item) => item.stableId)).toEqual(first.map((item) => item.stableId));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('gives every item a stable id derived from the unit of work alone', () => {
    for (const item of items) {
      expect(item.stableId).toBe(`yesterday:${item.unitOfWork}`);
    }
    expect(new Set(items.map((item) => item.stableId)).size).toBe(items.length);
  });
});

describe('the completion ladder', () => {
  it('gives every item five notches in fixed order', () => {
    for (const item of items) {
      expect(item.ladder.notches.map((notch) => notch.rung)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
    }
  });

  it('renders R5 as unreachable with the literal words the design requires', () => {
    for (const item of items) {
      const deployed = item.ladder.notches[4];
      expect(deployed.reachable).toBe(false);
      expect(deployed.crossed).toBe(false);
      expect(deployed.statement).toBe(NO_DEPLOY_SIGNAL_STATEMENT);
    }
  });

  it('marks R5 reachable when a connector reports a deploy signal', () => {
    const withDeploy = detectYesterdayItems(checkout, SEED_NOW, checkoutScope, {
      ...options,
      deploySignalAvailable: true,
    });
    for (const item of withDeploy) {
      expect(item.ladder.notches[4].reachable).toBe(true);
      expect(item.ladder.notches[4].statement).toBeNull();
    }
  });

  it('marks CHK-701 at merged or beyond, with the merge as its evidence', () => {
    const chk701 = items.find((item) => item.ticketKey === 'CHK-701');
    const merged = chk701?.ladder.notches.find((notch) => notch.rung === 'R2');

    expect(merged?.crossed).toBe(true);
    expect(merged?.evidence.map((reference) => reference.label)).toContain('#9201');
  });

  it('exposes a merge with no tracker acceptance as R3 crossed and R0 contiguous', () => {
    // `blocked-then-merged-CHK-701`: the code merged and reached trunk while the
    // tracker still says Blocked. R2 and R3 are crossed, R1 is not — so the highest
    // crossed rung is R3 and the contiguous rung is R0, and the win rule reads the
    // contiguous one. A merge no board can account for is a finding, not a win.
    const chk701 = items.find((item) => item.ticketKey === 'CHK-701');

    expect(chk701?.ladder.notches.find((notch) => notch.rung === 'R1')?.crossed).toBe(false);
    expect(chk701?.ladder.notches.find((notch) => notch.rung === 'R3')?.crossed).toBe(true);
    expect(chk701?.ladder.highestCrossed).toBe('R3');
    expect(chk701?.ladder.highestContiguous).toBe('R0');
  });

  it('exposes a tracker-only completion as R1 with nothing above it', () => {
    // `done-with-no-pull-request-INS-204`: marked Done with nothing in version
    // control to show for it. The gap is the finding.
    const insights = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'insights' } });
    const insightsItems = detectYesterdayItems(insights, SEED_NOW, resolveScope(insights), optionsFor(insights));
    const ins204 = insightsItems.find((item) => item.ticketKey === 'INS-204');

    expect(ins204, 'INS-204 transitions to Done inside the window').toBeDefined();
    expect(ins204?.ladder.notches.find((notch) => notch.rung === 'R1')?.crossed).toBe(true);
    expect(ins204?.ladder.notches.find((notch) => notch.rung === 'R2')?.crossed).toBe(false);
    expect(ins204?.ladder.notches.find((notch) => notch.rung === 'R3')?.crossed).toBe(false);
    expect(ins204?.ladder.highestCrossed).toBe('R1');
    expect(ins204?.ladder.rungSuffix).toBe('accepted, not yet merged');
  });
});

describe('a release is its own item', () => {
  it('never folds a release into a ticket line', () => {
    const platform = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' } });
    const releaseWindow = timeWindow(
      instantFromIso('2026-07-29T00:00:00.000Z'),
      instantFromIso('2026-07-30T00:00:00.000Z'),
    );
    const snapshot = buildSeedSnapshot({
      scope: { kind: 'team', teamKey: 'platform' },
      instant: SEED_NOW,
      window: releaseWindow,
    });
    const releases = detectYesterdayItems(snapshot, SEED_NOW, resolveScope(platform), options).filter((item) =>
      item.unitOfWork.startsWith('release:'),
    );

    // `release-slip-v4-2-0`: v4.2.0 was cut at 2026-07-29T17:20:00Z.
    expect(releases.length).toBeGreaterThan(0);
    for (const release of releases) {
      expect(release.ticketKey).toBeNull();
      expect(release.artifacts.some((reference) => reference.kind === 'release')).toBe(true);
    }
    expect(releases.flatMap((item) => item.artifacts).map((reference) => reference.label)).toContain('v4.2.0');
  });
});

describe('scope keeps another team’s work out', () => {
  it('emits no item whose ticket belongs to a project outside the scope', () => {
    for (const item of items) {
      if (item.ticketKey === null) continue;
      const ticket = entitiesOfKind(checkout, 'ticket').find(
        (candidate) => textField(candidate, 'itemKey') === item.ticketKey,
      );
      expect(textField(ticket!, 'projectKey')).toBe('CHK');
    }
  });
});
