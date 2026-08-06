import { instantFromIso, type Instant } from '@compass/clock';
import { users } from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { KnowledgeStore, upsertDeveloper, upsertTeam } from '@compass/knowledge-model';
import { DeterministicExtractor, REFUSAL_SENTENCE, submitMemo } from '@compass/memos';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `submitMemo` against a real migrated PostgreSQL 17.
 *
 * The guarantees under test are database-shaped, so a mock would accept every violation:
 * "persists nothing on a refusal" is a claim about row counts, "writes the Absence through the
 * roster service" is a claim about which table grew, and the closed-five CHECK constraint only
 * exists in the engine.
 */

const ORGANIZATION_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const ZONE = 'Europe/London';
const at = (iso: string): Instant => instantFromIso(iso);

const SUBMITTED_AT = at('2026-07-24T09:00:00Z'); // a Friday
const AUTHOR = '33333333-3333-4333-8333-333333333333';

let database: TestDatabase;
let store: KnowledgeStore;

const extractor = new DeterministicExtractor();

const submit = (rawText: string, overrides: Record<string, unknown> = {}) =>
  submitMemo(
    { scoped: database.scopedFor(ORGANIZATION_ID), extractor },
    {
      rawText,
      channel: 'web',
      authorUserId: AUTHOR,
      now: SUBMITTED_AT,
      timezone: ZONE,
      ...overrides,
    },
  );

const countOf = async (table: string): Promise<number> => {
  const result = await database.client.query<{ count: string }>(`select count(*)::text as count from "${table}"`);
  return Number.parseInt(result.rows[0]?.count ?? '0', 10);
};

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Retail',
    slug: 'northwind-retail',
    timezone: ZONE,
    at: new Date(Date.parse('2026-05-01T00:00:00Z')),
  });

  store = new KnowledgeStore(database.scopedFor(ORGANIZATION_ID));

  // A real user row, because `audit_log_entries.actor_user_id` is a foreign key. Worth stating
  // rather than working around: it means every memo genuinely lands in the audit log against a
  // real person, which is the acceptance criterion, and a memo written by a phantom author
  // would fail here rather than quietly logging to nobody.
  await database
    .scopedFor(ORGANIZATION_ID)
    .insertInto(users, {
      id: AUTHOR,
      email: 'priya@example.com',
      displayName: 'Priya Raman',
      passwordHash: null,
      createdAt: new Date(Date.parse('2026-05-01T00:00:00Z')),
      updatedAt: new Date(Date.parse('2026-05-01T00:00:00Z')),
    })
    .execute();

  await upsertTeam(
    store,
    {
      key: 'platform',
      name: 'Platform',
      methodology: 'scrum',
      projectKey: 'PLAT',
      objectiveKey: null,
      conversationKey: null,
      timezone: ZONE,
    },
    SUBMITTED_AT,
  );

  // Two people who share a first name — the case subject resolution must refuse to guess —
  // plus one whose first name is unique.
  for (const [key, displayName] of [
    ['marcus-hale', 'Marcus Hale'],
    ['marcus-webb', 'Marcus Webb'],
    ['priya-raman', 'Priya Raman'],
  ] as const) {
    await upsertDeveloper(store, { key, displayName, teamKey: 'platform', active: true }, SUBMITTED_AT);
  }
}, 120_000);

afterAll(async () => {
  await database?.close();
});

// ---------------------------------------------------------------------------
// The subject, and the refusal to guess between two of them
// ---------------------------------------------------------------------------

