import { WEEKLY_TOPIC_KEYS, type WeeklyDigest, type WeeklyTopic, type WeeklyTopicKey } from '@compass/analysis';
import { formatCivilDate } from '@compass/clock';

/**
 * The weekly digest, as prose.
 *
 * ## Prose only, and structurally so
 *
 * There is no chart, no canvas, no svg and no table of metrics — not because none was added, but
 * because this renderer emits nothing but strings and a test asserts that the rendered output contains
 * none of those tokens. A velocity trend is four sprint names and a sentence about the direction; a
 * workload distribution is a sentence and the names it is about. Anything a sparkline would have shown
 * is either in the sentence or is a number the reader could not have acted on anyway.
 *
 * ## An undefined topic is rendered, never skipped
 *
 * A digest that silently omitted the topics it could not compute would read as a complete picture of a
 * week Compass does not have the history for. So every one of the six appears in every digest, and the
 * ones without a figure carry the producer's own sentence about what is missing. That is why the
 * `state` on a topic is a closed two-arm union rather than an optional number — there is no shape here
 * a renderer could accidentally format as zero.
 */

export const WEEKLY_RENDERER_ID = 'weekly-template';

export interface RenderedWeeklyDigest {
  readonly rendererId: typeof WEEKLY_RENDERER_ID;
  /** `Compass weekly — platform — week ending 2026-07-31`. */
  readonly masthead: string;
  /**
   * The civil date the week ends on, on its own.
   *
   * A field rather than something a page recovers with `masthead.split(' ').at(-1)` — which happened to work
   * only because the date is the last token, and would have started showing a fragment of a team name the
   * moment the masthead's wording changed.
   */
  readonly weekEnding: string;
  readonly summary: string;
  readonly topics: readonly RenderedWeeklyTopic[];
  /** Every sentence, joined. */
  readonly prose: string;
  readonly text: string;
}

export interface RenderedWeeklyTopic {
  readonly key: WeeklyTopicKey;
  readonly title: string;
  /** The analysis function that produced it, carried through for the page's own attribution line. */
  readonly producer: string;
  readonly state: 'stated' | 'undefined';
  readonly prose: string;
}

/**
 * One topic's paragraph: its sentence, then its supporting lines.
 *
 * The supporting lines are joined with semicolons rather than emitted as bullets, because the digest is
 * a document and a document does not bullet-point four sprint names. A topic with no figure is one
 * sentence and nothing else — there is nothing to support.
 */
export function renderWeeklyTopic(topic: WeeklyTopic): string {
  if (topic.state === 'undefined') return topic.statement;

  const detail = topic.detail.filter((line) => line.trim().length > 0);
  return detail.length === 0 ? topic.statement : `${topic.statement} ${detail.join('; ')}.`;
}

export function renderWeeklyDigest(digest: WeeklyDigest): RenderedWeeklyDigest {
  const weekEnding = formatCivilDate(digest.instant, digest.timezone);
  const masthead = `Compass weekly — ${digest.teamKey} — week ending ${weekEnding}`;

  // Read from `WEEKLY_TOPIC_KEYS` rather than from the payload's own array, so the rendered order is the
  // fixed documented one even if a future producer appends a topic out of sequence. A weekly whose
  // topics reordered between two weeks would have to be re-learned every week.
  const byKey = new Map(digest.topics.map((topic) => [topic.key, topic]));
  const topics: RenderedWeeklyTopic[] = WEEKLY_TOPIC_KEYS.flatMap((key) => {
    const topic = byKey.get(key);
    if (topic === undefined) return [];
    return [
      {
        key,
        title: topic.title,
        producer: topic.producer,
        state: topic.state,
        prose: renderWeeklyTopic(topic),
      },
    ];
  });

  const prose = [digest.summary, ...topics.map((topic) => topic.prose)]
    .filter((line) => line.length > 0)
    .join('\n\n');

  const text = [
    masthead,
    '',
    digest.summary,
    '',
    ...topics.flatMap((topic) => [topic.title.toUpperCase(), '', topic.prose, '']),
  ]
    .join('\n')
    .trimEnd();

  return {
    rendererId: WEEKLY_RENDERER_ID,
    masthead,
    weekEnding,
    summary: digest.summary,
    topics,
    prose,
    text: `${text}\n`,
  };
}
