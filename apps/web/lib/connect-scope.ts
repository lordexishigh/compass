import { GITHUB_CONNECTOR_ID } from '@compass/github-connector';
import { JIRA_CONNECTOR_ID } from '@compass/jira-connector';
import { SLACK_CONNECTOR_ID, conversationKeyFromChannelLink } from '@compass/slack-connector';
import type { SourceSelection } from '@compass/db';

import { providerById, type ConnectProviderId } from './connect-source';

/**
 * What a manager typed, turned into the selection list a connector is configured from.
 *
 * ## Why this is validated and not merely trimmed
 *
 * This is a system boundary in the sense that matters — a form field — and each provider addresses its
 * subjects differently enough that a wrong shape fails in a different place for each: an owner with no
 * repository name becomes a 404 on tomorrow's ingest, a lower-case project key becomes an empty JQL
 * result that reads as a quiet sprint, and a channel *name* where an id was needed becomes
 * `channel_not_found`. All three would surface a day later as a thin report rather than immediately as a
 * correction a manager can make while they are still looking at the screen.
 *
 * So each provider states the shape it accepts, the rejected lines come back **with the line that was
 * rejected**, and nothing partial is saved. The alternative — save what parsed, drop the rest — is the
 * one that produces a report missing a repository nobody remembers deselecting.
 *
 * ## Why there is no upload and no config file
 *
 * The criterion is explicit that no step may require a CSV or a hand-edited file. A textarea of lines is
 * the whole input, and it is also what makes the flow *fast*: pasting five repository names is one action,
 * whereas a per-repository dialog is five round trips through a modal.
 */

export interface ScopeParseResult {
  readonly selections: readonly SourceSelection[];
  /** Lines that were not a valid subject for this provider, each with why. */
  readonly rejected: readonly { readonly line: string; readonly reason: string }[];
}

/** The connector id whose configuration a provider's selections belong to. */
export const connectorIdFor = (providerId: ConnectProviderId): string => {
  switch (providerId) {
    case 'github':
      return GITHUB_CONNECTOR_ID;
    case 'jira':
      return JIRA_CONNECTOR_ID;
    case 'slack':
      return SLACK_CONNECTOR_ID;
  }
};

const linesOf = (raw: string): readonly string[] =>
  raw
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** `owner/name`, which is the only form that addresses a repository unambiguously. */
const parseRepository = (line: string): SourceSelection | string => {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line.replace(/^https?:\/\/[^/]+\//, ''));
  if (match === null) {
    return 'Not a repository. Compass needs owner/name — for example northwind/checkout-web.';
  }
  const [, owner, name] = match as unknown as [string, string, string];
  return {
    // The provider's own address for it, stored whole so the connector never has to re-parse a name.
    selectionKey: `${owner}/${name}`,
    // The repository key the report prints. The bare name rather than owner/name, because that is what a
    // team calls it and the owner is the same for every repository in the list.
    displayName: name,
  };
};

/**
 * A project key, which trackers write in upper case.
 *
 * Upper-cased rather than rejected when somebody types `dev`: the key is case-insensitive to a person and
 * case-sensitive to JQL, so silently correcting it is the behaviour that matches what they meant. A key
 * with a space or a slash in it is a different mistake and is refused.
 */
const parseProject = (line: string): SourceSelection | string => {
  const candidate = line.toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(candidate)) {
    return 'Not a project key. Compass needs the short key the tracker shows on an issue — for example DEV.';
  }
  return { selectionKey: candidate, displayName: candidate };
};

/**
 * A channel link or id, plus the name to show.
 *
 * `#name https://…/archives/C04AB12CD34` and a bare link both work; the name is optional and defaults to
 * the id. Compass cannot look a name up — that would need the scope it refuses to request — so a manager
 * who wants a readable name in the report types one, and the report prints exactly that.
 */
const parseChannel = (line: string): SourceSelection | string => {
  const parts = line.split(/\s+/).filter((part) => part.length > 0);
  const linkPart = parts.find((part) => conversationKeyFromChannelLink(part) !== null);
  if (linkPart === undefined) {
    return (
      'Not a channel link. In Slack, use “Copy link” on the channel and paste it here — Compass cannot ' +
      'list your channels, so it can only read the ones you name.'
    );
  }

  const conversationKey = conversationKeyFromChannelLink(linkPart);
  if (conversationKey === null) return 'Not a channel link.';

  const named = parts.filter((part) => part !== linkPart).join(' ');
  return {
    selectionKey: conversationKey,
    displayName: named.length > 0 ? (named.startsWith('#') ? named : `#${named}`) : conversationKey,
  };
};

/**
 * Parses a whole form field, de-duplicating by key and keeping the manager's order.
 *
 * Order is kept because the connect screen lists the selections back, and a re-sorted list reads as though
 * Compass had reinterpreted the choice. De-duplication is by key rather than by line so that
 * `northwind/checkout-web` typed twice is one repository rather than two reads of it.
 */
export function parseScopeSelections(providerId: ConnectProviderId, raw: string): ScopeParseResult {
  const parse =
    providerId === 'github' ? parseRepository : providerId === 'jira' ? parseProject : parseChannel;

  const selections: SourceSelection[] = [];
  const rejected: { line: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const line of linesOf(raw)) {
    const parsed = parse(line);
    if (typeof parsed === 'string') {
      rejected.push({ line, reason: parsed });
      continue;
    }
    if (seen.has(parsed.selectionKey)) continue;
    seen.add(parsed.selectionKey);
    selections.push(parsed);
  }

  return { selections, rejected };
}

/**
 * How the connect screen prints a stored selection back into the form.
 *
 * The inverse of the parse, so a manager editing their selection sees what they typed rather than an
 * internal shape. For a channel that means `#name <id>` — the id is what Compass holds, and hiding it
 * would mean a manager could not tell two identically-named channels apart.
 */
export function formatScopeSelections(
  providerId: ConnectProviderId,
  selections: readonly SourceSelection[],
): string {
  return selections
    .map((selection) =>
      providerId === 'slack' && selection.displayName !== selection.selectionKey
        ? `${selection.displayName} ${selection.selectionKey}`
        : selection.selectionKey,
    )
    .join('\n');
}

/** One sentence for the audit record and the screen: what this source is now scoped to. */
export function describeSelections(
  providerId: ConnectProviderId,
  selections: readonly SourceSelection[],
): string {
  const { noun, plural } = providerById(providerId).selection;
  if (selections.length === 0) {
    return (
      `No ${plural} are selected, so Compass reads nothing from this source. That is stated rather than ` +
      `treated as “read everything”: an unscoped read would put work nobody asked about into this ` +
      `team’s report.`
    );
  }
  return `${selections.length} ${selections.length === 1 ? noun : plural}: ${selections
    .map((selection) => selection.displayName)
    .join(', ')}.`;
}
