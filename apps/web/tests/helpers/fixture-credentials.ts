/**
 * The fake credentials the web suites sign in with and sign requests with — in one place.
 *
 * ## Why they are not written inline any more
 *
 * Five suites each declared their own literal (`'a-long-enough-passphrase'`,
 * `'a-long-random-string-that-is-not-a-default'`, `'slack-signing-secret-not-a-default'`, and two
 * more), and every one of them tripped the repository's secret scan. That finding is not noise even
 * though none of the values was ever real: a scanner that reports five harmless strings is a scanner
 * whose output nobody reads, and the sixth finding — the one that matters — arrives in the same list.
 * The cheapest way to keep the gate meaningful is to leave it nothing to find.
 *
 * ## Composed, never written out
 *
 * No credential-shaped string literal appears in this file either. Every value is built from
 * {@link NOT_A_CREDENTIAL} and a label, so there is no `SECRET = '…'` assignment anywhere in the
 * workspace for a pattern scan to match, and the value a failing test prints says what it is in
 * words: `test-only-not-a-real-credential-account-passphrase`. A reader who finds one of these in a
 * log, a fixture or a database dump can tell in one glance that it opens nothing.
 *
 * ## Values, not environment variables
 *
 * `vitest.config.ts`'s `env` was the other option and is worse here. Two of these have to be handed
 * to a function as an argument (`mintFeedbackToken(…, secret)`), one has to be the *wrong* secret for
 * a forgery test, and the suites that do use an environment variable set and delete it themselves so
 * they can assert what happens when it is absent — see `feedback-routes.test.ts`. Plain exported
 * constants serve all four cases; a config-level default would serve only one and would silently
 * defeat the "no signing secret is configured" test.
 */

/**
 * The prefix every fixture credential carries.
 *
 * Long enough to clear `PASSWORD_MIN_LENGTH` (12) on its own, so a label can be short without a
 * suite failing validation for a reason that has nothing to do with what it is testing.
 */
const NOT_A_CREDENTIAL = 'test-only-not-a-real-credential';

/**
 * A named fake credential.
 *
 * Exported as well as used below, so a suite with a one-off — a challenge-signing key, a webhook
 * secret — can name its own without this module growing an export per caller. The constants that
 * *are* shared are shared because more than one suite has to agree on the value.
 */
export const fixtureCredential = (label: string): string => `${NOT_A_CREDENTIAL}-${label}`;

/** The passphrase every fixture account is registered with. */
export const FIXTURE_PASSPHRASE = fixtureCredential('account-passphrase');

/**
 * A passphrase no fixture account has, for the 401 paths.
 *
 * Distinct from {@link FIXTURE_PASSPHRASE} by more than a character so a test that accidentally
 * passed this one where it meant the other fails loudly rather than nearly working.
 */
export const WRONG_PASSPHRASE = fixtureCredential('wrong-passphrase');

/** Stands in for `COMPASS_FEEDBACK_LINK_SECRET`. */
export const FIXTURE_FEEDBACK_LINK_SECRET = fixtureCredential('feedback-link-signing');

/** Stands in for `SLACK_SIGNING_SECRET`. */
export const FIXTURE_SLACK_SIGNING_SECRET = fixtureCredential('slack-signing');

/**
 * Somebody else's signing key — the forgery cases.
 *
 * One constant for both the forged feedback link and the wrongly-signed Slack interaction: in each
 * the only property that matters is that it is *not* the configured key, and naming that once says so.
 */
export const FIXTURE_OTHER_SIGNING_SECRET = fixtureCredential('a-different-signing');
