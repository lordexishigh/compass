import { describe, expect, it } from 'vitest';

import {
  extractDateTokens,
  extractNumericTokens,
  numericTokensBySentence,
  sentencesWithNumbers,
  splitSentences,
} from '@compass/analysis';

const texts = (input: string): readonly string[] => extractNumericTokens(input).map((token) => token.text);

describe('the numeric-token extractor', () => {
  it('reads a quantity in every shape the product writes one', () => {
    expect(texts('62% complete, 24 of 39 points, 3.5 days, 1,240 commits')).toEqual([
      '62%',
      '24',
      '39',
      '3.5',
      '1,240',
    ]);
  });

  it('reads the value behind the token, separators and percent sign stripped', () => {
    expect(extractNumericTokens('1,240 and 62% and 3.5').map((token) => token.value)).toEqual([1240, 62, 3.5]);
  });

  it('refuses identifiers that merely contain digits', () => {
    // Every one of these appears in real Compass prose. None is a measurement.
    expect(texts('DEV-501 merged as #9201 at 7a8b9c0 on branch feat/CHK-701, reaching R2 under T13 and rule W1')).toEqual(
      [],
    );
  });

  it('treats an ISO date as one name for one day, not three quantities', () => {
    expect(texts('projected 2026-08-14')).toEqual([]);
    expect(extractDateTokens('window 2026-07-30 to 2026-07-31')).toEqual(['2026-07-30', '2026-07-31']);
  });

  it('is re-runnable: a global pattern does not carry lastIndex between calls', () => {
    const input = '3 of 4 sources';
    expect(texts(input)).toEqual(texts(input));
  });

  it('finds a quantity at the very start and the very end of a string', () => {
    expect(texts('4 open, waiting 9')).toEqual(['4', '9']);
  });
});

describe('the sentence splitter', () => {
  it('splits on a terminator followed by whitespace, and on a line break', () => {
    expect(splitSentences('One. Two! Three?\nFour').map((sentence) => sentence.text)).toEqual([
      'One.',
      'Two!',
      'Three?',
      'Four',
    ]);
  });

  it('keeps a decimal point inside its sentence', () => {
    expect(splitSentences('Cycle time is 3.5 days.').map((sentence) => sentence.text)).toEqual([
      'Cycle time is 3.5 days.',
    ]);
  });

  it('reports offsets into the original text', () => {
    const [second] = splitSentences('One. Two.').slice(1);
    expect(second?.start).toBe(5);
    expect(second?.end).toBe(9);
  });

  it('drops nothing but whitespace', () => {
    expect(splitSentences('\n\n  \n').map((sentence) => sentence.text)).toEqual([]);
  });
});

describe('pairing quantities with the sentence that has to explain them', () => {
  const text = 'Sprint 43 stands at 62% — behind pace.\nNothing is blocked.\nFour reviews are waiting 9 days.';

  it('attributes each quantity to its own sentence', () => {
    // `43` counts. A bare digit run separated by spaces is indistinguishable from
    // a measurement, and a validator that guessed "that one is a sprint name"
    // would be guessing about exactly the claims it exists to check.
    expect(numericTokensBySentence(text).map((entry) => entry.tokens.map((token) => token.text))).toEqual([
      ['43', '62%'],
      [],
      ['9'],
    ]);
  });

  it('offsets the tokens back into the whole text, not into the sentence', () => {
    const [first] = sentencesWithNumbers(text);
    const percent = first?.tokens[1];
    expect(text.slice(percent?.start ?? 0, percent?.end ?? 0)).toBe('62%');
  });

  it('narrows to only the sentences that state a quantity', () => {
    expect(sentencesWithNumbers(text)).toHaveLength(2);
  });
});
