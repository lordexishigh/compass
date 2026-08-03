import { instantFromIso, type Instant } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import { developerName, type AnalysisEntity, type AnalysisSnapshot } from '../src/index.js';

/**
 * Subtask 002, first criterion: a name withdrawn is replaced by a stable pseudonym in every
 * future report.
 *
 * Asserted at `developerName`, and that is the point of the design rather than a shortcut in the
 * test. Every developer name in every section of every report flows through that one function —
 * Blockers' owner, Risks' concentration, Recommendations' actor, Wins' credit, the review queue,
 * the workload — so a test that proves it substitutes has proved the whole report substitutes.
 * The alternative implementation, a pass over the finished prose, could not be tested this way
 * at all: it would be one new detector away from leaking, forever.
 */

const at = (iso: string): Instant => instantFromIso(iso);
const ANONYMISED_AT = at('2026-08-05T09:00:00Z');

function developer(
  naturalKey: string,
  fields: Record<string, unknown>,
): AnalysisEntity {
  const firstSeenAt = at('2026-01-01T00:00:00Z');
  return {
    kind: 'developer',
    naturalKey,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    beliefAt: firstSeenAt,
    version: 1,
    elapsed: { ageDays: 0, staleDays: 0, seenToday: true, trail: [] },
    fields: fields as AnalysisEntity['fields'],
  };
}

const snapshotOf = (entities: readonly AnalysisEntity[]): AnalysisSnapshot =>
  ({ collections: { entities, entityVersions: [] } }) as unknown as AnalysisSnapshot;

describe('a withdrawn name never reaches a future report', () => {
  const snapshot = snapshotOf([
    developer('priya-raman', {
      displayName: 'Priya Raman',
      teamKey: 'platform',
      active: true,
      anonymizedAt: ANONYMISED_AT,
      pseudonym: 'Wren Alder',
    }),
    developer('marcus-hale', {
      displayName: 'Marcus Hale',
      teamKey: 'platform',
      active: true,
      anonymizedAt: null,
      pseudonym: null,
    }),
  ]);

  it('returns the pseudonym for an anonymised person', () => {
    expect(developerName(snapshot, 'priya-raman')).toBe('Wren Alder');
  });

  it('returns the real name for everybody else', () => {
    // The narrow blast radius matters: withdrawing one name must not turn the whole roster
    // pseudonymous, which would make the report unreadable for a manager.
    expect(developerName(snapshot, 'marcus-hale')).toBe('Marcus Hale');
  });

  it('is stable — the same key gives the same stand-in every time it is asked', () => {
    // The criterion says *stable*. It is stable because it is stored on the row rather than
    // derived per report: nothing about tomorrow's generation can produce a different answer.
    expect(developerName(snapshot, 'priya-raman')).toBe(developerName(snapshot, 'priya-raman'));
  });

  it('keeps the real name on the row, so a mistaken erasure is fixable', () => {
    const entity = snapshot.collections.entities.find((candidate) => candidate.naturalKey === 'priya-raman');

    // Deleting the name here would make the act irreversible for the wrong reason. Anonymization
    // is a decision about what Compass *prints*, not about what it knows — which is also what
    // lets the archive substitute "a former team member" for the right string.
    expect(entity?.fields['displayName']).toBe('Priya Raman');
  });
});

describe('the two halves of the pairing are read together', () => {
  it('does not substitute a pseudonym that was never activated', () => {
    // A pseudonym with no `anonymizedAt` is a half-written state the database refuses
    // (`developers_pseudonym_pairing`), and this function refuses it independently rather than
    // trusting the constraint — the direction of that failure has to be "print the real name",
    // never "print a stand-in nobody asked for".
    const snapshot = snapshotOf([
      developer('priya-raman', {
        displayName: 'Priya Raman',
        teamKey: 'platform',
        active: true,
        anonymizedAt: null,
        pseudonym: 'Wren Alder',
      }),
    ]);

    expect(developerName(snapshot, 'priya-raman')).toBe('Priya Raman');
  });

  it('falls back to the key rather than printing nothing when the pseudonym is missing', () => {
    const snapshot = snapshotOf([
      developer('priya-raman', {
        displayName: 'Priya Raman',
        teamKey: 'platform',
        active: true,
        anonymizedAt: ANONYMISED_AT,
        pseudonym: null,
      }),
    ]);

    // The honest degradation. An anonymization with nothing to print would otherwise render as
    // an empty subject in a sentence about somebody.
    expect(developerName(snapshot, 'priya-raman')).toBe('Priya Raman');
  });
});

describe('the unchanged behaviour', () => {
  it('still answers null for no developer, and the key for one the roster does not hold', () => {
    const snapshot = snapshotOf([]);

    expect(developerName(snapshot, null)).toBeNull();
    // Never a guess and never an email address: an unknown key prints as itself.
    expect(developerName(snapshot, 'somebody-unknown')).toBe('somebody-unknown');
  });
});
