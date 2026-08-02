import {
  FEEDBACK_ACTIONS,
  MATERIAL_WORSENING_DELTA,
  TERMINAL_FEEDBACK_ACTIONS,
  type FeedbackAction,
} from '@compass/analysis';
import { readCorrections, readFeedbackLedger } from '@compass/db';
import { headers } from 'next/headers';

import { StatedFailure } from '../../components/stated-failure';
import { pageAccess } from '../../lib/auth/guard';

/**
 * `/corrections` — what this manager has told Compass to stop saying, and what it did about it.
 *
 * ## Why this screen has to exist
 *
 * A suppression a manager cannot find is indistinguishable from a detector that broke. Once
 * feedback genuinely changes what tomorrow's report says, the *absence* of a finding becomes a fact
 * with a cause — and the only honest arrangement is that the cause is readable. Without this page,
 * "Compass stopped mentioning the review queue" has two explanations and no way to tell them apart.
 *
 * ## Three lists, because they answer three different questions
 *
 * - **Corrected off-goal flags.** The Correction rows: what Compass claimed, what the manager said
 *   instead, and when. This is the audit record, and it survives a suppression being lifted.
 * - **Live suppressions.** Everything currently keeping a finding off the report, with the reason in
 *   the manager's own words and whether it can expire.
 * - **Snoozes.** Separated out because they are the ones that come back on their own, and a manager
 *   scanning for "what have I silenced permanently" should not have to read past them.
 *
 * Owner and manager, from the same `ROLE_MATRIX` the endpoints ask — a screen that rendered what its
 * API refuses is the leak the matrix exists to prevent.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Corrections — Compass',
};

/** The action names, in the manager's language rather than the schema's. */
const ACTION_LABEL: Readonly<Record<FeedbackAction, string>> = {
  dismiss_risk: 'dismissed risk',
  off_goal_flag_wrong: 'off-goal flag marked wrong',
  accept_recommendation: 'accepted step',
  reject_recommendation: 'rejected step',
  blocker_already_resolved: 'blocker already resolved',
  snooze: 'snoozed',
};

/** How each verdict ends, stated so a manager knows which of their words are permanent. */
const ACTION_DURATION: Readonly<Record<FeedbackAction, string>> = {
  dismiss_risk: `until its severity rises by ${MATERIAL_WORSENING_DELTA} points`,
  off_goal_flag_wrong: 'permanently',
  accept_recommendation: 'until the condition lapses and returns',
  reject_recommendation: 'permanently',
  blocker_already_resolved: 'until a new triggering signal appears',
  snooze: 'until the snooze ends',
};

const day = (instant: number): string => new Date(instant).toISOString().slice(0, 10);

function CorrectionsFrame({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">corrections</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
      </header>
      {children}
    </div>
  );
}

