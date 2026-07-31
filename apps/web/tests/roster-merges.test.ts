import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findAuditLogEntry } from '@compass/db';
import {
  IdentityClaimedError,
  InvalidAbsenceError,
  InvalidCalendarError,
  UnmatchedIdentityNotFoundError,
} from '@compass/knowledge-model';
import { describe, expect, it } from 'vitest';

import { MergeRecordNotFoundError, UNAVAILABLE_SENTENCE, failure } from '../lib/auth/http';

/**
 * Undoing a merge: the refusal it gives, and how it finds the record it replays.
 *
 * Both halves of this file guard the same failure mode, which is worth stating because it is
 * subtle. An un-merge is the *only* recovery from a wrong identity merge — every report
 * generated after the merge states the wrong attribution as fact — so the two ways it can
 * become unavailable both matter more than they look:
 *
 *  1. **It could not find the record.** The merge's own audit row carries the pre-merge
 *     attribution, and it cannot be recomputed afterwards. Locating that row by scanning the
 *     newest N audit entries meant an un-merge silently became impossible once the
 *     organization had written N more rows — and this log takes one from every configuration
 *     write, every seat change and every sign-in.
 *  2. **It found nothing and said the wrong thing about it.** An unregistered domain error
 *     falls through `failure()` to the generic 503, which tells the caller Compass could not
 *     reach its own records — sending them to check the database when the fix is the
 *     identifier they sent.
 */
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string => readFileSync(join(WEB_ROOT, ...parts), 'utf8');

const ROSTER_SOURCE = read('lib', 'roster-source.ts');

// ---------------------------------------------------------------------------
// 1. The refusal DELETE /api/roster/merges gives
// ---------------------------------------------------------------------------

describe('an un-merge naming a merge that is not in the log', () => {
  it('is a 404 carrying the error’s own sentence, not a 503', async () => {
    // The whole regression in one assertion. `failure()` is what every roster handler
    // returns on a throw, so this is the response DELETE actually produces.
    const response = failure(new MergeRecordNotFoundError('11111111-2222-4333-8444-555555555555'));

    expect(response.status, 'a well-formed request with an unknown id is not a server fault').toBe(404);

    const body = (await response.json()) as { readonly error: string; readonly detail: string };
    expect(body.error).toBe('merge_record_not_found');
    expect(body.detail).toContain('11111111-2222-4333-8444-555555555555');
    // It says *why* a guess is not on offer, rather than only that it failed.
    expect(body.detail).toContain('guessed restoration is not one');
  });

  it('does not answer with the generic unavailable sentence', async () => {
    const response = failure(new MergeRecordNotFoundError('nope'));
    const body = (await response.json()) as { readonly detail: string };

    // Before the fix this was the 503 body: it blames the infrastructure for the caller's
    // typo and points them at `/api/health`, where they would find nothing wrong.
    expect(response.status).not.toBe(503);
    expect(body.detail).not.toBe(UNAVAILABLE_SENTENCE);
    expect(body.detail).not.toContain('could not reach its own records');
  });

  it('is answered no-store, like every other response on a seated route', () => {
    expect(failure(new MergeRecordNotFoundError('nope')).headers.get('cache-control')).toBe('no-store');
  });

  it('still falls through to 503 for an error nothing has classified', async () => {
    // The registration must be specific. A blanket 404 would hide a real outage behind
    // "no such merge record", which is the opposite mistake.
    const response = failure(new Error('the pool is gone'));
    const body = (await response.json()) as { readonly detail: string };

    expect(response.status).toBe(503);
    expect(body.detail).toBe(UNAVAILABLE_SENTENCE);
    // And the driver's own words never reach the caller.
    expect(body.detail).not.toContain('the pool is gone');
  });

  it('lives where `failure()` can see it, so the mapping cannot be forgotten again', () => {
    // `http.ts` is imported by `guard.ts` and `roster-source.ts` imports `@compass/auth`, so
    // defining the class in `roster-source.ts` and importing it here would be a cycle. The
    // class therefore lives in `http.ts` and is re-exported from the module that throws it.
    expect(read('lib', 'auth', 'http.ts')).toContain('export class MergeRecordNotFoundError');
    expect(ROSTER_SOURCE).toContain('export { MergeRecordNotFoundError }');
    expect(ROSTER_SOURCE).toMatch(/import \{ MergeRecordNotFoundError \} from '\.\/auth\/http'/);
  });
});

// ---------------------------------------------------------------------------
// 1b. The roster service's refusals, which `failure()` used to call an outage
// ---------------------------------------------------------------------------

/**
 * Four caller-fixable refusals that reached the caller as 503 "Compass could not reach its own
 * records".
 *
 * Each class is thrown by the roster service and carries a `detail` written for the person who
 * sent the request — "an absence must end after it starts", "use 1 for Monday through 7 for
 * Sunday", "remove the existing link first". Unregistered in `failure()`, every one of those
 * sentences was logged and discarded, and the reader was sent to `/api/health` to investigate
 * an outage that was not happening.
 */
