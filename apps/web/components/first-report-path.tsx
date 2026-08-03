'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';

/**
 * The two forms on the guided path that actually write something.
 *
 * ## Why these two and not four
 *
 * Step 01 is a choice with no field in it — either the seeded dataset is what you want, or you
 * name your own sources, and the second of those happens on `/roster` against sources ingest
 * has discovered. Step 04 is the identity queue, which is also on `/roster` because it is a
 * list of things to claim rather than a form to fill. So the path writes here for the two
 * steps that are genuinely blank-page problems: a team has to be declared before anything can
 * be about it, and the goal chain has to be entered because no connector reports it.
 *
 * ## Both write through the ordinary endpoints
 *
 * `POST /api/roster/teams` and `POST /api/goals`, the same routes the full configuration
 * screens post to, guarded by the same matrix rows. There is no privileged setup path: a
 * "wizard" with its own write path is how a product ends up with two ways to create a team
 * that validate differently, and the one used less often is the one that is wrong.
 */

/** The shared post-and-say-what-happened helper. */
function useWriter() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [stated, setStated] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function write(
    steps: readonly { readonly path: string; readonly body: unknown }[],
    success: string,
  ): Promise<boolean> {
    setBusy(true);
    setStated(null);
    setFailed(null);

    try {
      for (const step of steps) {
        const response = await fetch(step.path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(step.body),
        });
        const parsed = (await response.json()) as { readonly detail?: string };

        if (!response.ok) {
          // The first failure stops the sequence and says which one, because a chain that
          // half-applied and reported success would leave a goal hierarchy with a root and
          // no leaf — which resolves to nothing and looks like the write never happened.
          setFailed(parsed.detail ?? 'That did not work, and Compass could not say why.');
          return false;
        }
      }

      setStated(success);
      // Re-reads the server so the step marks itself done from the real configuration
      // rather than from an optimistic flag in this component.
      router.refresh();
      return true;
    } catch {
      setFailed('Compass could not be reached, so nothing was written.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, stated, failed, write };
}

function Outcome({ stated, failed }: { readonly stated: string | null; readonly failed: string | null }) {
  if (failed !== null) {
    return (
      <p role="alert" className="mt-4 border-l-2 border-rule-severe pl-3 text-[13px] leading-relaxed text-ink">
        {failed}
      </p>
    );
  }
  if (stated !== null) {
    return (
      <p role="status" className="mt-4 border-l-2 border-verified pl-3 text-[13px] leading-relaxed text-ink">
        {stated}
      </p>
    );
  }
  return null;
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="mt-5 block first:mt-0">
      <span className="section-label">{label}</span>
      {children}
      {hint !== undefined && <span className="stated-absence mt-1 block text-[13px]">{hint}</span>}
    </label>
  );
}

/** `Platform Team` → `platform-team`. The key a manager would have chosen anyway. */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

// ---------------------------------------------------------------------------
// Step 02 — the team
// ---------------------------------------------------------------------------