describe('a memo naming somebody two people could be', () => {
  it('offers candidates and persists nothing', async () => {
    const before = await countOf('manager_memos');

    const outcome = await submit('Marcus is out until Wednesday');

    expect(outcome.status).toBe('needs_subject');
    if (outcome.status !== 'needs_subject') return;

    // Named, so the manager picks rather than retyping.
    expect(outcome.candidates.map((candidate) => candidate.label).sort()).toEqual([
      'Marcus Hale',
      'Marcus Webb',
    ]);
    expect(outcome.candidates.length).toBeGreaterThanOrEqual(2);
    expect(outcome.candidates.length).toBeLessThanOrEqual(3);

    // **Nothing was written.** A memo bound to a guessed person would suppress the wrong
    // person's findings for a week and keep reporting the right person's, with nothing
    // anywhere reading as an error.
    expect(await countOf('manager_memos')).toBe(before);
    expect(await countOf('absences')).toBe(0);
  });

  it('never resolves on first-name similarity alone', async () => {
    // The criterion in one assertion: two developers share "Marcus", so no confidence score
    // and no tie-breaker may bind one. Every tie-breaker available here — recency, alphabet,
    // team — is a coin toss wearing a reason.
    const outcome = await submit('Marcus is on leave next week');
    expect(outcome.status).toBe('needs_subject');
  });

  it('binds the memo once a candidate is chosen, and records the disambiguation', async () => {
    // Only the key travels. The alternatives are re-derived from the store, so the row records the
    // offer Compass made rather than the caller's account of it.
    const outcome = await submit('Marcus is out until Wednesday', { chosenSubjectKey: 'marcus-hale' });

    expect(outcome.status).toBe('recorded');
    if (outcome.status !== 'recorded') return;
    expect(outcome.subjectKey).toBe('marcus-hale');

    const stored = await store.read('manager_memo', outcome.memoKey);
    expect(stored?.fields['subjectKey']).toBe('marcus-hale');
    expect(stored?.fields['disambiguatedByUserId']).toBe(AUTHOR);
    // What they chose *between*, so "why Hale and not Webb" is answerable later.
    expect(stored?.fields['subjectCandidates']).not.toBeNull();

    const audit = await database.client.query<{ action: string }>(
      "select action from audit_log_entries where target_id = $1 order by action",
      [outcome.memoKey],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['memo.created', 'memo.disambiguated']);
  });

  /**
   * The stored candidate list is evidence, not testimony.
   *
   * `subjectCandidates` is the answer to "why Marcus Hale rather than Marcus Webb". It used to be
   * whatever the caller posted beside its choice, which meant a caller could bind a memo to any
   * key at all and write its own account of the alternatives next to it — the record and the
   * thing it was supposed to record came from the same untrusted place.
   */
  it('refuses a chosen subject that is not among the candidates it would offer', async () => {
    const before = await countOf('manager_memos');

    const outcome = await submit('Marcus is out until Wednesday', { chosenSubjectKey: 'priya-raman' });

    // Priya is a real person and still not an answer to "which Marcus": she was never offered.
    expect(outcome.status).toBe('needs_subject');
    if (outcome.status !== 'needs_subject') return;
    expect(outcome.candidates.map((candidate) => candidate.subjectKey).sort()).toEqual([
      'marcus-hale',
      'marcus-webb',
    ]);

    expect(await countOf('manager_memos'), 'a forged choice must not write a memo').toBe(before);
  });

  it('records the candidates it derived itself, not the ones it was handed', async () => {
    const outcome = await submit('Marcus is out until Wednesday', { chosenSubjectKey: 'marcus-webb' });

    expect(outcome.status).toBe('recorded');
    if (outcome.status !== 'recorded') return;

    const stored = await store.read('manager_memo', outcome.memoKey);
    const candidates = stored?.fields['subjectCandidates'] as readonly { subjectKey: string; label: string }[] | null;

    expect(candidates).not.toBeNull();
    expect(candidates?.map((candidate) => candidate.subjectKey).sort()).toEqual(['marcus-hale', 'marcus-webb']);
    // The label is Compass's too — a caller cannot relabel the person it bound the memo to.
    expect(outcome.subjectLabel).toBe('Marcus Webb');
  });

  it('resolves a unique first name without asking', async () => {
    // Only one Priya, so this is not a guess between people — it is the only person it can be.
    const outcome = await submit('Priya is out until Wednesday');

    expect(outcome.status).toBe('recorded');
    if (outcome.status !== 'recorded') return;
    expect(outcome.subjectKey).toBe('priya-raman');
  });

  it('refuses a person the roster has never heard of, rather than inventing them', async () => {
    const outcome = await submit('Fenella is out until Wednesday');

    expect(outcome.status).toBe('subject_unknown');
    if (outcome.status !== 'subject_unknown') return;
    expect(outcome.detail).toContain('roster');
  });
});

