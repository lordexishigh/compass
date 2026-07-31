'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import type { GoalNodeView } from '../lib/goal-source';

/**
 * The minimal goal editing surface.
 *
 * Deliberately minimal: the full configuration screen belongs to
 * `alpha-configuration-and-identity-roster`. What this has to do is make the four
 * endpoints reachable by a human, and make the one thing that is easy to get wrong
 * about them impossible to miss — **every write appends a revision, and nothing is
 * ever overwritten.** So the revision number is printed beside each goal, the
 * archive control says "archive" rather than "delete", and both confirmations name
 * the revision that was appended.
 *
 * It is the one client island in the app. Everything else, including the report
 * itself, renders as HTML on the server.
 */

const KINDS = ['company', 'quarter', 'sprint_goal'] as const;

interface Draft {
  readonly nodeId: string;
  readonly kind: string;
  readonly parentNodeId: string;
  readonly title: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
  readonly isCurrent: boolean;
  readonly changeNote: string;
}

const EMPTY_DRAFT: Draft = {
  nodeId: '',
  kind: 'quarter',
  parentNodeId: '',
  title: '',
  effectiveFrom: '',
  effectiveUntil: '',
  isCurrent: true,
  changeNote: '',
};

const draftFrom = (node: GoalNodeView): Draft => ({
  nodeId: node.nodeId,
  kind: node.kind,
  parentNodeId: node.parentNodeId ?? '',
  title: node.title,
  effectiveFrom: node.effectiveFrom,
  effectiveUntil: node.effectiveUntil ?? '',
  isCurrent: node.isCurrent,
  changeNote: '',
});

const INDENT: Readonly<Record<string, string>> = {
  company: 'pl-0',
  quarter: 'pl-6',
  sprint_goal: 'pl-12',
};

