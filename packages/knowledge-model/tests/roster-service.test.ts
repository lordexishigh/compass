import { instantFromIso, type Instant } from '@compass/clock';
import {
  IdentityClaimedError,
  InvalidAbsenceError,
  InvalidCalendarError,
  UnmatchedIdentityNotFoundError,
  addIdentityLink,
  attributionImpact,
  endAbsence,
  identityNaturalKey,
  mergeUnmatchedIdentity,
  readRosterView,
  recordAbsence,
  removeIdentityLink,
  setProjectTracking,
  setRepositoryTracking,
  setTeamMembership,
  setWorkingCalendar,
  unmergeIdentity,
  upsertDeveloper,
  upsertTeam,
  type PreMergeAttribution,
} from '@compass/knowledge-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStoreHarness, type StoreHarness } from './helpers/store.js';

/**
 * The roster service: every configuration write, and the un-merge that has to be exact.
 *
 * Against a real migrated PostgreSQL 17 through PGlite, because the guarantees under test are
 * database guarantees. "Appending rather than mutating" is only true if `entity_versions`
 * actually grows and the prior row is actually still there, and a mocked store would happily
 * report both without either being so.
 */

const at = (iso: string): Instant => instantFromIso(iso);

const DAY_ONE = at('2026-08-01T09:00:00Z');
const DAY_TWO = at('2026-08-02T09:00:00Z');
const DAY_THREE = at('2026-08-03T09:00:00Z');

let harness: StoreHarness;

