import {
  MILLIS_PER_DAY,
  addDaysInZone,
  instantAtLocalTime,
  startOfDayInZone,
  toIso,
  zonedParts,
  type Instant,
} from '@compass/clock';

import type { MemoKind, MemoSubjectKind } from './assertion.js';
import type { ExtractionRequest, ExtractorPort } from './extract.js';

/**
 * The rule-based extractor: no API key, no network, no model.
 *
 * This is the path a default deployment takes. Manager Memos are the answer to "the manager
 * cannot tell the system anything", and a feature that needs a paid key to accept a sentence
 * would leave that dealbreaker in place for anyone who has not configured one — the same
 * reason the deterministic template renderer, not Claude, is the primary narration path.
 *
 * ## What it does and does not try to be
 *
 * It recognises the cue phrases managers actually type, which are strikingly consistent per
 * kind ("is out", "on leave", "dropped from the sprint", "blocked on <vendor>"). It does not
 * try to be a general parser. When no cue matches it returns `null`, and `extractMemo` turns
 * that into the refusal — which is the correct outcome, not a degradation: an unrecognised
 * line *should* be refused rather than guessed at, and that is true whichever extractor is
 * running.
 *
 * ## Order matters, and the order is deliberate
 *
 * `external_blocker` is tested before `unavailable`, because "Priya is blocked on Acme" and
 * "Priya is out" both name a person and the first is not an absence. `context_note` is tested
 * last and only on an explicit cue, so it can never absorb a line another kind would have
 * claimed — the catch-all-as-note failure this design exists to prevent.
 */

export const DETERMINISTIC_EXTRACTOR_ID = 'rules/1';

