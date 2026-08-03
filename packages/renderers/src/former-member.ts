/**
 * "A former team member" — how a report already written stops printing a withdrawn name.
 *
 * ## Why past reports are rewritten at read time rather than in place
 *
 * A stored report is a record of what Compass said on a day. Rewriting the rows would
 * destroy that: the content hash would no longer match, a manager comparing the page against
 * the copy in their inbox would find Compass disagreeing with itself, and the append-only
 * history behind it could not be corrected to match. So the rows stay exactly as written and
 * the *rendering* substitutes.
 *
 * Future reports are handled somewhere else entirely and much more cheaply — `developerName`
 * in `@compass/analysis` returns the pseudonym, so the name never enters the prose in the
 * first place. This module exists only for the reports that were written before the name was
 * withdrawn.
 *
 * ## What survives, and why that is the whole point
 *
 * Ticket keys, pull request numbers, SHAs, counts, ages and dates are untouched: the
 * substitution replaces a person's name and nothing else. A report that lost its numbers
 * along with the name would be a false record of the team's week, and the manager who
 * withdrew the name would have quietly deleted a day's evidence of work that happened.
 *
 * ## Why "a former team member" and not the pseudonym
 *
 * A pseudonym asserts continuity — `Wren Alder` in Tuesday's report and `Wren Alder` in
 * today's is a claim that those are the same person, which is exactly what the pseudonym is
 * for going forward. A report written *before* the withdrawal was written about a named
 * person, and re-labelling it retroactively would invent a continuity the document never had.
 * "A former team member" says what is true: somebody was here, and their name is no longer
 * printed.
 */

/** What replaces a withdrawn name in a report written before the withdrawal. */
export const FORMER_MEMBER_PHRASE = 'a former team member';

/**
 * The phrase, capitalised when it lands at the start of a sentence.
 *
 * Not cosmetic. Report prose routinely opens a sentence with a name — "Priya Raman is holding
 * 40% of the work in flight" — and substituting a lower-case phrase there produces "a former
 * team member is holding…", which reads as a typo and undermines the sentence it appears in.
 */
const CAPITALISED_PHRASE = 'A former team member';

const escapeLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Replaces each withdrawn name with the phrase, longest name first.
 *
 * Longest first so that a person called `Ann` cannot rewrite the first three letters of a
 * colleague called `Annette`. Whole-word boundaries for the same reason, and because a name
 * that appears inside a branch name (`priya/fix-checkout`) is a *reference* the report needs
 * to keep intact — a branch nobody can find is not a redaction, it is a broken receipt.
 *
 * The possessive is handled explicitly: "Priya's review" has to become "a former team
 * member's review" and not "a former team members review".
 */
export function substituteFormerMembers(text: string, withdrawnNames: readonly string[]): string {
  if (text.length === 0 || withdrawnNames.length === 0) return text;

  let out = text;

  for (const name of [...withdrawnNames].sort((left, right) => right.length - left.length)) {
    if (name.trim().length === 0) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\d/_-])${escapeLiteral(name)}(?![\\p{L}\\d/_-])`, 'gu');

    out = out.replace(pattern, (_match, offset: number) => {
      // Sentence-initial when nothing but whitespace precedes, or the previous
      // non-whitespace character ends a sentence.
      const before = out.slice(0, offset).replace(/\s+$/u, '');
      const sentenceInitial = before.length === 0 || /[.!?:—]$/u.test(before);
      return sentenceInitial ? CAPITALISED_PHRASE : FORMER_MEMBER_PHRASE;
    });
  }

  return out;
}

/** The same substitution over a nullable field, for the many optional strings in a report. */
export const substituteFormerMembersIn = (
  text: string | null | undefined,
  withdrawnNames: readonly string[],
): string | null =>
  text === null || text === undefined ? null : substituteFormerMembers(text, withdrawnNames);