export function TeamQuickSetup({ defaultTimezone }: { readonly defaultTimezone: string }) {
  const { busy, stated, failed, write } = useWriter();
  const [name, setName] = useState('');
  const [methodology, setMethodology] = useState<'scrum' | 'kanban'>('scrum');
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [projectKey, setProjectKey] = useState('');

  const key = slug(name);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (key.length === 0) return;

    void write(
      [
        {
          path: '/api/roster/teams',
          body: {
            key,
            name: name.trim(),
            methodology,
            timezone: timezone.trim(),
            projectKey: projectKey.trim().length === 0 ? null : projectKey.trim(),
          },
        },
      ],
      `Team \`${key}\` saved. Every threshold in the product is measured in that team's working days.`,
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 max-w-[26rem]">
      <Field label="team name" hint={key.length === 0 ? 'The key is derived from this.' : `key: ${key}`}>
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="goal-input"
          placeholder="Platform"
        />
      </Field>

      <Field label="how it plans" hint={methodology === 'scrum' ? 'Sprint completion and velocity.' : 'Flow, with no sprint boundary — progress is reported as throughput.'}>
        <select
          value={methodology}
          onChange={(event) => setMethodology(event.target.value === 'kanban' ? 'kanban' : 'scrum')}
          className="goal-input"
        >
          <option value="scrum">scrum</option>
          <option value="kanban">kanban</option>
        </select>
      </Field>

      <Field label="timezone" hint="Decides which day “yesterday” is, and when the daily is generated.">
        <input
          required
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          className="goal-input"
          placeholder="Europe/London"
        />
      </Field>

      <Field label="tracker project key" hint="Optional. Without it the team's scope is inferred rather than declared.">
        <input
          value={projectKey}
          onChange={(event) => setProjectKey(event.target.value)}
          className="goal-input"
          placeholder="DEV"
        />
      </Field>

      <button type="submit" disabled={busy || key.length === 0} className="primary-action mt-6">
        {busy ? 'Saving…' : 'Save the team'}
      </button>

      <Outcome stated={stated} failed={failed} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 03 — the goal chain, in one screen
// ---------------------------------------------------------------------------

/**
 * The quarter a date falls in, as a label a person recognises.
 *
 * The middle of the chain is filled in rather than asked for, which is the substantive
 * default here: the hierarchy is company → quarter → sprint goal, and a company objective
 * wired straight to a sprint goal is a chain with a hole in it — alignment resolves through
 * parents, so the sprint goal would not reach the company objective and every verdict would
 * come back unattributed. Asking a manager to name a quarter they have not thought about, in
 * order to satisfy a shape they cannot see, is the wrong trade: Compass knows what quarter it
 * is.
 */
function currentQuarter(today: string): { readonly key: string; readonly title: string } {
  const [year, month] = today.split('-');
  const quarter = Math.floor((Number.parseInt(month ?? '1', 10) - 1) / 3) + 1;
  return { key: `${year}-q${quarter}`, title: `${year} Q${quarter}` };
}

export function GoalQuickEntry({
  today,
  effectiveFrom,
}: {
  /** `YYYY-MM-DD` in the deployment's zone, resolved on the server. */
  readonly today: string;
  /** The instant the goals take effect from, resolved on the server from the request clock. */
  readonly effectiveFrom: string;
}) {
  const { busy, stated, failed, write } = useWriter();
  const [company, setCompany] = useState('');
  const [sprint, setSprint] = useState('');

  const quarter = currentQuarter(today);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const companyTitle = company.trim();
    const sprintTitle = sprint.trim();
    if (companyTitle.length === 0 || sprintTitle.length === 0) return;

    const companyKey = slug(companyTitle);
    const sprintKey = slug(sprintTitle);

    void write(
      [
        // Root first, then the quarter, then the leaf: each one names its parent, so the
        // order is the dependency order and a failure part-way leaves a shorter valid chain
        // rather than an orphan.
        {
          path: '/api/goals',
          body: { nodeId: companyKey, kind: 'company', title: companyTitle, effectiveFrom, isCurrent: true },
        },
        {
          path: '/api/goals',
          body: {
            nodeId: quarter.key,
            kind: 'quarter',
            parentNodeId: companyKey,
            title: quarter.title,
            effectiveFrom,
            isCurrent: true,
          },
        },
        {
          path: '/api/goals',
          body: {
            nodeId: sprintKey,
            kind: 'sprint_goal',
            parentNodeId: quarter.key,
            title: sprintTitle,
            effectiveFrom,
            isCurrent: true,
          },
        },
      ],
      `Chain recorded: ${companyKey} → ${quarter.key} → ${sprintKey}. Alignment now resolves against it, and every ` +
        'verdict will cite which link matched.',
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 max-w-[30rem]">
      <Field
        label="company objective"
        hint="The one the quarter serves. This is the root of the chain, so it has no parent."
      >
        <input
          required
          value={company}
          onChange={(event) => setCompany(event.target.value)}
          className="goal-input"
          placeholder="Reduce checkout abandonment"
        />
      </Field>

      <Field
        label="current sprint goal"
        hint="What this sprint is for, in the team's own words. Semantic matching compares commit and ticket text against it."
      >
        <input
          required
          value={sprint}
          onChange={(event) => setSprint(event.target.value)}
          className="goal-input"
          placeholder="Ship one-page checkout behind a flag"
        />
      </Field>

      <p className="stated-absence mt-5 text-[13px] leading-relaxed">
        Compass fills in the quarter between them — <span className="font-mono not-italic">{quarter.key}</span>, because
        that is the quarter today falls in. The chain has three levels whether or not you name the middle one, and a
        sprint goal that does not reach the company objective produces unattributed verdicts rather than aligned ones.
        Both are editable afterwards on the goals screen; every edit appends a revision and overwrites nothing.
      </p>

      <button
        type="submit"
        disabled={busy || company.trim().length === 0 || sprint.trim().length === 0}
        className="primary-action mt-6"
      >
        {busy ? 'Recording…' : 'Record the chain'}
      </button>

      <Outcome stated={stated} failed={failed} />
    </form>
  );
}
