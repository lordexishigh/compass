import {
  SUGGESTED_TIME_ZONES,
  type DeliveryChannelView,
  type DeliveryView,
} from '../lib/delivery-source';

/**
 * `your daily` — when the report arrives, where, and how to stop it.
 *
 * ## A Server Component with real forms, and no client JavaScript
 *
 * Same posture as the billing and enterprise-identity screens: two `<form method="post">` elements per
 * channel, an `intent` field because HTML can only POST, and a 303 back to this page carrying an
 * outcome slug. Nothing here holds state, so nothing here needs to hydrate — and a manager configuring
 * their morning report on a phone with a bad connection gets a form that works before the JavaScript
 * would have loaded.
 *
 * ## Why both channels are always drawn
 *
 * An unconfigured channel is stated as absent — "Compass is not sending you the daily by Slack" — in
 * the same voice the report uses for missing deploy signal. Hiding it would mean the only way to
 * discover that Slack delivery exists is to already know.
 *
 * ## The claim in the opening paragraph is load-bearing
 *
 * "The whole report, in the body" is not marketing: `@compass/delivery`'s spine refuses to render a
 * delivery that is missing one of the six sections, and the Slack channel splits a long section across
 * blocks rather than truncating it. This screen says so because the promise is the reason to switch it
 * on — a notification with a link to click is a different product.
 */

const ZONE_LIST_ID = 'delivery-zone-suggestions';

const CHANNEL_NAME: Readonly<Record<DeliveryChannelView['channel'], string>> = {
  email: 'email',
  slack: 'Slack',
};

/** What each scope means in a sentence, so the select is not a vocabulary test. */
const SCOPE_SENTENCE: Readonly<Record<'team' | 'merged' | 'both', string>> = {
  team: 'each team’s own report',
  merged: 'the merged report across your teams',
  both: 'both the merged report and each team’s',
};

