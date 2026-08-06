import type { TeamOption } from '../lib/report-source';

/**
 * Which team this report is about, and the others.
 *
 * ## Why it is a row of names and not a `<select>`
 *
 * A manager of one to three teams — the whole audience of this product — has two or three of
 * these. A dropdown hides two items behind a click and turns a fact about the organization into a
 * control you have to operate to read. Set as a row of names, the page states its own scope: *this
 * is platform, and there are also checkout and insights*. That is the "document, not dashboard"
 * rule applied to navigation, and it is why the current team is set in the same type as the others
 * rather than being pulled out into a heading.
 *
 * ## Absent teams say so
 *
 * A team Compass has never written a report for renders as its name with the reason beside it, in
 * the stated-absence voice, rather than as a link that goes nowhere or as a name silently omitted.
 * Omitting it would be the worse failure: a manager would learn the wrong number of teams.
 *
 * A Server Component. Nothing here has state — the switcher is links.
 */
export function TeamSwitcher({ teams }: { readonly teams: readonly TeamOption[] }) {
  // One team is not a choice, and a row of one reads as a control that does nothing.
  if (teams.length < 2) return null;

  return (
    <nav aria-label="Teams" className="hairline mt-8 pt-6">
      <h2 className="section-label">teams</h2>
      <ul className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-2">
        {teams.map((team) => (
          <li key={team.teamKey} className="flex items-baseline gap-2">
            {team.isCurrent ? (
              <>
                {/*
                  `aria-current="page"` rather than a visual cue alone: the 2px emerald tick is the
                  same mark the Six Spine uses for the active section, and a screen reader gets
                  nothing from a border.
                */}
                <span aria-current="page" className="border-l-2 border-verified pl-2 data-token">
                  {team.teamKey}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-ink-faint">this report</span>
              </>
            ) : team.href === null ? (
              <>
                <span className="data-token text-ink-faint">{team.teamKey}</span>
                <span className="stated-absence text-[13px]">{team.absence}</span>
              </>
            ) : (
              <a
                href={team.href}
                className="data-token underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified"
              >
                {team.teamKey}
              </a>
            )}
          </li>
        ))}
        <li>
          {/* The cross-team read, from the one page that names every team. */}
          <a
            href="/merged"
            className="text-[13px] underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified"
          >
            all teams, ranked
          </a>
        </li>
      </ul>
    </nav>
  );
}