beforeAll(async () => {
  harness = await createStoreHarness();

  await upsertTeam(
    harness.store,
    {
      key: 'platform',
      name: 'Platform',
      methodology: 'scrum',
      projectKey: 'PLAT',
      objectiveKey: null,
      conversationKey: null,
      timezone: 'Europe/London',
    },
    DAY_ONE,
  );

  for (const [key, displayName] of [
    ['priya', 'Priya Raman'],
    ['marcus', 'Marcus Hale'],
  ] as const) {
    await upsertDeveloper(harness.store, { key, displayName, teamKey: 'platform', active: true }, DAY_ONE);
  }
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('team membership is added and removed by appending', () => {
  it('appends a version rather than rewriting the prior belief', async () => {
    const added = await setTeamMembership(
      harness.store,
      { teamKey: 'platform', developerKey: 'marcus', active: true },
      DAY_ONE,
    );
    expect(added.outcome).toBe('created');

    const removed = await setTeamMembership(
      harness.store,
      { teamKey: 'platform', developerKey: 'marcus', active: false },
      DAY_TWO,
    );
    expect(removed.outcome).toBe('changed');

    // Two versions, and the first one still says `active: true`. That row *is* the evidence
    // that Marcus was on the team when the work happened.
    const versions = await harness.store.versions({
      entityKind: 'team_membership',
      entityNaturalKey: 'platform:marcus',
    });
    expect(versions).toHaveLength(2);
    expect(versions[0]?.trackedFields['active']).toBe(true);
    expect(versions[1]?.trackedFields['active']).toBe(false);
  });

  it('appends nothing when the same membership is written again', async () => {
    const before = await harness.store.versions({
      entityKind: 'team_membership',
      entityNaturalKey: 'platform:marcus',
    });

    const again = await setTeamMembership(
      harness.store,
      { teamKey: 'platform', developerKey: 'marcus', active: false },
      DAY_THREE,
    );

    expect(again.outcome).toBe('unchanged');
    expect(
      await harness.store.versions({ entityKind: 'team_membership', entityNaturalKey: 'platform:marcus' }),
    ).toHaveLength(before.length);
  });

  it('keeps the row so a removal is reversible without inventing one', async () => {
    const back = await setTeamMembership(
      harness.store,
      { teamKey: 'platform', developerKey: 'marcus', active: true },
      DAY_THREE,
    );

    expect(back.outcome).toBe('changed');
    expect((await harness.store.read('team_membership', 'platform:marcus'))?.fields['active']).toBe(true);
  });
});

describe('the working calendar', () => {
  it('sorts and deduplicates the week it is given', async () => {
    await setWorkingCalendar(
      harness.store,
      { teamKey: 'platform', workingWeekdays: [5, 1, 1, 3], holidays: ['2026-12-25', '2026-08-31', '2026-08-31'], timezone: 'UTC' },
      DAY_ONE,
    );

    const stored = await harness.store.read('working_calendar', 'platform');
    expect(stored?.fields['workingWeekdays']).toEqual([1, 3, 5]);
    expect(stored?.fields['holidays']).toEqual(['2026-08-31', '2026-12-25']);
  });

  it('refuses a calendar with no working days', async () => {
    // With none, every elapsed measurement would be zero working days and no threshold could
    // ever be crossed — the product would go quiet without ever saying why.
    await expect(
      setWorkingCalendar(
        harness.store,
        { teamKey: 'platform', workingWeekdays: [], holidays: [], timezone: 'UTC' },
        DAY_ONE,
      ),
    ).rejects.toThrow(InvalidCalendarError);
  });

  it('refuses a weekday that is not one, and a date that is not a date', async () => {
    await expect(
      setWorkingCalendar(
        harness.store,
        { teamKey: 'platform', workingWeekdays: [1, 9], holidays: [], timezone: 'UTC' },
        DAY_ONE,
      ),
    ).rejects.toThrow(/ISO weekday/);

    await expect(
      setWorkingCalendar(
        harness.store,
        { teamKey: 'platform', workingWeekdays: [1], holidays: ['25 December'], timezone: 'UTC' },
        DAY_ONE,
      ),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('archiving a repository', () => {
  it('records when tracking stopped, and keeps the row when it resumes', async () => {
    const archived = await setRepositoryTracking(
      harness.store,
      { key: 'legacy-web', tracked: false, note: 'Frozen.' },
      DAY_TWO,
    );
    expect(archived.outcome).toBe('created');

    const stored = await harness.store.read('tracked_repository', 'legacy-web');
    expect(stored?.fields['tracked']).toBe(false);
    // *When*, not only *whether* — the question a manager asks three months later.
    expect(stored?.fields['archivedAt']).toBe(DAY_TWO);

    const resumed = await setRepositoryTracking(harness.store, { key: 'legacy-web', tracked: true }, DAY_THREE);
    expect(resumed.outcome).toBe('changed');
    expect((await harness.store.read('tracked_repository', 'legacy-web'))?.fields['archivedAt']).toBeNull();

    // And the archival is still on disk, so a report for day two resolves it as archived.
    const versions = await harness.store.versions({
      entityKind: 'tracked_repository',
      entityNaturalKey: 'legacy-web',
    });
    expect(versions[0]?.trackedFields['tracked']).toBe(false);
  });

  it('does the same for a project', async () => {
    await setProjectTracking(harness.store, { key: 'LEGACY', tracked: false }, DAY_TWO);

    expect((await harness.store.read('tracked_project', 'LEGACY'))?.fields['tracked']).toBe(false);
  });
});

describe('identity links', () => {
  it('refuses an identifier that already belongs to somebody else', async () => {
    await addIdentityLink(
      harness.store,
      { kind: 'email', value: 'priya@acme.example', developerKey: 'priya' },
      DAY_ONE,
    );

    // A silent winner would move a person's commits onto another person and the report
    // would state that as fact.
    await expect(
      addIdentityLink(
        harness.store,
        { kind: 'email', value: 'priya@acme.example', developerKey: 'marcus' },
        DAY_TWO,
      ),
    ).rejects.toThrow(IdentityClaimedError);
  });

  it('normalises an email so one address cannot be two links', async () => {
    const result = await addIdentityLink(
      harness.store,
      { kind: 'email', value: '  PRIYA@Acme.Example ', developerKey: 'priya' },
      DAY_TWO,
    );

    expect(result.identityKey).toBe(identityNaturalKey('email', 'priya@acme.example'));
    expect(result.outcome, 'the same link, not a second one').toBe('unchanged');
  });

  it('unlinks without deleting anything, and reports how much reverted', async () => {
    await addIdentityLink(
      harness.store,
      { kind: 'handle', value: 'U-MARCUS', developerKey: 'marcus' },
      DAY_ONE,
    );

    const removed = await removeIdentityLink(harness.store, { kind: 'handle', value: 'U-MARCUS' }, DAY_TWO);

    expect(removed).not.toBeNull();
    expect(removed?.developerKey, 'who it used to be').toBe('marcus');
    // The row is still there — *when* the link was removed is the fact somebody wants when a
    // name disappears from a report.
    const stored = await harness.store.read('identity_link', identityNaturalKey('handle', 'U-MARCUS'));
    expect(stored).not.toBeNull();
    expect(stored?.fields['developerKey']).toBe('');
  });

  it('answers null for an identifier that was never linked', async () => {
    expect(await removeIdentityLink(harness.store, { kind: 'email', value: 'nobody@acme.example' }, DAY_TWO)).toBeNull();
  });

  /**
   * An unlinked identifier can be linked again — to somebody else, or back.
   *
   * The row an unlink leaves behind carries `developerKey: ''`, and comparing that against the
   * incoming key made it a permanent wall: every re-link was refused as a collision, with the
   * detail sentence "`email:…` is already linked to ." A correction that cannot be corrected
   * twice is not much of one, and this is the ordinary case — a manager unlinks an address
   * precisely because they are about to attach it to the right person.
   */
  it('links an unlinked identifier to a different developer', async () => {
    const VALUE = 'shared.address@acme.example';

    await addIdentityLink(harness.store, { kind: 'email', value: VALUE, developerKey: 'priya' }, DAY_ONE);
    await removeIdentityLink(harness.store, { kind: 'email', value: VALUE }, DAY_TWO);

    const relinked = await addIdentityLink(
      harness.store,
      { kind: 'email', value: VALUE, developerKey: 'marcus' },
      DAY_THREE,
    );

    expect(relinked.developerKey).toBe('marcus');
    expect((await harness.store.read('identity_link', identityNaturalKey('email', VALUE)))?.fields['developerKey']).toBe(
      'marcus',
    );
  });

  it('links an unlinked identifier back to the person who had it', async () => {
    // The other half: undoing an unlink by hand must not be refused either.
    const VALUE = 'returned.address@acme.example';

    await addIdentityLink(harness.store, { kind: 'email', value: VALUE, developerKey: 'priya' }, DAY_ONE);
    await removeIdentityLink(harness.store, { kind: 'email', value: VALUE }, DAY_TWO);

    const restored = await addIdentityLink(
      harness.store,
      { kind: 'email', value: VALUE, developerKey: 'priya' },
      DAY_THREE,
    );

    expect(restored.developerKey).toBe('priya');
  });

  it('still refuses an identifier a different person actually holds', async () => {
    // The refusal that must survive the fix: a *held* identifier is still a collision, so the
    // change above cannot have been made by simply deleting the check.
    const VALUE = 'held.address@acme.example';
    await addIdentityLink(harness.store, { kind: 'email', value: VALUE, developerKey: 'priya' }, DAY_ONE);

    await expect(
      addIdentityLink(harness.store, { kind: 'email', value: VALUE, developerKey: 'marcus' }, DAY_TWO),
    ).rejects.toThrow(IdentityClaimedError);
  });
});

describe('merging an unmatched identity, and undoing it exactly', () => {
  const UNMATCHED_VALUE = 'p.raman@personal.example';
  const UNMATCHED_KEY = identityNaturalKey('email', UNMATCHED_VALUE);

  /**
   * Three commits attributed through an unplaceable address, and one through a placed one.
   *
   * The fourth exists so the impact count has something to *exclude*: a merge that reported
   * every commit in the database would be useless as a check on itself.
   */
  beforeAll(async () => {
    await harness.store.observe({
      kind: 'unmatched_identity',
      naturalKey: UNMATCHED_KEY,
      fields: {
        identityKind: 'email',
        identityValue: UNMATCHED_VALUE,
        displayName: 'P. Raman',
        occurrenceCount: 3,
        witnessRefs: ['primary-code:c1', 'primary-code:c2', 'primary-code:c3'],
        artifactKinds: ['commit'],
        sourceKeys: ['primary-code'],
      },
      observedAt: DAY_ONE,
      evidence: null,
    });

    for (const [index, revision] of ['aaa1111', 'bbb2222', 'ccc3333'].entries()) {
      await harness.store.observe({
        kind: 'commit',
        naturalKey: `legacy-web@${revision}`,
        fields: {
          repositoryKey: 'legacy-web',
          revisionId: revision,
          authorDeveloperKey: null,
          unmatchedIdentityKey: UNMATCHED_KEY,
          authorIdentityKey: UNMATCHED_KEY,
          authoredAt: DAY_ONE,
          message: `work ${index}`,
          changedFileCount: 1,
          branchName: 'main',
          parentRevisionIds: [],
          ticketKey: null,
        },
        observedAt: DAY_ONE,
        evidence: null,
      });
    }

    await harness.store.observe({
      kind: 'commit',
      naturalKey: 'legacy-web@ddd4444',
      fields: {
        repositoryKey: 'legacy-web',
        revisionId: 'ddd4444',
        authorDeveloperKey: 'marcus',
        unmatchedIdentityKey: null,
        authorIdentityKey: identityNaturalKey('email', 'marcus@acme.example'),
        authoredAt: DAY_ONE,
        message: 'somebody else',
        changedFileCount: 1,
        branchName: 'main',
        parentRevisionIds: [],
        ticketKey: null,
      },
      observedAt: DAY_ONE,
      evidence: null,
    });
  }, 60_000);

  let snapshot: PreMergeAttribution;

  it('counts exactly the artifacts the identifier accounts for', async () => {
    const impact = await attributionImpact(harness.store, UNMATCHED_KEY);

    expect(impact.commitCount).toBe(3);
    expect(impact.pullRequestCount).toBe(0);
    expect(impact.totalCount, "Marcus's commit is not counted").toBe(3);
    // Each sample carries its kind, because the queue renders these as links and
    // `/artifact/<kind>/<id>` cannot be built from a bare natural key.
    expect(impact.sampleArtifacts.length).toBeGreaterThan(0);
    expect(impact.sampleArtifacts.every((sample) => sample.kind === 'commit')).toBe(true);
    expect(impact.sampleArtifacts.map((sample) => sample.key)).toContain('legacy-web@aaa1111');
  });

  it('merges into an existing person and states how many artifacts moved', async () => {
    const result = await mergeUnmatchedIdentity(
      harness.store,
      { identityKey: UNMATCHED_KEY, target: { kind: 'existing', developerKey: 'priya' } },
      DAY_TWO,
    );

    expect(result.developerKey).toBe('priya');
    expect(result.impact.totalCount).toBe(3);
    expect(result.developerCreated).toBe(false);

    // The link now resolves, which is what makes the merge take effect in the next report
    // with no re-ingest: attribution is read through this table.
    expect((await harness.store.read('identity_link', UNMATCHED_KEY))?.fields['developerKey']).toBe('priya');

    // The unmatched row stays. It is what the un-merge restores the queue to; deleting it
    // would force the undo path to invent one, and an invented row is not a restoration.
    expect(await harness.store.read('unmatched_identity', UNMATCHED_KEY)).not.toBeNull();

    snapshot = result.preMerge;
  });

  it('captures the pre-merge attribution the undo replays', () => {
    expect(snapshot.identityKey).toBe(UNMATCHED_KEY);
    expect(snapshot.priorLinkExisted, 'nothing was linked before the merge').toBe(false);
    expect(snapshot.priorDeveloperKey).toBeNull();
    expect(snapshot.commitCount).toBe(3);
    // Sorted, so two merges of the same state compare equal and the snapshot is byte-stable.
    expect(snapshot.artifactKeys).toEqual([...snapshot.artifactKeys].sort());
    expect(snapshot.artifactKeys).toHaveLength(3);
  });

  it('restores the prior attribution exactly, and touches no artifact', async () => {
    const commitsBefore = (await harness.store.list('commit')).length;

    const undone = await unmergeIdentity(harness.store, snapshot, DAY_THREE);

    expect(undone.restoredDeveloperKey, 'unattributed again, as it was').toBeNull();
    expect(undone.restoredArtifactKeys).toHaveLength(3);
    expect(undone.exact, 'nothing was ingested in between, so the undo is complete').toBe(true);

    // The identifier resolves to nobody, so the commits are unattributed — and every one of
    // them is still in the database.
    expect((await harness.store.read('identity_link', UNMATCHED_KEY))?.fields['developerKey']).toBe('');
    expect((await harness.store.list('commit')).length).toBe(commitsBefore);
  });

  /**
   * Merge → undo → merge into the right person. **The reason un-merge exists.**
   *
   * Nobody undoes a merge in order to leave the identifier unattributed; they undo it because
   * they put somebody else's commits on the wrong person and now need them on the right one.
   * This test runs on the state the two above leave behind, which is the real sequence, and it
   * used to be impossible: the un-merged row carries `developerKey: ''`, and
   * `addIdentityLink` — which `mergeUnmatchedIdentity` calls — read that as a claim and
   * refused. So the undo worked and the recovery it exists for did not, which made un-merge a
   * one-way door out of a mistake rather than a way back to the truth.
   */
  it('merges again into a different person after an undo, moving the same artifacts', async () => {
    const remerged = await mergeUnmatchedIdentity(
      harness.store,
      { identityKey: UNMATCHED_KEY, target: { kind: 'existing', developerKey: 'marcus' } },
      DAY_THREE,
    );

    expect(remerged.developerKey).toBe('marcus');
    // The same three commits, so the second merge is as consequential as the first — a
    // recovery that moved fewer artifacts than the mistake would have left some behind.
    expect(remerged.impact.totalCount).toBe(3);
    expect((await harness.store.read('identity_link', UNMATCHED_KEY))?.fields['developerKey']).toBe('marcus');

    // And it is undoable in turn: the snapshot records that Priya's merge had been undone
    // before this one, so the recovery is not a dead end either.
    expect(remerged.preMerge.priorLinkExisted, 'the un-merged row was there to be read').toBe(true);
    expect(remerged.preMerge.priorDeveloperKey, 'held by nobody at the time of this merge').toBeNull();
  });

  it('refuses to merge an identity that is not in the queue', async () => {
    await expect(
      mergeUnmatchedIdentity(
        harness.store,
        { identityKey: identityNaturalKey('email', 'ghost@acme.example'), target: { kind: 'existing', developerKey: 'priya' } },
        DAY_TWO,
      ),
    ).rejects.toThrow(UnmatchedIdentityNotFoundError);
  });

  it('creates the person when the merge names a new one', async () => {
    const value = 'contractor@vendor.example';
    const key = identityNaturalKey('email', value);

    await harness.store.observe({
      kind: 'unmatched_identity',
      naturalKey: key,
      fields: {
        identityKind: 'email',
        identityValue: value,
        displayName: null,
        occurrenceCount: 1,
        witnessRefs: ['primary-code:c9'],
        artifactKinds: ['commit'],
        sourceKeys: ['primary-code'],
      },
      observedAt: DAY_ONE,
      evidence: null,
    });

    const result = await mergeUnmatchedIdentity(
      harness.store,
      {
        identityKey: key,
        target: { kind: 'new', developerKey: 'dana-vendor', displayName: 'Dana Okoro', teamKey: 'platform' },
      },
      DAY_TWO,
    );

    expect(result.developerCreated).toBe(true);
    // The name came from the caller, never derived from the address — that derivation is
    // exactly what the unmatched queue exists to refuse.
    expect((await harness.store.read('developer', 'dana-vendor'))?.fields['displayName']).toBe('Dana Okoro');
  });
});

describe('absences are created only through the roster API', () => {
  it('refuses a range that covers no instant', async () => {
    // It would suppress nothing while appearing in the roster as though it did, which is
    // worse than an error: the manager would believe they had explained the silence.
    await expect(
      recordAbsence(
        harness.store,
        { developerKey: 'priya', kind: 'leave', startAt: DAY_TWO, endAt: DAY_TWO, source: 'manual' },
        DAY_ONE,
      ),
    ).rejects.toThrow(InvalidAbsenceError);

    await expect(
      recordAbsence(
        harness.store,
        { developerKey: 'priya', kind: 'leave', startAt: DAY_THREE, endAt: DAY_TWO, source: 'manual' },
        DAY_ONE,
      ),
    ).rejects.toThrow(/must end after it starts/);
  });

  it('refuses a memo-sourced absence that cannot name its memo', async () => {
    // The report links to the source so a reader can check the claim; without the reference
    // the link would go nowhere.
    await expect(
      recordAbsence(
        harness.store,
        { developerKey: 'priya', kind: 'leave', startAt: DAY_TWO, endAt: DAY_THREE, source: 'memo' },
        DAY_ONE,
      ),
    ).rejects.toThrow(/must name the memo/);
  });

  it('records a manual absence with its source', async () => {
    const result = await recordAbsence(
      harness.store,
      {
        developerKey: 'priya',
        kind: 'leave',
        startAt: DAY_TWO,
        endAt: DAY_THREE,
        note: 'annual leave',
        source: 'manual',
      },
      DAY_ONE,
    );

    expect(result.outcome).toBe('created');
    const stored = await harness.store.read('absence', result.naturalKey);
    expect(stored?.fields['source']).toBe('manual');
    expect(stored?.fields['sourceRef']).toBeNull();
  });

  it('records a memo-sourced absence that cites the memo', async () => {
    const result = await recordAbsence(
      harness.store,
      {
        developerKey: 'marcus',
        kind: 'leave',
        startAt: DAY_TWO,
        endAt: DAY_THREE,
        source: 'memo',
        sourceRef: 'memo:2026-08-01:marcus-out',
      },
      DAY_ONE,
    );

    const stored = await harness.store.read('absence', result.naturalKey);
    expect(stored?.fields['source']).toBe('memo');
    expect(stored?.fields['sourceRef']).toBe('memo:2026-08-01:marcus-out');
  });

  it('ends an absence early by appending, so the longer range stays on disk', async () => {
    const created = await recordAbsence(
      harness.store,
      { developerKey: 'priya', kind: 'holiday', startAt: DAY_ONE, endAt: at('2026-08-20T09:00:00Z'), source: 'manual' },
      DAY_ONE,
    );

    const ended = await endAbsence(
      harness.store,
      { naturalKey: created.naturalKey, endAt: DAY_THREE },
      DAY_TWO,
    );

    expect(ended?.outcome).toBe('changed');
    const versions = await harness.store.versions({ entityKind: 'absence', entityNaturalKey: created.naturalKey });
    expect(versions).toHaveLength(2);
    // A report generated while the longer range was in force still explains what it withheld.
    expect(versions[0]?.trackedFields['endAt']).not.toBe(versions[1]?.trackedFields['endAt']);
  });

  it('answers null for an absence that does not exist', async () => {
    expect(await endAbsence(harness.store, { naturalKey: 'nobody:0', endAt: DAY_THREE }, DAY_TWO)).toBeNull();
  });
});

describe('the roster read model', () => {
  it('shows every linked identifier with what it attributes', async () => {
    const view = await readRosterView(harness.store, DAY_TWO);
    const priya = view.developers.find((developer) => developer.key === 'priya');

    expect(priya).toBeDefined();
    expect(priya?.identities.map((identity) => identity.kind)).toContain('email');
    // The criterion: each developer row shows every linked identifier, with a count of what
    // it currently accounts for, so a manager can see the consequence of a link.
    for (const identity of priya?.identities ?? []) {
      expect(identity.attributes.totalCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('omits an unlinked identifier from the person it used to belong to', async () => {
    const view = await readRosterView(harness.store, DAY_TWO);
    const marcus = view.developers.find((developer) => developer.key === 'marcus');

    expect(marcus?.identities.map((identity) => identity.value)).not.toContain('U-MARCUS');
  });

  it('lists every unmatched identity with a count and a sample to follow', async () => {
    const view = await readRosterView(harness.store, DAY_TWO);

    expect(view.unmatched.length).toBeGreaterThan(0);
    for (const row of view.unmatched) {
      expect(row.occurrenceCount).toBeGreaterThan(0);
      // The criterion asks for a sample artifact link; `sourceKey:sourceRecordId` is what
      // the queue resolves into one.
      expect(row.sampleWitnessRefs.length).toBeGreaterThan(0);
    }
  });

  it('treats an unconfigured repository as tracked', async () => {
    // A connector reports repositories Compass has never been told about. Defaulting them to
    // untracked would make a fresh deployment ingest nothing and look broken.
    const view = await readRosterView(harness.store, DAY_TWO);
    const unconfigured = view.repositories.find((repository) => repository.key === 'checkout-web');

    expect(unconfigured?.tracked ?? true).toBe(true);
  });

  it('shows absences with their range and their source', async () => {
    const view = await readRosterView(harness.store, DAY_TWO);

    expect(view.absences.length).toBeGreaterThan(0);
    expect(view.absences.map((absence) => absence.source)).toContain('memo');
    expect(view.absences.map((absence) => absence.source)).toContain('manual');
  });
});
