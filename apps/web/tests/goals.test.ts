import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { instantFromIso } from '@compass/clock';
import type { GoalNodeRevisionRow } from '@compass/db';
import { describe, expect, it } from 'vitest';

import { InvalidGoalRequestError, goalInputFrom } from '../lib/goal-source';

/**
 * The goal editing surface: its validator, and its wiring to the endpoints.
 *
 * The validator is tested because this is the one surface a human types into, and
 * because every message it produces is read by somebody who has just been told
 * their request failed. A 500 with no field name would make the whole feature feel
 * broken rather than the request wrong.
 *
 * The wiring is tested because "the endpoint exists" and "the page can reach it"
 * are different claims, and the second is the one that fails silently. A form that
 * validates beautifully and posts to a path nothing serves is the exact shape of
 * that failure.
 */
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string => readFileSync(join(WEB_ROOT, ...parts), 'utf8');

const JULY = instantFromIso('2026-07-01T00:00:00Z');

const priorRevision = (overrides: Partial<GoalNodeRevisionRow> = {}): GoalNodeRevisionRow => ({
  nodeId: 'OBJ-Q3-PLAT',
  revision: 1,
  objectiveKind: 'quarter',
  parentNodeId: 'OBJ-CO-1',
  title: 'Cut p95 payment gateway latency below 400 ms',
  effectiveFrom: JULY,
  effectiveUntil: instantFromIso('2026-09-30T00:00:00Z'),
  isCurrent: true,
  archived: false,
  origin: 'observed',
  subjectKind: null,
  subjectKey: null,
  recordedAt: JULY,
  recordedBy: null,
  changeNote: null,
  ...overrides,
});

const CREATE = {
  nodeId: 'OBJ-Q4-PLAT',
  kind: 'quarter',
  parentNodeId: 'OBJ-CO-1',
  title: 'Hold p95 under 400 ms through the peak',
  effectiveFrom: '2026-10-01T00:00:00Z',
  effectiveUntil: '2026-12-31T00:00:00Z',
  isCurrent: false,
} as const;

describe('validating a goal a human typed', () => {
  it('accepts a complete create and marks it as declared', () => {
    const input = goalInputFrom(CREATE, null);

    expect(input.nodeId).toBe('OBJ-Q4-PLAT');
    expect(input.objectiveKind).toBe('quarter');
    expect(input.effectiveFrom).toBe(instantFromIso('2026-10-01T00:00:00Z'));
    expect(input.isCurrent).toBe(false);
    // `declared` is what stops the next ingest quietly reverting the edit.
    expect(input.origin).toBe('declared');
    expect(input.archived).toBe(false);
  });

  it('inherits every unsent field from the open revision on an edit', () => {
    // A PATCH carrying one field must not blank the rest. This is the difference
    // between "rename the goal" and "erase its horizon".
    const input = goalInputFrom({ title: 'Cut p95 below 250 ms' }, priorRevision());

    expect(input.title).toBe('Cut p95 below 250 ms');
    expect(input.nodeId).toBe('OBJ-Q3-PLAT');
    expect(input.parentNodeId).toBe('OBJ-CO-1');
    expect(input.effectiveFrom).toBe(JULY);
    expect(input.effectiveUntil).toBe(instantFromIso('2026-09-30T00:00:00Z'));
    expect(input.isCurrent).toBe(true);
  });

  it('carries a sprint goal subject forward, so an edit does not detach it', () => {
    const input = goalInputFrom(
      { title: 'Cut p95 below 250 ms' },
      priorRevision({
        nodeId: 'PLAT/Sprint 46',
        objectiveKind: 'sprint_goal',
        subjectKind: 'sprint',
        subjectKey: 'primary-tracker:sprint-PLAT-6',
      }),
    );

    expect(input.subjectKind).toBe('sprint');
    expect(input.subjectKey).toBe('primary-tracker:sprint-PLAT-6');
  });

  it('lets an edit clear an open-ended horizon and set one', () => {
    const input = goalInputFrom({ effectiveUntil: null }, priorRevision());
    expect(input.effectiveUntil).toBeNull();
  });

  it.each([
    [{ ...CREATE, nodeId: '' }, 'nodeId'],
    [{ ...CREATE, title: '   ' }, 'title'],
    [{ ...CREATE, kind: 'objective' }, 'kind'],
    [{ ...CREATE, effectiveFrom: 'last Tuesday' }, 'effectiveFrom'],
    [{ ...CREATE, effectiveFrom: undefined }, 'effectiveFrom'],
  ])('names the field it refused (%#)', (body, field) => {
    let thrown: unknown;
    try {
      goalInputFrom(body as Record<string, unknown>, null);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvalidGoalRequestError);
    expect((thrown as InvalidGoalRequestError).detail).toContain(field);
  });

  it('refuses a horizon that ends before it starts', () => {
    expect(() =>
      goalInputFrom({ ...CREATE, effectiveUntil: '2026-09-01T00:00:00Z' }, null),
    ).toThrow(/must be after/);
  });

  it('refuses a company objective with a parent, since it is the root of the chain', () => {
    expect(() => goalInputFrom({ ...CREATE, kind: 'company', parentNodeId: 'OBJ-CO-0' }, null)).toThrow(
      /root of the chain/,
    );
  });

  it('reads a checkbox string as a boolean, since a form sends text', () => {
    expect(goalInputFrom({ ...CREATE, isCurrent: 'true' }, null).isCurrent).toBe(true);
    expect(goalInputFrom({ ...CREATE, isCurrent: 'false' }, null).isCurrent).toBe(false);
  });
});

describe('the editing surface reaches the endpoints it is built on', () => {
  const editor = read('components', 'goal-editor.tsx');
  const collection = read('app', 'api', 'goals', 'route.ts');
  const item = read('app', 'api', 'goals', '[nodeId]', 'route.ts');

  it('serves create, read, update and archive', () => {
    expect(collection).toContain('export async function GET');
    expect(collection).toContain('export async function POST');
    expect(item).toContain('export async function GET');
    expect(item).toContain('export async function PATCH');
    expect(item).toContain('export async function DELETE');
  });

  it('calls each of them from the page rather than describing them', () => {
    // One `fetch` for all four verbs, so the error and confirmation handling
    // cannot differ between them.
    expect(editor).toContain('await fetch(input,');
    expect(editor).toContain("submit('/api/goals'");
    expect(editor).toContain("method: 'POST'");
    expect(editor).toContain("method: 'PATCH'");
    expect(editor).toContain("method: 'DELETE'");
    expect(editor).toContain('/api/goals/${encodeURIComponent(');
  });

  it('reads the endpoint own error detail rather than inventing a message', () => {
    expect(editor).toContain("body['detail']");
  });

  it('names the archive an archive, because a delete would mean something else', () => {
    // A report from before the archive still resolves its chain. Calling the
    // control "delete" would tell a manager the opposite of what happens.
    expect(editor).toContain('Archive');
    expect(editor).not.toContain('>Delete<');
    expect(item).toContain('Archived by appending a revision');
  });

  it('states that every write appends, beside the revision it appended', () => {
    expect(editor).toContain('The previous revision is untouched.');
    expect(editor).toContain('revision');
  });

  it('resolves the hierarchy for a past instant through the ?at= parameter', () => {
    // The time-travel read: "what was Tuesday's report measured against".
    expect(collection).toContain("searchParams.get('at')");
    expect(collection).toContain('invalid_instant');
  });

  it('is linked from the report, since a manager who disagrees needs somewhere to go', () => {
    expect(read('components', 'report-document.tsx')).toContain('href="/goals"');
  });
});