describe('a roster refusal the caller can act on', () => {
  it('answers 400 with the absence error’s own sentence', async () => {
    const response = failure(new InvalidAbsenceError('An absence must end after it starts.'));

    expect(response.status, 'the body is wrong, not the database').toBe(400);

    const body = (await response.json()) as { readonly error: string; readonly detail: string };
    expect(body.error).toBe('invalid_absence');
    expect(body.detail).toBe('An absence must end after it starts.');
    expect(body.detail).not.toBe(UNAVAILABLE_SENTENCE);
    expect(body.detail).not.toContain('could not reach its own records');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 400 for a calendar that would silence the product', async () => {
    const response = failure(new InvalidCalendarError('A working calendar needs at least one working day.'));
    const body = (await response.json()) as { readonly error: string; readonly detail: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_calendar');
    expect(body.detail).toContain('at least one working day');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 409 for an identifier somebody else holds, not 400', async () => {
    // The request was well formed; the *state* is the problem, and the detail says what to do
    // instead. A 400 would send the reader looking at their JSON. Same reasoning as
    // `LastOwnerError`.
    const response = failure(new IdentityClaimedError('email:priya@acme.example', 'priya'));
    const body = (await response.json()) as { readonly error: string; readonly detail: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe('identity_claimed');
    expect(body.detail).toContain('already linked to priya');
    expect(body.detail).toContain('remove the existing link first');
  });

  it('answers 404 for an unmatched identity that is not in the queue', async () => {
    const response = failure(new UnmatchedIdentityNotFoundError('email:ghost@acme.example'));
    const body = (await response.json()) as { readonly error: string; readonly detail: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe('unmatched_identity_not_found');
    expect(body.detail).toContain('ghost@acme.example');
  });

  it('still answers 503 for an error nothing has classified', async () => {
    // The registrations have to stay specific: a roster route must still report a genuine
    // outage as one, or these four branches would hide the failure they were added to stop
    // masquerading as.
    const response = failure(new Error('connection terminated unexpectedly'));
    const body = (await response.json()) as { readonly detail: string };

    expect(response.status).toBe(503);
    expect(body.detail).toBe(UNAVAILABLE_SENTENCE);
    expect(body.detail).not.toContain('connection terminated');
  });
});

// ---------------------------------------------------------------------------
// 2. How the record is found
// ---------------------------------------------------------------------------

describe('finding the merge record', () => {
  it('looks it up by id rather than scanning a window of the log', () => {
    expect(ROSTER_SOURCE).toContain('findAuditLogEntry(scoped, input.mergeAuditId)');

    // The specific bug: any fixed window makes an older merge un-undoable.
    expect(ROSTER_SOURCE, 'undoMerge must not page a fixed slice of the audit log').not.toMatch(
      /listAuditLogEntries\([^)]*limit/,
    );
    expect(ROSTER_SOURCE).not.toContain('limit: 500');
  });

  it('imports it statically, because there is no cycle to dodge', () => {
    // The module already imports from `@compass/db` at the top, so the dynamic
    // `await import('@compass/db')` bought nothing and hid the dependency from a reader.
    // Asserted as "a top-level import from @compass/db that brings in findAuditLogEntry",
    // not as an exact string: the member order and the `type` modifier on `ScopedDb` are
    // lint's business, and pinning them here would make this test fail on a formatting fix.
    expect(ROSTER_SOURCE).toMatch(/^import \{[^}]*\bfindAuditLogEntry\b[^}]*\} from '@compass\/db';$/m);
    expect(ROSTER_SOURCE).not.toContain("await import('@compass/db')");
  });

  it('is a real export of @compass/db, not a name this test invented', () => {
    // Guards the two source scans above: they would both pass against a function that does
    // not exist. Called rather than merely referenced, so a type-only export fails here.
    expect(typeof findAuditLogEntry).toBe('function');
    expect(findAuditLogEntry.length, 'takes (scoped, id)').toBe(2);
  });

  it('verifies the row is a merge before replaying it', () => {
    // An id that names some other privileged act — a seat change, a sign-in — must not be
    // replayed as an attribution restoration.
    expect(ROSTER_SOURCE).toContain("merge.action !== 'identity.merged'");
    expect(ROSTER_SOURCE).toContain('isPreMergeAttribution(snapshot)');
  });
});

// ---------------------------------------------------------------------------
// 3. The audit rows that used to state an assumed prior value
// ---------------------------------------------------------------------------

describe('audit rows read the prior value rather than inferring it', () => {
  it('reads the existing membership instead of asserting `active: !input.active`', () => {
    // A membershipRole change appends a version with `active` unchanged, so the inferred
    // prior value was the opposite of the truth — the one thing an audit row must never be.
    expect(ROSTER_SOURCE).not.toContain('before: { active: !input.active }');
    expect(ROSTER_SOURCE).toContain("store.read('team_membership', teamMembershipKey(input.teamKey, input.developerKey))");
  });

  it('reads the identifier’s current owner instead of recording nobody', () => {
    // Re-pointing an already-linked identifier is exactly when this matters: `null` would
    // erase the fact that the act took work off somebody else.
    expect(ROSTER_SOURCE).not.toContain('before: { developerKey: null },');
    expect(ROSTER_SOURCE).toContain("store.read('identity_link', rosterIdentityKey(input.kind, input.value))");
  });
});

// ---------------------------------------------------------------------------
// 4. Absence provenance is not caller-controlled
// ---------------------------------------------------------------------------

describe('the provenance an absence is recorded with', () => {
  const ABSENCES = read('app', 'api', 'roster', 'absences', 'route.ts');

  it('is decided by the route, so `memo` cannot be forged over HTTP', () => {
    // The roster screen displays "from a manager memo" and the `sourceRef` beside it. A
    // caller who could set both would be choosing what the roster asserts about its own
    // records. Memo-sourced absences are written in-process by the memo path instead.
    expect(ABSENCES).toContain("source: 'manual'");
    expect(ABSENCES).toContain('sourceRef: null');
    expect(ABSENCES, 'sourceRef must not be read from the body at all').not.toContain("parsed.body['sourceRef']");
  });

  it('refuses an unrecognised source rather than coercing it to `manual`', () => {
    expect(ABSENCES).toContain("rawSource !== undefined && rawSource !== 'manual'");
    // Silently storing something other than what was sent is how a caller's wrong belief
    // survives to mislead whoever reads the roster later.
    expect(ABSENCES).not.toMatch(/\?\s*\(rawSource as 'manual' \| 'memo'\)\s*:\s*'manual'/);
  });

  it('hands the branded Instant straight through, with no `as never`', () => {
    // `as never` at the one boundary the brand exists to guard is worse than no brand.
    // Matched against the call sites rather than the whole file: the doc comment on
    // `readInstant` names the cast it exists to have removed, and would match a bare scan.
    expect(ABSENCES).toContain('readonly value: Instant');
    expect(ABSENCES).not.toMatch(/\.value as never/);
  });

  it('ends an absence at the edge’s instant when the body names none', () => {
    // The end instant governs report suppression, so a skewed browser clock must not choose
    // it. PATCH defaults `endAt` to `admitted.now` — the instant the guard resolved — and the
    // screen's "end it now" button therefore sends no date at all.
    expect(ABSENCES).toContain("parsed.body['endAt'] === undefined ? { value: admitted.now }");
  });
});

// ---------------------------------------------------------------------------
// 5. The roster screen's four boundary conversions
// ---------------------------------------------------------------------------

describe('the roster screen', () => {
  const SCREEN = read('components', 'roster-screen.tsx');

  it('refreshes through the router, so the outcome sentence survives the re-read', () => {
    // `window.location.reload()` unloaded the document in the same tick as `setStated`, so
    // every success sentence was set and thrown away — including the artifacts-affected count
    // that is the whole reason the identities route computes one.
    expect(SCREEN).toContain('useRouter');
    expect(SCREEN).toContain('router.refresh()');
    // Matched in statement position, not as a bare substring — same reason as the `as never`
    // test above. The doc comment on `settle` names the reload it exists to have removed, so a
    // whole-file scan would be failed by the very sentence explaining the fix.
    expect(SCREEN, 'a full-page reload discards the message it was just given').not.toMatch(
      /^\s*window\.location\.reload\(\)/m,
    );
  });

  it('sends no browser-derived instant when ending an absence now', () => {
    expect(SCREEN).not.toContain('onEnd(absence.naturalKey, new Date().toISOString())');
    expect(SCREEN).toContain('onEnd(absence.naturalKey)');
  });

  it('treats the picked "until" date as covered, and displays the bound as the last covered day', () => {
    // Half-open `[start, end)` is correct and tested in `@compass/analysis`; the conversion
    // from a human's inclusive "until" is what was wrong. "Out until 7 Aug" that covers no
    // instant on the 7th is an absence that suppresses nothing while the roster shows a range
    // reading as though it does.
    expect(SCREEN).toContain('inclusiveEndInstant');
    expect(SCREEN).toContain('+ DAY_MILLIS');
    expect(SCREEN).toContain('lastCoveredDay');
    expect(SCREEN, 'the raw exclusive bound must not be rendered as the end of the range').not.toMatch(
      /→ \{dateOf\(absence\.endAt\)\}/,
    );
  });

  it('renders a sample artifact as a link rather than as mono text', () => {
    // The criterion asks for "a sample artifact link". `artifactHref` builds it at the web
    // edge, from the kind the read model now carries alongside the key.
    expect(SCREEN).toContain('row.sampleLinks');
    expect(SCREEN).toContain('href={sample.href}');
    expect(read('lib', 'roster-source.ts')).toContain('artifactHref(sample.kind, sample.key)');
  });
});