export function DeliverySchedule({
  view,
  stated,
}: {
  readonly view: DeliveryView;
  readonly stated: string | null;
}) {
  return (
    <section aria-labelledby="delivery-schedule" className="mt-12 hairline pt-6">
      <h2 id="delivery-schedule" className="section-label">
        your daily
      </h2>
      <p className="prose-narration mt-3 text-[15px]">
        Compass writes one report a day. Say when you want it and where, and it arrives on its own —
        the whole report, all six sections in order, in the body of the message. Not a notification
        with a link to click.
      </p>

      {stated !== null && (
        <p role="status" className="prose-narration mt-5 border-l-2 border-verified pl-3 text-[15px]">
          {stated}
        </p>
      )}

      {view.channels.map((channel) => (
        <ChannelBlock
          key={channel.channel}
          channel={channel}
          defaultScope={view.defaultScope}
          teamKeys={view.teamKeys}
        />
      ))}

      {/*
        Suggestions, not a permitted set — the input accepts any IANA zone and the route validates it.
        One datalist for both channels: the options are identical and two would be two things to keep
        in step.
      */}
      <datalist id={ZONE_LIST_ID}>
        {SUGGESTED_TIME_ZONES.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </section>
  );
}

function ChannelBlock({
  channel,
  defaultScope,
  teamKeys,
}: {
  readonly channel: DeliveryChannelView;
  readonly defaultScope: 'team' | 'merged' | 'both';
  readonly teamKeys: readonly string[];
}) {
  const name = CHANNEL_NAME[channel.channel];
  const id = (field: string): string => `delivery-${channel.channel}-${field}`;

  return (
    <div className="hairline mt-6 pt-6 first-of-type:mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-ink-strong">{name}</h3>
        <span className="stated-absence text-[13px]">
          {!channel.configured
            ? 'not set up'
            : channel.active
              ? `sending · ${channel.sendTime} ${channel.timezone}`
              : 'switched off'}
        </span>
      </div>

      <p className="prose-narration mt-2 text-[15px]">
        {!channel.configured ? (
          <>
            Compass is not sending you the daily by {name}. Nothing is scheduled and nothing has been
            queued.
          </>
        ) : channel.active ? (
          <>
            Every day at <span className="data-token">{channel.sendTime}</span> in{' '}
            <span className="data-token">{channel.timezone}</span>,{' '}
            {SCOPE_SENTENCE[channel.scopeChoice === 'default' ? defaultScope : channel.scopeChoice]} goes
            to <span className="data-token">{channel.target}</span>.
            {channel.changedLabel === null ? '' : ` Last changed ${channel.changedLabel}.`}
          </>
        ) : (
          <>
            Switched off. The schedule is kept — <span className="data-token">{channel.sendTime}</span>{' '}
            in <span className="data-token">{channel.timezone}</span> to{' '}
            <span className="data-token">{channel.target}</span> — so saving below turns it back on
            unchanged.
          </>
        )}
      </p>

      <form method="post" action="/api/delivery/subscription" className="mt-5">
        <input type="hidden" name="channel" value={channel.channel} />
        <input type="hidden" name="intent" value="save" />

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className="block" htmlFor={id('target')}>
              <span className="section-label">
                {channel.channel === 'email' ? 'send it to' : 'channel or direct message'}
              </span>
            </label>
            <input
              id={id('target')}
              name="target"
              type={channel.channel === 'email' ? 'email' : 'text'}
              required
              defaultValue={channel.target}
              placeholder={channel.channel === 'email' ? 'you@example.com' : '#platform-standup or @you'}
              className="goal-input"
              autoComplete={channel.channel === 'email' ? 'email' : 'off'}
              aria-describedby={id('target-hint')}
            />
            <p id={id('target-hint')} className="stated-absence mt-2 text-[13px]">
              {channel.channel === 'email'
                ? 'Any mailbox. It does not have to be the address you sign in with.'
                : 'A channel, a direct message, or the id Slack shows in a channel’s details.'}
            </p>
          </div>

          <div>
            <label className="block" htmlFor={id('sendTime')}>
              <span className="section-label">at</span>
            </label>
            <input
              id={id('sendTime')}
              name="sendTime"
              type="time"
              required
              defaultValue={channel.sendTime}
              className="goal-input"
              aria-describedby={id('sendTime-hint')}
            />
            <p id={id('sendTime-hint')} className="stated-absence mt-2 text-[13px]">
              24-hour <span className="data-token">HH:MM</span>, in the zone below.
            </p>
          </div>

          <div>
            <label className="block" htmlFor={id('timezone')}>
              <span className="section-label">in this zone</span>
            </label>
            <input
              id={id('timezone')}
              name="timezone"
              type="text"
              required
              defaultValue={channel.timezone}
              list={ZONE_LIST_ID}
              placeholder="Europe/London"
              className="goal-input"
              autoComplete="off"
              aria-describedby={id('timezone-hint')}
            />
            <p id={id('timezone-hint')} className="stated-absence mt-2 text-[13px]">
              {/* Honest about why it has to be typed: the server cannot read a browser's clock, and a
                  guessed zone is a daily that arrives at the wrong hour every day without saying why. */}
              Compass cannot read your clock, so it needs the zone by name. Daylight saving is handled
              from that — a 07:30 daily stays 07:30 across the change.
            </p>
          </div>

          <div>
            <label className="block" htmlFor={id('scope')}>
              <span className="section-label">which report</span>
            </label>
            <select
              id={id('scope')}
              name="scope"
              defaultValue={channel.scopeChoice}
              className="goal-input"
              aria-describedby={id('scope-hint')}
            >
              <option value="default">
                {teamKeys.length === 0
                  ? 'follow my seat — no team on it, so nothing would be sent'
                  : `follow my seat — ${SCOPE_SENTENCE[defaultScope]} today`}
              </option>
              <option value="team">each team’s own report</option>
              <option value="merged">the merged report across my teams</option>
              <option value="both">both — merged first, then each team</option>
            </select>
            <p id={id('scope-hint')} className="stated-absence mt-2 text-[13px]">
              {teamKeys.length === 0
                ? 'Your seat carries no team scope, and a per-team daily has no team to be about, so it would send nothing. The merged report is preselected because it is the one that can be delivered.'
                : `Your seat reads ${teamKeys.join(', ')}. “Follow my seat” keeps up if that changes.`}
            </p>
          </div>
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-5">
          <button type="submit" className="primary-action">
            {channel.configured && channel.active ? `Save ${name} schedule` : `Send me the daily by ${name}`}
          </button>

          {/* A second form rather than a second button in the first one: two submits in one form
              would both carry the schedule fields, and a browser that validated them would refuse to
              let somebody switch delivery off because the zone field was empty. */}
        </div>
      </form>

      {channel.configured && channel.active && (
        <form method="post" action="/api/delivery/subscription" className="mt-4">
          <input type="hidden" name="channel" value={channel.channel} />
          <input type="hidden" name="intent" value="stop" />
          <button type="submit" className="tertiary-action">
            stop sending the {name} daily
          </button>
        </form>
      )}
    </div>
  );
}