export default async function CorrectionsPage() {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/corrections', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <CorrectionsFrame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} Nothing you have corrected has been lost.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </CorrectionsFrame>
    );
  }

  if (!access.allowed) {
    return (
      <CorrectionsFrame heading="Not yours to read">
        <StatedFailure detail={access.reason ?? 'Your role does not permit this.'}>
          <a href="/account" className="tertiary-action">
            sign in
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </CorrectionsFrame>
    );
  }

  const ledger = await readFeedbackLedger(access.scoped);
  const corrections = await readCorrections(access.scoped, 'off_goal_flag_wrong');

  const known = new Set<string>(FEEDBACK_ACTIONS);
  const snoozes = ledger.filter((entry) => entry.action === 'snooze');
  // Everything that is not a snooze and not an acceptance: an accepted step is not a suppression —
  // it still appears on the report, marked as the manager's own decision.
  const suppressions = ledger.filter(
    (entry) => known.has(entry.action) && entry.action !== 'snooze' && entry.action !== 'accept_recommendation',
  );
  const acceptances = ledger.filter((entry) => entry.action === 'accept_recommendation');

  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">corrections</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          What you have told Compass
        </h1>
        <p className="prose-narration mt-3">
          Every verdict here changes what tomorrow&apos;s report says. That is the point of them — and it is why they are
          listed: a finding that has quietly stopped appearing is indistinguishable from a detector that broke, unless
          you can read the reason it stopped.
        </p>
        <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
          <a href="/api/audit" className="tertiary-action">
            audit log
          </a>
        </p>
      </header>

      <section aria-labelledby="corrected-flags" className="hairline mt-10 pt-8">
        <h2 id="corrected-flags" className="section-label">
          01 corrected off-goal flags
        </h2>
        {corrections.length === 0 ? (
          <p className="stated-absence mt-3 text-[17px] leading-relaxed">
            You have not marked an off-goal flag wrong. When you do, Compass records what it claimed and what you said
            beside it, and stops making that claim.
          </p>
        ) : (
          <ul className="mt-5 space-y-6">
            {corrections.map((correction) => (
              <li key={correction.id} className="border-l border-rule-strong pl-4">
                <p className="prose-narration">
                  <span className="font-mono text-[13px] tabular-nums text-ink-faint">{correction.subjectKey}</span> —
                  Compass claimed: <q>{correction.priorBelief}</q>
                </p>
                <p className="prose-narration mt-2 text-ink-muted">
                  You said: <q>{correction.newBelief}</q>
                </p>
                <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-faint">
                  recorded {day(correction.detectedAt)} · evidence {correction.evidenceLabel}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="live-suppressions" className="hairline mt-10 pt-8">
        <h2 id="live-suppressions" className="section-label">
          02 findings held back
        </h2>
        {suppressions.length === 0 ? (
          <p className="stated-absence mt-3 text-[17px] leading-relaxed">
            Nothing is being held back. Every finding Compass has is in your report.
          </p>
        ) : (
          <ul className="mt-5 space-y-5">
            {suppressions.map((entry) => (
              <li key={entry.id} className="border-l border-rule-strong pl-4">
                <p className="prose-narration">
                  <span className="font-mono text-[13px] text-ink-faint">{entry.causeEntityRef}</span> —{' '}
                  {ACTION_LABEL[entry.action as FeedbackAction] ?? entry.action}
                  {entry.reason === null ? '' : `: ${entry.reason}`}
                </p>
                <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-faint">
                  {day(entry.submittedAt)} · from {entry.sourceChannel} · held{' '}
                  {ACTION_DURATION[entry.action as FeedbackAction] ?? 'until the condition changes'}
                  {entry.severityScoreAtVerdict === null
                    ? ''
                    : ` · ${entry.severityScoreAtVerdict} severity points at the time`}
                  {TERMINAL_FEEDBACK_ACTIONS.includes(entry.action as FeedbackAction) ? ' · permanent' : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="snoozes" className="hairline mt-10 pt-8">
        <h2 id="snoozes" className="section-label">
          03 snoozed, and returning
        </h2>
        {snoozes.length === 0 ? (
          <p className="stated-absence mt-3 text-[17px] leading-relaxed">
            Nothing is snoozed. A snooze is the one verdict that expires on its own.
          </p>
        ) : (
          <ul className="mt-5 space-y-4">
            {snoozes.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-[13px] text-ink-faint">{entry.causeEntityRef}</span>
                <span className="prose-narration text-[15px]">
                  {entry.snoozeUntil === null ? (
                    'no end recorded'
                  ) : (
                    <>
                      returns <span className="font-mono tabular-nums">{day(entry.snoozeUntil)}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {acceptances.length > 0 && (
        <section aria-labelledby="acceptances" className="hairline mt-10 pt-8">
          <h2 id="acceptances" className="section-label">
            04 steps you accepted
          </h2>
          <p className="prose-narration mt-3 text-ink-muted">
            These are not held back. They keep appearing while the condition holds, marked as your decision rather than
            re-suggested — and if the condition lapses and returns, Compass asks again.
          </p>
          <ul className="mt-5 space-y-4">
            {acceptances.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-[13px] text-ink-faint">{entry.causeEntityRef}</span>
                <span className="prose-narration text-[15px]">
                  accepted <span className="font-mono tabular-nums">{day(entry.submittedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
