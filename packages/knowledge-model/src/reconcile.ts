import { toIso, type Instant } from '@compass/clock';

import type { EvidenceRef, KnowledgeStore, StoredEntity } from './store.js';

/**
 * Contradiction reconciliation.
 *
 * A Correction is the product admitting, in its own voice, that it told you
 * something that turned out to be false: "reported blocked yesterday, actually
 * merged". That sentence is only possible because the belief is persisted — a
 * per-run summariser has nothing to contradict, so it just quietly says something
 * different today and hopes you did not read yesterday's report.
 *
 * Detection lives here rather than in the analysis core because it needs the
 * store: it compares an arriving observation against what is already on disk. The
 * write it produces is additive — `entity_versions` keeps the wrong belief
 * verbatim, the entity row moves forward with a *new* version, and the Correction
 * row points at both.
 */

/** The contradiction patterns Compass can currently recognise. */
export const CONTRADICTION_KINDS = [
  /** Stored as blocked; an artifact shows the work merged. */
  'blocked_but_merged',
  /** Stored as blocked; the tracker itself moved it to a done category. */
  'blocked_but_done',
  /** Stored as done; the tracker moved it back out of a done category. */
  'done_but_reopened',
] as const;

export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

export interface ContradictionCandidate {
  readonly kind: ContradictionKind;
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly priorBelief: string;
  readonly newBelief: string;
  readonly evidence: EvidenceRef;
  readonly observedAt: Instant;
}

export interface MergedWorkSignal {
  /** The ticket key the merged artifact claims to resolve. */
  readonly ticketKey: string;
  readonly mergedAt: Instant;
  readonly evidence: EvidenceRef;
}

/**
 * Detects "stored blocked, observed merged", the pathology the seeded dataset is
 * built around.
 *
 * The test is deliberately narrow and reads off stored state only: the ticket is
 * believed blocked (either the tracker's own flag or a status in a
 * still-in-progress category whose name says blocked), and a merged pull request
 * names it. It returns a candidate rather than writing, so the caller decides
 * whether this run is allowed to record corrections.
 */
export function detectBlockedButMerged(
  ticket: StoredEntity,
  signal: MergedWorkSignal,
): ContradictionCandidate | null {
  if (ticket.kind !== 'ticket') return null;
  if (String(ticket.fields['itemKey']) !== signal.ticketKey) return null;
  if (!believedBlocked(ticket)) return null;

  const status = String(ticket.fields['status']);
  return {
    kind: 'blocked_but_merged',
    subjectKind: 'ticket',
    subjectKey: signal.ticketKey,
    priorBelief: `${signal.ticketKey} was ${describeBlocked(ticket)} — status \`${status}\`, believed since ${toIso(
      ticket.beliefAt,
    )}.`,
    newBelief: `${signal.ticketKey} merged in ${signal.evidence.label} at ${toIso(signal.mergedAt)}.`,
    evidence: signal.evidence,
    observedAt: signal.mergedAt,
  };
}

/** Whether the stored belief about a ticket is "blocked". */
export function believedBlocked(ticket: StoredEntity): boolean {
  if (ticket.fields['flaggedBlocked'] === true) return true;
  const statusCategory = String(ticket.fields['statusCategory']);
  if (statusCategory === 'done') return false;
  return /blocked/i.test(String(ticket.fields['status']));
}

function describeBlocked(ticket: StoredEntity): string {
  return ticket.fields['flaggedBlocked'] === true
    ? 'flagged blocked by the tracker'
    : 'stored as blocked from its status';
}

/**
 * Detects a ticket believed blocked that the tracker itself has moved to done,
 * without any pull request being involved. The same contradiction, a different
 * witness.
 */
export function detectBlockedButDone(
  prior: StoredEntity,
  next: { readonly status: string; readonly statusCategory: string },
  evidence: EvidenceRef,
  observedAt: Instant,
): ContradictionCandidate | null {
  if (prior.kind !== 'ticket') return null;
  if (!believedBlocked(prior)) return null;
  if (next.statusCategory !== 'done') return null;

  const itemKey = String(prior.fields['itemKey']);
  return {
    kind: 'blocked_but_done',
    subjectKind: 'ticket',
    subjectKey: itemKey,
    priorBelief: `${itemKey} was ${describeBlocked(prior)} — status \`${String(
      prior.fields['status'],
    )}\`, believed since ${toIso(prior.beliefAt)}.`,
    newBelief: `${itemKey} moved to \`${next.status}\` at ${toIso(observedAt)}.`,
    evidence,
    observedAt,
  };
}

/**
 * Detects work Compass called finished that came back. The mirror image, and the
 * one that most damages trust if it is left unsaid.
 */
export function detectDoneButReopened(
  prior: StoredEntity,
  next: { readonly status: string; readonly statusCategory: string },
  evidence: EvidenceRef,
  observedAt: Instant,
): ContradictionCandidate | null {
  if (prior.kind !== 'ticket') return null;
  if (String(prior.fields['statusCategory']) !== 'done') return null;
  if (next.statusCategory === 'done') return null;

  const itemKey = String(prior.fields['itemKey']);
  return {
    kind: 'done_but_reopened',
    subjectKind: 'ticket',
    subjectKey: itemKey,
    priorBelief: `${itemKey} was reported done — status \`${String(prior.fields['status'])}\`, believed since ${toIso(
      prior.beliefAt,
    )}.`,
    newBelief: `${itemKey} is back in \`${next.status}\` as of ${toIso(observedAt)}.`,
    evidence,
    observedAt,
  };
}

/**
 * Writes a candidate as a Correction.
 *
 * `priorVersion` is read off the belief that was wrong, which is what ties the
 * Correction to the exact `entity_versions` row a reader can go and check. Nothing
 * is mutated: the caller has already moved the entity forward with `observe()`, or
 * is about to.
 */
export async function recordContradiction(
  store: KnowledgeStore,
  candidate: ContradictionCandidate,
  priorVersion: number,
  detectedAt: Instant,
): Promise<string> {
  return store.recordCorrection({
    subjectKind: candidate.subjectKind,
    subjectKey: candidate.subjectKey,
    priorVersion,
    priorBelief: candidate.priorBelief,
    newBelief: candidate.newBelief,
    contradiction: candidate.kind,
    evidence: candidate.evidence,
    observedAt: candidate.observedAt,
    detectedAt,
  });
}

/**
 * How a Correction reads in the report. One run-in italic serif clause, in the
 * product's own voice — never a red badge, and never silence.
 */
export function describeCorrection(correction: {
  readonly contradiction: string;
  readonly subjectKey: string;
  readonly evidenceLabel: string;
}): string {
  switch (correction.contradiction) {
    case 'blocked_but_merged':
      return `${correction.subjectKey} was reported blocked — it had already merged in ${correction.evidenceLabel}.`;
    case 'blocked_but_done':
      return `${correction.subjectKey} was reported blocked — the tracker had already closed it.`;
    case 'done_but_reopened':
      return `${correction.subjectKey} was reported done — it has been reopened.`;
    default:
      return `${correction.subjectKey} was reported differently yesterday; ${correction.evidenceLabel} says otherwise.`;
  }
}