export function GoalEditor({ nodes, resolvedAt }: { readonly nodes: readonly GoalNodeView[]; readonly resolvedAt: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  /**
   * One request path for all four verbs.
   *
   * The endpoint's own `detail` is shown verbatim on failure. Compass does not
   * paraphrase its own error messages into something vaguer — the field name is the
   * useful part.
   */
  const submit = async (
    input: RequestInfo,
    init: RequestInit,
    onSuccess: (body: Record<string, unknown>) => string,
  ): Promise<void> => {
    setError(null);
    setConfirmation(null);

    const response = await fetch(input, { ...init, headers: { 'content-type': 'application/json' } });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      setError(typeof body['detail'] === 'string' ? body['detail'] : `The request failed with ${response.status}.`);
      return;
    }

    setConfirmation(onSuccess(body));
    setEditing(null);
    setCreating(false);
    setDraft(EMPTY_DRAFT);
    startTransition(() => router.refresh());
  };

  const payloadFrom = (values: Draft): Record<string, unknown> => ({
    nodeId: values.nodeId,
    kind: values.kind,
    parentNodeId: values.parentNodeId.length === 0 ? null : values.parentNodeId,
    title: values.title,
    effectiveFrom: values.effectiveFrom,
    effectiveUntil: values.effectiveUntil.length === 0 ? null : values.effectiveUntil,
    isCurrent: values.isCurrent,
    changeNote: values.changeNote.length === 0 ? null : values.changeNote,
  });

  const revisionLine = (body: Record<string, unknown>, verb: string): string => {
    const revision = typeof body['revision'] === 'number' ? body['revision'] : 0;
    return body['appended'] === false
      ? `Nothing changed, so no revision was appended — ${String(body['nodeId'])} is still at revision ${revision}.`
      : `${verb} ${String(body['nodeId'])} as revision ${revision}. The previous revision is untouched.`;
  };

  return (
    <div>
      {error !== null && (
        <p role="alert" className="mt-6 border-l-2 border-rule-severe pl-3 text-[13px] leading-relaxed text-ink">
          {error}
        </p>
      )}
      {confirmation !== null && (
        <p role="status" className="mt-6 border-l-2 border-verified pl-3 text-[13px] leading-relaxed text-ink">
          {confirmation}
        </p>
      )}

      {nodes.length === 0 ? (
        <p className="stated-absence mt-8 text-[17px] leading-relaxed">
          No goal has been recorded yet, so alignment has nothing to resolve against and every commit will be asked
          about rather than judged. Add the company objective first, then the quarter it breaks into.
        </p>
      ) : (
        <ul className="mt-8 space-y-6">
          {nodes.map((node) => (
            <li key={node.nodeId} className={INDENT[node.kind] ?? 'pl-6'}>
              <div className="border-l border-rule-strong pl-4">
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="data-token">{node.nodeId}</span>
                  <span className="section-label">{node.kind.replace('_', ' ')}</span>
                  <span className="font-mono text-[11px] tabular-nums text-ink-faint">r{node.revision}</span>
                  {node.isCurrent && (
                    <span className="inline-flex items-baseline gap-1 font-mono text-[11px] text-verified-text">
                      <span aria-hidden="true">▍</span>current
                    </span>
                  )}
                  {node.origin === 'declared' && (
                    <span className="font-mono text-[11px] text-authored-text">edited here</span>
                  )}
                </p>
                <p className="prose-narration mt-1">{node.title}</p>
                <p className="mt-1 font-mono text-[12px] tabular-nums text-ink-faint">
                  {node.effectiveFrom.slice(0, 10)} → {node.effectiveUntil?.slice(0, 10) ?? 'open-ended'}
                  {node.chainNodeIds.length > 1 && <> · serves {node.chainNodeIds.slice(1).join(' → ')}</>}
                </p>

                <p className="mt-2 flex gap-4 text-[13px]">
                  <button
                    type="button"
                    className="tertiary-action"
                    aria-expanded={editing === node.nodeId}
                    onClick={() => {
                      setEditing(editing === node.nodeId ? null : node.nodeId);
                      setCreating(false);
                      setDraft(draftFrom(node));
                    }}
                  >
                    {editing === node.nodeId ? 'Cancel' : 'Edit'}
                  </button>
                  <button
                    type="button"
                    className="tertiary-action"
                    disabled={pending}
                    onClick={() => {
                      void submit(`/api/goals/${encodeURIComponent(node.nodeId)}?note=Archived+from+the+goals+screen.`, { method: 'DELETE' }, (body) =>
                        revisionLine(body, 'Archived'),
                      );
                    }}
                  >
                    Archive
                  </button>
                </p>

                {editing === node.nodeId && (
                  <GoalForm
                    draft={draft}
                    onChange={setDraft}
                    pending={pending}
                    submitLabel="Append revision"
                    lockNodeId
                    onSubmit={() => {
                      void submit(
                        `/api/goals/${encodeURIComponent(node.nodeId)}`,
                        { method: 'PATCH', body: JSON.stringify(payloadFrom(draft)) },
                        (body) => revisionLine(body, 'Edited'),
                      );
                    }}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-12 hairline pt-6">
        <p className="section-label">Add a goal</p>
        {creating ? (
          <GoalForm
            draft={draft}
            onChange={setDraft}
            pending={pending}
            submitLabel="Create"
            onCancel={() => {
              setCreating(false);
              setDraft(EMPTY_DRAFT);
            }}
            onSubmit={() => {
              void submit('/api/goals', { method: 'POST', body: JSON.stringify(payloadFrom(draft)) }, (body) =>
                revisionLine(body, 'Created'),
              );
            }}
          />
        ) : (
          <p className="mt-3 text-[13px]">
            <button
              type="button"
              className="tertiary-action"
              onClick={() => {
                setCreating(true);
                setEditing(null);
                setDraft(EMPTY_DRAFT);
              }}
            >
              New objective or sprint goal
            </button>
          </p>
        )}
      </div>

      <p className="mt-10 text-[13px] leading-relaxed text-ink-faint">
        This hierarchy is resolved as of{' '}
        <span className="data-token">{resolvedAt}</span>. Every write appends an effective-dated revision and leaves
        the prior one on disk, so a report you read last week still resolves against the wording it was measured
        against.
      </p>
    </div>
  );
}

/**
 * The form, bottom-hairline inputs only.
 *
 * No boxes, no rings: focus raises the hairline to 2px emerald, which is the design
 * brief's own rule for inputs. Labels sit above in 11px caps.
 */
function GoalForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  pending,
  submitLabel,
  lockNodeId = false,
}: {
  readonly draft: Draft;
  readonly onChange: (draft: Draft) => void;
  readonly onSubmit: () => void;
  readonly onCancel?: () => void;
  readonly pending: boolean;
  readonly submitLabel: string;
  readonly lockNodeId?: boolean;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => onChange({ ...draft, [key]: value });

  return (
    <form
      className="mt-4 grid gap-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Field label="Node id" hint="What a report cites: OBJ-Q4-PLAT, PLAT/Sprint 47.">
        <input
          className="goal-input"
          value={draft.nodeId}
          readOnly={lockNodeId}
          required
          onChange={(event) => set('nodeId', event.target.value)}
        />
      </Field>

      <Field label="Kind">
        <select className="goal-input" value={draft.kind} onChange={(event) => set('kind', event.target.value)}>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind.replace('_', ' ')}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Title" hint="The wording alignment is scored against." full>
        <input className="goal-input" value={draft.title} required onChange={(event) => set('title', event.target.value)} />
      </Field>

      <Field label="Parent node id" hint="Blank for a company objective.">
        <input
          className="goal-input"
          value={draft.parentNodeId}
          onChange={(event) => set('parentNodeId', event.target.value)}
        />
      </Field>

      <Field label="Current" hint="Only a current objective can hold today's work.">
        <label className="flex items-center gap-2 pt-2 text-[13px] text-ink">
          <input
            type="checkbox"
            className="accent-verified"
            checked={draft.isCurrent}
            onChange={(event) => set('isCurrent', event.target.checked)}
          />
          today&apos;s work is measured against this
        </label>
      </Field>

      <Field label="Effective from" hint="ISO instant, e.g. 2026-10-01T00:00:00Z.">
        <input
          className="goal-input"
          value={draft.effectiveFrom}
          required
          placeholder="2026-10-01T00:00:00Z"
          onChange={(event) => set('effectiveFrom', event.target.value)}
        />
      </Field>

      <Field label="Effective until" hint="Blank for open-ended.">
        <input
          className="goal-input"
          value={draft.effectiveUntil}
          placeholder="2026-12-31T00:00:00Z"
          onChange={(event) => set('effectiveUntil', event.target.value)}
        />
      </Field>

      <Field label="Why" hint="Recorded on the revision, for whoever reads it in March." full>
        <input
          className="goal-input"
          value={draft.changeNote}
          onChange={(event) => set('changeNote', event.target.value)}
        />
      </Field>

      <p className="flex items-center gap-4 sm:col-span-2">
        <button type="submit" className="primary-action" disabled={pending}>
          {pending ? 'Appending…' : submitLabel}
        </button>
        {onCancel !== undefined && (
          <button type="button" className="tertiary-action" onClick={onCancel}>
            Cancel
          </button>
        )}
      </p>
    </form>
  );
}

function Field({
  label,
  hint,
  full = false,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly full?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <label className={full ? 'block sm:col-span-2' : 'block'}>
      <span className="section-label">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[12px] leading-snug text-ink-faint">{hint}</span>}
    </label>
  );
}
