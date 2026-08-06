import { formatCivilDate, formatCivilDateTime } from '@compass/clock';
import { headers } from 'next/headers';

import {
  AnonymizeControl,
  ChannelToggle,
  DeletionControls,
  MinimizationControls,
  RetentionControls,
} from '../../components/privacy-controls';
import { StatedFailure } from '../../components/stated-failure';
import { pageAccess } from '../../lib/auth/guard';
import { loadPrivacyAdminView, type PrivacyAdminView } from '../../lib/privacy-source';

/**
 * `/privacy` — what Compass keeps, what it reads, whose name it prints, and how to end it.
 *
 * ## Why one screen and not four settings tabs
 *
 * Because a manager comes here with one question — "can I show this report to my team?" — and
 * the answer is the whole page. Retention, chat opt-in, anonymization and deletion are four
 * mechanisms and one promise, and splitting them across tabs would mean somebody could
 * satisfy themselves about three and never find the fourth.
 *
 * ## Owner controls on a manager's screen
 *
 * A manager may read all of it and may change two things: whether a channel is read, and
 * whether a departed colleague's name is printed. The owner-only controls render as *stated
 * facts* rather than as disabled inputs with no explanation — the retention selects are
 * disabled and a sentence beneath says who can change them. A control a reader cannot use and
 * cannot account for reads as a bug.
 *
 * ## The last purge is shown even when it deleted nothing
 *
 * A page reading "never purged" because no data has aged out yet is indistinguishable from one
 * whose scheduler died in March. So the outcome of the last run is printed whatever it was,
 * and "no chat message was older than 90 days" is the sentence that says the job is alive.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Privacy — Compass',
};

function Frame({
  heading,
  lede,
  children,
}: {
  readonly heading: string;
  readonly lede?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[52rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">privacy</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
        {lede}
      </header>
      {children}
    </div>
  );
}

function Section({
  numeral,
  title,
  children,
}: {
  readonly numeral: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="mt-12">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[11px] tabular-nums text-ink-faint">{numeral}</span>
        <h2 className="text-[15px] font-semibold tracking-tight text-ink-strong">{title}</h2>
      </div>
      <div className="hairline mt-2" />
      {children}
    </section>
  );
}

function PurgeRecord({ view }: { readonly view: PrivacyAdminView }) {
  const { lastPurge, nextPurgeAt } = view.retention;

  return (
    <div className="mt-6">
      <p className="prose-narration">
        The next purge runs at <span className="data-token">{formatCivilDateTime(nextPurgeAt, 'UTC')}</span>. Compass is
        currently holding <span className="data-token">{view.retention.rawEventsHeld}</span> chat{' '}
        {view.retention.rawEventsHeld === 1 ? 'message' : 'messages'}; anything posted before{' '}
        <span className="data-token">{formatCivilDate(view.retention.rawCutoff, 'UTC')}</span> will be deleted by it.
        {view.retention.derivedCutoff === null
          ? ' Reports are kept indefinitely, so the purge will not touch one.'
          : ` Reports dated before ${formatCivilDate(view.retention.derivedCutoff, 'UTC')} will be deleted with them.`}
      </p>

      {lastPurge === null ? (
        <p className="stated-absence mt-4">
          No purge has run yet. On a container that has just started this is expected — the job runs daily — and this
          line will name the outcome of the first one, whether or not it deleted anything.
        </p>
      ) : (
        <p className="prose-narration mt-4">
          <span className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">last purge</span>{' '}
          {formatCivilDateTime(lastPurge.startedAt, 'UTC')} —{' '}
          {lastPurge.outcome === 'complete' ? (
            lastPurge.detail
          ) : (
            <span className="text-ink-strong">{lastPurge.detail}</span>
          )}
        </p>
      )}
    </div>
  );
}

export default async function PrivacyPage() {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/privacy', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <Frame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} No setting has been changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  if (!access.allowed) {
    return (
      <Frame heading="Not yours to change">
        <StatedFailure detail={access.reason ?? 'Your role does not permit this.'}>
          <a href="/me" className="tertiary-action">
            what Compass says about you
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  let view: PrivacyAdminView | null = null;
  let unreadable: string | null = null;
  try {
    view = await loadPrivacyAdminView(access.scoped, access.now);
  } catch (error) {
    unreadable = error instanceof Error ? error.message : 'The privacy settings could not be read.';
  }

  if (view === null) {
    return (
      <Frame heading="The privacy settings could not be read">
        <StatedFailure detail={`${unreadable} Nothing has been changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  const isOwner = access.principal === 'owner';
  const ingested = view.channels.filter((channel) => channel.enabled);

  return (
    <Frame
      heading={`What Compass keeps about ${view.organizationName}`}
      lede={
        <>
          <p className="prose-narration mt-3">
            This page exists so that a manager can show the daily report to the team it is about. Everything Compass
            holds has a stated window and a scheduled deletion; everything it reads was named by somebody; and anybody
            with a seat can see their own entry without asking permission.
          </p>
          <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
            <a href="/" className="tertiary-action">
              ← today&apos;s report
            </a>
            <a href="/me" className="tertiary-action">
              what Compass says about you
            </a>
            <a href="/roster" className="tertiary-action">
              roster
            </a>
          </p>

          {/*
            The published documents, linked from the page a manager arrives at with the question.

            Criterion 002 is that the DPIA and the Article 22 statement are "published in-product and
            linked from the privacy page" — so these are links rather than a paragraph mentioning that
            such documents exist. The no-ranking stance is here too because it is the promise a team asks
            about first when their manager shows them this screen, and the whole purpose of this page is
            being able to have that conversation.
          */}
          <p
            data-testid="privacy-legal-links"
            className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px]"
          >
            <a href="/legal/dpia" className="tertiary-action">
              impact assessment (DPIA)
            </a>
            <a href="/legal/automated-decisions" className="tertiary-action">
              automated decisions and Article 22
            </a>
            <a href="/legal/no-ranking" className="tertiary-action">
              Compass does not rank individuals
            </a>
            <a href="/trust/subprocessors" className="tertiary-action">
              subprocessors and data processing
            </a>
            <a href="/legal/privacy" className="tertiary-action">
              privacy policy
            </a>
          </p>
        </>
      }
    >
      {view.liveDeletion === null ? null : (
        <p role="alert" className="feedback-outcome mt-8" data-state="refused">
          This organization is scheduled for deletion. {view.liveDeletion.detail} The undo link was mailed to{' '}
          {view.liveDeletion.notifyEmail}.
        </p>
      )}

      <Section numeral="01" title="How long Compass keeps data">
        <p className="prose-narration mt-4">
          Two windows, because the two kinds of data are not comparable. Chat messages are somebody&apos;s words and are
          kept for as short a time as is useful. Reports are the product itself, and deleting them early destroys the
          continuity every &ldquo;day 6&rdquo; in the product is counted from.
        </p>
        <RetentionControls
          rawEventRetentionDays={view.retention.rawEventRetentionDays}
          derivedRetentionYears={view.retention.derivedRetentionYears}
          canEdit={isOwner}
        />
        <PurgeRecord view={view} />
      </Section>

      <Section numeral="02" title="How much a language model is shown">
        <p className="prose-narration mt-4">
          Compass computes the whole report on this machine and only asks a model to word the result. Raw text never
          travels in any mode — no commit message, no ticket comment, no chat message — and the build fails if a field
          carrying raw text is added to what the model is shown. What this setting decides is whether{' '}
          <em>names</em> travel.
        </p>
        <MinimizationControls mode={view.retention.llmMinimizationMode} canEdit={isOwner} />
      </Section>

      <Section numeral="03" title="Which chat channels Compass reads">
        <p className="prose-narration mt-4">
          Opt-in, one named channel at a time. Direct messages and private channels are never read — the database
          refuses to mark one as read, and the ingest path drops the message a second time regardless. When a channel is
          turned on, Compass posts a notice in it saying so, and this list says whether that notice has landed.
        </p>

        {view.channels.length === 0 ? (
          <p className="stated-absence mt-5">
            No chat channel is known to this organization, so Compass reads none. A channel appears here once the Slack
            connector reports it or somebody names it.
          </p>
        ) : (
          <>
            <p className="prose-narration mt-4">
              <span className="data-token">{ingested.length}</span> of{' '}
              <span className="data-token">{view.channels.length}</span> known{' '}
              {view.channels.length === 1 ? 'conversation is' : 'conversations are'} read.
            </p>
            <ul className="mt-5 space-y-7">
              {view.channels.map((channel) => (
                <li key={channel.conversationKey}>
                  <p className="text-[14px] text-ink-strong">
                    <span className="font-mono">#{channel.conversationName}</span>{' '}
                    <span className="text-[12px] text-ink-faint">{channel.conversationKind.replace(/_/g, ' ')}</span>
                  </p>
                  <p className="mt-1 font-serif text-[12.5px] italic text-ink-muted">
                    {channel.enabled
                      ? `Read since ${channel.enabledAt === null ? 'an unrecorded date' : formatCivilDate(channel.enabledAt, 'UTC')}. ` +
                        (channel.noticePostedAt === null
                          ? 'The team has not been told yet — Compass has not managed to post the notice in the channel. ' +
                            (channel.noticeDetail ?? 'It will keep trying.')
                          : `The channel was told on ${formatCivilDate(channel.noticePostedAt, 'UTC')}.`)
                      : 'Not read.'}
                  </p>
                  <div className="mt-2">
                    <ChannelToggle
                      conversationKey={channel.conversationKey}
                      conversationName={channel.conversationName}
                      conversationKind={channel.conversationKind}
                      enabled={channel.enabled}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section numeral="04" title="Whose name Compass prints">
        <p className="prose-narration mt-4">
          Withdrawing a name replaces it with a stable pseudonym in every report from now on. Reports already written
          render &ldquo;a former team member&rdquo; where the name was and keep every ticket key, pull request number and
          count — the work happened, and a report that lost it would be a false record of the team&apos;s week. The act
          is audited and the version history behind it cannot be edited, so restoring a name is a second recorded act
          rather than the absence of the first.
        </p>

        {view.people.length === 0 ? (
          <p className="stated-absence mt-5">
            Nobody is on the roster yet, so there is no name to withdraw. The roster screen is where people are added.
          </p>
        ) : (
          <ul className="mt-5 space-y-5">
            {view.people.map((person) => (
              <li key={person.key}>
                <p className="text-[14px] text-ink-strong">
                  {person.displayName}{' '}
                  {person.anonymized ? (
                    <span className="font-serif text-[12.5px] italic text-ink-muted">
                      — name withdrawn; reports call this person{' '}
                      {view.anonymizations.find((entry) => entry.developerKey === person.key)?.pseudonym ??
                        'a pseudonym'}
                    </span>
                  ) : null}
                </p>
                <div className="mt-1">
                  <AnonymizeControl
                    developerKey={person.key}
                    displayName={person.displayName}
                    anonymized={person.anonymized}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section numeral="05" title="Taking your data, or ending this">
        <p className="prose-narration mt-4">
          The export is available at any time, not only on the way out: a copy of your own data should not cost you the
          product. Deletion enters a seven-day grace period, mails an undo link, and completes within thirty days with a
          message enumerating exactly what was removed.
        </p>
        <DeletionControls canDeleteOrganization={isOwner} />

        {view.deletionRequests.length === 0 ? null : (
          <ul className="mt-7 space-y-3">
            {view.deletionRequests.map((entry) => (
              <li key={entry.id} className="text-[13px] text-ink-muted">
                <span className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                  {entry.subjectKind} · {entry.status}
                </span>{' '}
                {entry.detail}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="mt-14 font-serif text-[12.5px] italic text-ink-faint">
        Read {formatCivilDate(access.now, 'UTC')}. Every change on this page is written to the audit log with the person
        who made it.
      </p>
    </Frame>
  );
}