// ---------------------------------------------------------------------------
// The refusal path writes nothing at all
// ---------------------------------------------------------------------------

describe('a line Compass cannot represent', () => {
  it('answers with the refusal sentence and inserts no memo', async () => {
    const before = await countOf('manager_memos');

    const outcome = await submit('Please send the report an hour earlier from now on');

    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.message).toBe(REFUSAL_SENTENCE);

    // Asserted against the table rather than a spy: the criterion is that no memo exists, and
    // a spy on the repository would still pass if some other path wrote one.
    expect(await countOf('manager_memos')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// `unavailable` becomes an Absence — through the roster service
// ---------------------------------------------------------------------------

describe('an accepted `unavailable` memo', () => {
  it('writes an Absence carrying the memo as its source', async () => {
    const outcome = await submit('Priya is out Jul 27–Aug 2');

    expect(outcome.status).toBe('recorded');
    if (outcome.status !== 'recorded') return;
    expect(outcome.absenceKey).not.toBeNull();

    const absence = await store.read('absence', outcome.absenceKey ?? '');
    expect(absence).not.toBeNull();
    expect(absence?.fields['developerKey']).toBe('priya-raman');

    // The provenance the roster screen displays and the report links to. `source: 'memo'`
    // cannot be forged over HTTP — `/api/roster/absences` refuses it — so a memo-sourced
    // absence is exactly one that came through this path.
    expect(absence?.fields['source']).toBe('memo');
    expect(absence?.fields['sourceRef']).toBe(outcome.memoKey);
  });

  it('states what it will do to tomorrow’s report', async () => {
    const outcome = await submit('Priya is off sick today');
    expect(outcome.status).toBe('recorded');
    if (outcome.status !== 'recorded') return;

    // The reply is the manager's only confirmation that the memo will change anything, so it
    // names the effect rather than saying "saved".
    expect(outcome.detail).toContain('withheld');
    expect(outcome.detail).toContain('link back to this memo');
  });

  it('does not write an Absence for a kind that is not about somebody being out', async () => {
    const before = await countOf('absences');

    const outcome = await submit('For context, the team is short-staffed this week');

    expect(outcome.status).toBe('recorded');
    expect(await countOf('absences')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The closed five, in the engine
// ---------------------------------------------------------------------------

describe('the database itself', () => {
  it('refuses a sixth memo kind', async () => {
    // The application validator is the half a manager reads. This is the half that makes a
    // sixth kind unwritable by any path at all — a script, a migration, a psql session.
    await expect(
      database.client.query(
        `update "manager_memos" set memo_kind = 'deprioritised_maybe' where organization_id = $1`,
        [ORGANIZATION_ID],
      ),
    ).rejects.toThrow(/manager_memos_kind_check/i);
  });

  it('refuses a memo that is both open-ended and closed', async () => {
    await expect(
      database.client.query(
        `update "manager_memos" set open_ended = true where organization_id = $1 and effective_until is not null`,
        [ORGANIZATION_ID],
      ),
    ).rejects.toThrow(/manager_memos_effective_window_check/i);
  });

  it('refuses a source channel outside the three intakes', async () => {
    await expect(
      database.client.query(`update "manager_memos" set source_channel = 'carrier_pigeon' where organization_id = $1`, [
        ORGANIZATION_ID,
      ]),
    ).rejects.toThrow(/manager_memos_source_channel_check/i);
  });
});
