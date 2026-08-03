import { FORMER_MEMBER_PHRASE, substituteFormerMembers, substituteFormerMembersIn } from '@compass/renderers';
import { describe, expect, it } from 'vitest';

/**
 * Subtask 002, second criterion: a report already written stops printing a withdrawn name and
 * keeps everything else.
 *
 * The "everything else" is the half worth testing hardest. Withdrawing a name must not become a
 * way to delete a day of the team's evidence, so every assertion below that checks the phrase
 * appeared is paired with one checking the receipts survived.
 */

const PRIYA = 'Priya Raman';
const MARCUS = 'Marcus Hale';

describe('the phrase', () => {
  it('is the product’s own words, not a redaction bar', () => {
    expect(FORMER_MEMBER_PHRASE).toBe('a former team member');
  });
});

describe('substituting a withdrawn name', () => {
  it('replaces the name and keeps the tracker key, the pull request and the count', () => {
    const line = `${PRIYA} merged #883 for PLAT-742, closing 3 of the 5 open items at 7a8b9c0.`;

    const out = substituteFormerMembers(line, [PRIYA]);

    expect(out).not.toContain(PRIYA);
    // Every receipt. A report that lost these along with the name would be a false record of
    // the week, and the person who withdrew the name would have deleted somebody else's work.
    expect(out).toContain('#883');
    expect(out).toContain('PLAT-742');
    expect(out).toContain('3 of the 5 open items');
    expect(out).toContain('7a8b9c0');
  });

  it('capitalises the phrase when it opens a sentence', () => {
    // "a former team member is holding…" reads as a typo and undermines the sentence it is in.
    expect(substituteFormerMembers(`${PRIYA} is holding 40% of the work.`, [PRIYA])).toBe(
      'A former team member is holding 40% of the work.',
    );
  });

  it('capitalises after a full stop, and not mid-sentence', () => {
    const out = substituteFormerMembers(`The queue is deep. ${PRIYA} owns it, and ${PRIYA} is away.`, [PRIYA]);

    expect(out).toBe('The queue is deep. A former team member owns it, and a former team member is away.');
  });

  it('handles a possessive without eating the apostrophe', () => {
    expect(substituteFormerMembers(`${PRIYA}'s review is the oldest.`, [PRIYA])).toBe(
      "A former team member's review is the oldest.",
    );
  });

  it('substitutes two withdrawn names in one line', () => {
    const out = substituteFormerMembers(`${PRIYA} asked ${MARCUS} for a second look.`, [PRIYA, MARCUS]);

    expect(out).not.toContain(PRIYA);
    expect(out).not.toContain(MARCUS);
    expect(out).toBe('A former team member asked a former team member for a second look.');
  });

  it('leaves a name that is part of a branch or a path alone', () => {
    // A branch name is a reference the report needs to keep. A branch nobody can find is not a
    // redaction, it is a broken receipt.
    const line = `Merged priya/fix-checkout into main, authored by ${PRIYA}.`;

    const out = substituteFormerMembers(line, [PRIYA, 'priya']);

    expect(out).toContain('priya/fix-checkout');
    expect(out).not.toContain(PRIYA);
  });

  it('does not rewrite the middle of a longer word', () => {
    expect(substituteFormerMembers('Announcement from Ann', ['Ann'])).toBe(
      `Announcement from ${FORMER_MEMBER_PHRASE}`,
    );
  });

  it('replaces the longer name first, so an overlapping shorter one cannot corrupt it', () => {
    // Replacing `Ann` before `Annette` would leave `a former team memberette` — a word that is
    // neither a name nor a redaction. Sorting by descending length is what prevents it.
    expect(substituteFormerMembers('Annette and Ann', ['Ann', 'Annette'])).toBe(
      'A former team member and a former team member',
    );
  });

  it('is a no-op when nothing is withdrawn', () => {
    const line = `${PRIYA} merged #883.`;
    expect(substituteFormerMembers(line, [])).toBe(line);
  });

  it('ignores an empty name rather than replacing every gap in the text', () => {
    const line = `${PRIYA} merged #883.`;
    expect(substituteFormerMembers(line, ['   '])).toBe(line);
  });

  it('passes null through, for the many optional strings in a report', () => {
    expect(substituteFormerMembersIn(null, [PRIYA])).toBeNull();
    expect(substituteFormerMembersIn(`${PRIYA} again`, [PRIYA])).toBe('A former team member again');
  });
});
