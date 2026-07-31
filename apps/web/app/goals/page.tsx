import Link from 'next/link';

import { GoalEditor } from '../../components/goal-editor';
import { listGoals } from '../../lib/goal-source';

/**
 * `/goals` — the chain every alignment verdict is resolved against.
 *
 * A thin page over the four endpoints in `app/api/goals`, deliberately: the full
 * configuration screen belongs to `alpha-configuration-and-identity-roster`, and
 * what this task owes is a surface from which the CRUD is reachable by a human.
 *
 * It is set in the report's own typography rather than in a settings-panel idiom,
 * because it is read for the same reason the report is: to find out what Compass
 * believes. A goal store nobody can see is what turns the alignment section into a
 * black box.
 *
 * The page is a Server Component that fetches nothing over HTTP — it reads the
 * store directly and hands a value to one client island, exactly as `/` does.
 */
export const dynamic = 'force-dynamic';

export default async function GoalsPage() {
  let goals: Awaited<ReturnType<typeof listGoals>> | null = null;
  let failure: string | null = null;

  try {
    goals = await listGoals();
  } catch (error) {
    // Stated, in the product's voice, in the reading column. Never a stack trace
    // and never an illustrated error page.
    failure = error instanceof Error ? error.message : 'The goal store could not be reached.';
  }

  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">goal hierarchy</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          What the work is measured against
        </h1>
        <p className="prose-narration mt-3">
          Company objective, then the quarter it breaks into, then the sprint goals underneath. Alignment resolves
          against this chain first, and falls back to a tracker key or to shared wording only when the chain does not
          reach the work.
        </p>
        <p className="mt-4 text-[13px]">
          <Link
            href="/"
            className="tertiary-action"
          >
            ← today&apos;s report
          </Link>
        </p>
      </header>

      {failure !== null ? (
        <p role="alert" className="mt-8 border-l-2 border-rule-severe pl-3 text-[13px] leading-relaxed text-ink">
          {failure} Nothing has been changed. The goals surface reads the same database the report does, so this is the
          same condition the report would report.
        </p>
      ) : (
        <GoalEditor nodes={goals?.nodes ?? []} resolvedAt={goals?.at ?? ''} />
      )}
    </div>
  );
}