/** A candidate object, deliberately untyped: `parseAssertion` is the authority. */
interface Candidate {
  readonly kind: MemoKind;
  readonly subjectKind: MemoSubjectKind;
  readonly subjectHint: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly openEnded: boolean;
  readonly counterparty: string | null;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** ISO weekday numbers, so "until Thursday" resolves to the next Thursday. */
const WEEKDAYS: Readonly<Record<string, number>> = {
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7,
};

const TICKET_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/**
 * A civil date, as an instant at the start of that day in the manager's zone.
 *
 * Everything here works in whole days in the manager's timezone rather than in UTC instants,
 * because "out until Thursday" is a statement about days where the manager is, and resolving
 * it in UTC puts the boundary in the middle of their afternoon for half the world.
 */
const startOfDay = (instant: Instant, timezone: string): Instant => startOfDayInZone(instant, timezone);

/** The end instant that makes `day` the last covered day: midnight of the day after. */
const endOfDayExclusive = (day: Instant, timezone: string): Instant => addDaysInZone(day, timezone, 1);

/** `2026-07-27` in the manager's zone, as the instant that day begins. */
const civilDayStart = (year: number, month: number, day: number, timezone: string): Instant =>
  instantAtLocalTime(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    '00:00',
    timezone,
  );

/**
 * The year a bare "Jul 27" means.
 *
 * The current year, unless that date is more than six months in the past — in which case the
 * manager means the coming one. A memo typed on 2 January saying "out until Dec 20" is about
 * last December only in the reading no human intends.
 */
function resolveYear(month: number, day: number, now: Instant, timezone: string): number {
  const thisYear = zonedParts(now, timezone).year;

  const candidate = civilDayStart(thisYear, month, day, timezone);
  const sixMonthsAgo = (startOfDay(now, timezone) - 182 * MILLIS_PER_DAY) as Instant;
  return candidate < sixMonthsAgo ? thisYear + 1 : thisYear;
}

/** `Jul 27`, `27 Jul`, `2026-07-27`, `today`, `tomorrow`, `Thursday`. */
function parseCivilDate(text: string, now: Instant, timezone: string): Instant | null {
  const cleaned = text.trim().toLowerCase().replace(/^(the|on|of)\s+/, '');
  if (cleaned.length === 0) return null;

  if (cleaned === 'today') return startOfDay(now, timezone);
  if (cleaned === 'tomorrow') return addDaysInZone(startOfDay(now, timezone), timezone, 1);

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (iso !== null) {
    return civilDayStart(Number(iso[1]), Number(iso[2]), Number(iso[3]), timezone);
  }

  // "Jul 27" / "July 27th"
  const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(cleaned);
  if (monthFirst !== null) {
    const month = MONTHS[monthFirst[1] ?? ''];
    const day = Number(monthFirst[2]);
    if (month !== undefined && day >= 1 && day <= 31) {
      return civilDayStart(resolveYear(month, day, now, timezone), month, day, timezone);
    }
  }

  // "27 Jul" / "27th of July"
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?$/.exec(cleaned);
  if (dayFirst !== null) {
    const month = MONTHS[dayFirst[2] ?? ''];
    const day = Number(dayFirst[1]);
    if (month !== undefined && day >= 1 && day <= 31) {
      return civilDayStart(resolveYear(month, day, now, timezone), month, day, timezone);
    }
  }

  // "Thursday" — the next one, today included.
  const weekday = WEEKDAYS[cleaned];
  if (weekday !== undefined) {
    const today = startOfDay(now, timezone);
    for (let offset = 0; offset < 7; offset += 1) {
      const candidate = addDaysInZone(today, timezone, offset);
      if (isoWeekdayInZone(candidate, timezone) === weekday) return candidate;
    }
  }

  return null;
}

/**
 * ISO weekday (1 = Monday) of the civil day an instant falls in.
 *
 * Derived from the zone's own calendar parts rather than from `Date.getUTCDay()` on the
 * instant: for a zone far enough from UTC those disagree, and "until Thursday" resolving to
 * Wednesday would silently shorten every absence by a day.
 */
function isoWeekdayInZone(instant: Instant, timezone: string): number {
  const parts = zonedParts(instant, timezone);
  const dayOfWeek = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return dayOfWeek === 0 ? 7 : dayOfWeek;
}

interface ParsedRange {
  readonly from: Instant;
  readonly until: Instant | null;
  readonly openEnded: boolean;
}

/**
 * The date range a line names, in the manager's zone.
 *
 * Returns a range starting today when the line names no start — "Marcus is out until Friday"
 * means from now. An explicitly indefinite line ("indefinitely", "until further notice", or no
 * end at all) is open-ended, which is a reading of what was said rather than a default filled
 * in for a missing field: a manager who writes "Marcus is out" has told us when it starts and
 * has not told us when it ends.
 */
function parseRange(text: string, now: Instant, timezone: string): ParsedRange {
  const today = startOfDay(now, timezone);
  const lower = text.toLowerCase();

  if (/\b(indefinitely|until further notice|open[- ]ended|for the foreseeable)\b/.test(lower)) {
    return { from: today, until: null, openEnded: true };
  }

  // "from Jul 27 until Aug 2", "Jul 27 to Aug 2", "Jul 27-Aug 2", "Jul 27 – Aug 2"
  const span =
    /\b(?:from\s+)?([a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\.?|\d{4}-\d{2}-\d{2})\s*(?:-|–|—|to|until|till|thru|through)\s*([a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\.?|\d{4}-\d{2}-\d{2})\b/.exec(
      lower,
    );
  if (span !== null) {
    const from = parseCivilDate(span[1] ?? '', now, timezone);
    const until = parseCivilDate(span[2] ?? '', now, timezone);
    if (from !== null && until !== null) {
      // Inclusive of the named last day: "Jul 27–Aug 2" covers all of 2 August, so the
      // half-open end instant is midnight on the 3rd. Same conversion the roster form makes.
      return { from, until: endOfDayExclusive(until, timezone), openEnded: false };
    }
  }

  // "until Thursday", "back on Monday", "through Friday"
  const single =
    /\b(?:until|till|thru|through|back\s+(?:on|in)|returns?\s+(?:on|in))\s+([a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\.?|\d{4}-\d{2}-\d{2}|[a-z]+)\b/.exec(
      lower,
    );
  if (single !== null) {
    const until = parseCivilDate(single[1] ?? '', now, timezone);
    if (until !== null) {
      // "back on Monday" means Monday is the first day *present*, so the absence ends at the
      // start of Monday. "until Friday" means Friday is the last day out. The distinction is
      // real and the cue word is what carries it.
      const returnsThatDay = /back|returns?/.test(single[0]);
      return {
        from: today,
        until: returnsThatDay ? until : endOfDayExclusive(until, timezone),
        openEnded: false,
      };
    }
  }

  if (/\b(today)\b/.test(lower)) {
    return { from: today, until: endOfDayExclusive(today, timezone), openEnded: false };
  }
  if (/\b(this week)\b/.test(lower)) {
    return { from: today, until: addDaysInZone(today, timezone, 5), openEnded: false };
  }
  if (/\b(next week)\b/.test(lower)) {
    const start = addDaysInZone(today, timezone, 7);
    return { from: start, until: addDaysInZone(start, timezone, 5), openEnded: false };
  }
  if (/\b(tomorrow)\b/.test(lower)) {
    const start = addDaysInZone(today, timezone, 1);
    return { from: start, until: endOfDayExclusive(start, timezone), openEnded: false };
  }

  // Nothing named an end. Open-ended, and the manager can close it later.
  return { from: today, until: null, openEnded: true };
}

/**
 * The person a line is about.
 *
 * Returns the words before the cue phrase, which is where a name sits in every phrasing
 * managers use ("Marcus is out", "Priya's on leave until Friday"). Deliberately returns the
 * *hint* rather than a resolved key — `subject.ts` decides which Marcus, and refuses to guess
 * between two of them.
 */
function subjectBeforeCue(text: string, cue: RegExp): string | null {
  const match = cue.exec(text);
  if (match === null || match.index === 0) return null;

  const before = text
    .slice(0, match.index)
    .replace(/^(hi|hey|hello|fyi|note|heads up|just so you know)[\s,:—-]+/i, '')
    .replace(/[\s,'’]+$/, '')
    .trim();

  return before.length === 0 ? null : before;
}

/** The counterparty named after a "blocked on" cue. */
function counterpartyAfter(text: string, cue: RegExp): string | null {
  const match = cue.exec(text);
  if (match === null) return null;

  const after = text.slice(match.index + match[0].length).trim();
  if (after.length === 0) return null;

  // Up to the first clause boundary: "blocked on Acme Corp until they reply" names Acme Corp.
  const name = after
    .split(/\s+(?:until|till|through|thru|since|because|so|and|while|pending)\b/i)[0]
    ?.replace(/[.,;:!?]+$/, '')
    .replace(/^(the|our|a|an)\s+/i, '')
    .trim();

  return name === undefined || name.length === 0 ? null : name;
}

const UNAVAILABLE_CUE =
  /\b(?:is|are|'s|’s|will be|was)?\s*(?:out of office|out|on (?:annual )?leave|on holiday|on vacation|on pto|off sick|sick|away|unavailable|on parental leave|on sabbatical|at a conference|on jury duty)\b/i;

const DESCOPED_CUE =
  /\b(?:de-?scoped|descope|dropped|cut|pulled|removed|deferred|pushed|moved out|taken out|no longer in)\b/i;

const REPRIORITIZED_CUE =
  /\b(?:re-?prioriti[sz]ed|prioriti[sz]ed|bumped|escalat(?:ed|ing)|deprioriti[sz]ed|downgraded|upgraded|now (?:the )?(?:top|highest|lowest) priority|top priority|urgent now)\b/i;

const EXTERNAL_BLOCKER_CUE = /\b(?:blocked (?:on|by)|waiting (?:on|for)|held up by|stuck (?:on|behind))\s+/i;

/**
 * The explicit "this is context" cues.
 *
 * `context:` and `background:` end in a colon, so they carry no trailing `\b` — a word
 * boundary after `:` followed by a space does not exist, and requiring one made both cues
 * unmatchable while looking perfectly correct.
 */
const CONTEXT_NOTE_CUE =
  /(?:\bfor context\b|\bcontext:|\bfyi\b|\bnote that\b|\bjust so you know\b|\bworth knowing\b|\bbackground:)/i;

/** Cues that name an *internal* wait, which is not an external blocker. */
const INTERNAL_COUNTERPARTY =
  /^(me|us|myself|the team|our team|review|reviews|code review|qa|ci|the build|deploy|deployment|merge)$/i;

export class DeterministicExtractor implements ExtractorPort {
  readonly extractorId = DETERMINISTIC_EXTRACTOR_ID;

  /**
   * Rules are synchronous; the port is not.
   *
   * Declared `async` rather than returning a resolved promise by hand, so the two extractors
   * are the same shape at the call site. Nothing here awaits, which is the whole point: this
   * path costs no network round trip and no key.
   */
  async extract(request: ExtractionRequest): Promise<unknown | null> {
    const text = request.rawText.trim();
    const range = parseRange(text, request.now, request.timezone);

    const window = {
      effectiveFrom: toIso(range.from),
      effectiveUntil: range.until === null ? null : toIso(range.until),
      openEnded: range.openEnded,
    };

    // ---- external_blocker, before `unavailable` ---------------------------------
    //
    // "Priya is blocked on Acme" names a person and is not an absence. Testing the
    // blocker cue first is what keeps that line out of the suppression path.
    const counterparty = counterpartyAfter(text, EXTERNAL_BLOCKER_CUE);
    if (counterparty !== null && !INTERNAL_COUNTERPARTY.test(counterparty)) {
      const ticket = TICKET_KEY.exec(text);
      if (ticket !== null) {
        return {
          kind: 'external_blocker',
          subjectKind: 'ticket',
          subjectHint: ticket[1] ?? '',
          ...window,
          counterparty,
        } satisfies Candidate;
      }
      // An external blocker with no ticket named cannot be attributed to a piece of work,
      // and attributing it to the *person* waiting would make the report blame them for
      // somebody else's delay. Refused rather than reshaped.
      return null;
    }

    // ---- descoped ---------------------------------------------------------------
    if (DESCOPED_CUE.test(text) && /\b(?:sprint|scope|iteration)\b/i.test(text)) {
      const ticket = TICKET_KEY.exec(text);
      if (ticket === null) return null;
      return {
        kind: 'descoped',
        subjectKind: 'ticket',
        subjectHint: ticket[1] ?? '',
        ...window,
        counterparty: null,
      } satisfies Candidate;
    }

    // ---- reprioritized ----------------------------------------------------------
    if (REPRIORITIZED_CUE.test(text)) {
      const ticket = TICKET_KEY.exec(text);
      if (ticket === null) return null;
      return {
        kind: 'reprioritized',
        subjectKind: 'ticket',
        subjectHint: ticket[1] ?? '',
        ...window,
        counterparty: null,
      } satisfies Candidate;
    }

    // ---- unavailable ------------------------------------------------------------
    const person = subjectBeforeCue(text, UNAVAILABLE_CUE);
    if (person !== null && UNAVAILABLE_CUE.test(text)) {
      return {
        kind: 'unavailable',
        subjectKind: 'developer',
        subjectHint: person,
        ...window,
        counterparty: null,
      } satisfies Candidate;
    }

    // ---- context_note, last and only on an explicit cue -------------------------
    //
    // Never a catch-all. A line reaches this branch only by *saying* it is context, so an
    // unrecognised instruction is refused rather than quietly filed as a comment.
    if (CONTEXT_NOTE_CUE.test(text)) {
      const ticket = TICKET_KEY.exec(text);
      return {
        kind: 'context_note',
        subjectKind: ticket === null ? 'team' : 'ticket',
        subjectHint: ticket?.[1] ?? 'this team',
        ...window,
        counterparty: null,
      } satisfies Candidate;
    }

    return null;
  }
}
