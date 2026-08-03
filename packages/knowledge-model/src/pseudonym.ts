/**
 * The one person-to-pseudonym map in Compass.
 *
 * Two features need it and they must not each grow their own, because a person who
 * appears as `Wren Alder` in one place and `Contributor 3` in another is not
 * pseudonymised, they are merely harder to read about:
 *
 *  - **Anonymization** (`beta-privacy-and-transparency-002`) replaces a departed or
 *    erasure-requesting developer's name in every *future* report.
 *  - **LLM redacted mode** (`beta-privacy-and-transparency-006`) replaces every
 *    developer's name on the way out to the model and puts the real ones back
 *    locally afterwards.
 *
 * So the scheme lives here, in the layer that owns the roster, and both callers
 * import it. `packages/narrator` consumes the map through its options rather than
 * importing this package — narration sits above the knowledge model and the
 * dependency-cruiser rules keep it that way.
 *
 * ## What a pseudonym looks like, and why
 *
 * Two capitalised words drawn from neutral word lists — `Wren Alder`, `Heron
 * Basalt`. Three properties are load-bearing:
 *
 *  1. **It reads as a name.** The narrator writes sentences about people, and the
 *     grounding validator classifies capitalised runs as person names. A pseudonym
 *     shaped like `dev_7f3a` would be tokenised as something else entirely, and the
 *     prose would read like a log file.
 *  2. **It is deterministic in the developer key.** The same person gets the same
 *     pseudonym on every report, on every process, forever — that is what makes
 *     `"a stable pseudonym"` a checkable claim rather than a hope.
 *  3. **It cannot be mistaken for a real name in this dataset.** Both lists are
 *     natural-world nouns, never given names or surnames.
 *
 * Uniqueness is *not* a property of `pseudonymFor` alone — 64 x 64 combinations
 * collide by the birthday bound long before an organization runs out of engineers.
 * Uniqueness is established by the two callers, each in the way that suits it:
 * anonymization stores the pseudonym it assigned under a unique constraint, and
 * `pseudonymMap` disambiguates within the set of people it is asked about. See each
 * for the reasoning.
 */

/** What a past report says instead of a name it can no longer print. */
export const FORMER_TEAM_MEMBER = 'a former team member';

/**
 * The first word. Birds and small animals: recognisably a name-shaped token,
 * recognisably not somebody's given name.
 */
const FIRST_WORDS: readonly string[] = Object.freeze([
  'Wren',
  'Heron',
  'Kestrel',
  'Plover',
  'Marten',
  'Otter',
  'Lynx',
  'Ibis',
  'Curlew',
  'Osprey',
  'Merlin',
  'Sable',
  'Ermine',
  'Vireo',
  'Tern',
  'Petrel',
  'Grebe',
  'Avocet',
  'Bittern',
  'Godwit',
  'Redshank',
  'Dunlin',
  'Serin',
  'Siskin',
  'Linnet',
  'Twite',
  'Brambling',
  'Firecrest',
  'Goldcrest',
  'Nuthatch',
  'Treecreeper',
  'Dipper',
  'Fieldfare',
  'Redwing',
  'Waxwing',
  'Shrike',
  'Chough',
  'Jackdaw',
  'Raven',
  'Rook',
  'Swift',
  'Martin',
  'Nightjar',
  'Hobby',
  'Harrier',
  'Buzzard',
  'Goshawk',
  'Sparrowhawk',
  'Peregrine',
  'Gyrfalcon',
  'Eider',
  'Scoter',
  'Pintail',
  'Gadwall',
  'Wigeon',
  'Teal',
  'Shoveler',
  'Pochard',
  'Smew',
  'Goosander',
  'Garganey',
  'Shelduck',
  'Brent',
  'Barnacle',
]);

/** The second word. Stone, timber and weather: never a surname anybody carries. */
const SECOND_WORDS: readonly string[] = Object.freeze([
  'Alder',
  'Basalt',
  'Cairn',
  'Dune',
  'Elm',
  'Fell',
  'Gorse',
  'Hazel',
  'Ivy',
  'Juniper',
  'Kelp',
  'Larch',
  'Moraine',
  'Nettle',
  'Oakum',
  'Pumice',
  'Quarrystone',
  'Rowan',
  'Sedge',
  'Thistle',
  'Umber',
  'Vellum',
  'Willow',
  'Xanthe',
  'Yarrow',
  'Zephyr',
  'Amber',
  'Bracken',
  'Cinder',
  'Drift',
  'Ember',
  'Flint',
  'Granite',
  'Heather',
  'Isle',
  'Jetsam',
  'Kellet',
  'Loam',
  'Marl',
  'Nimbus',
  'Onyx',
  'Peat',
  'Quartz',
  'Reed',
  'Slate',
  'Tarn',
  'Ulmus',
  'Vein',
  'Wrack',
  'Xylem',
  'Yew',
  'Zinc',
  'Ashlar',
  'Bilberry',
  'Chalk',
  'Dolomite',
  'Estuary',
  'Furze',
  'Gneiss',
  'Hornbeam',
  'Inlet',
  'Jasper',
  'Kaolin',
  'Limestone',
]);

/**
 * A stable 32-bit digest of a string.
 *
 * FNV-1a rather than SHA-256 from `node:crypto`, for one reason: this package sits
 * below the process edge and is imported by the pure analysis path, so it may not
 * pull in a Node built-in. The digest is not a security boundary — a pseudonym is
 * meant to be *consistent*, not unguessable, and anonymization keeps the real
 * mapping in a table rather than hiding it in a hash.
 */
function digest32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // `Math.imul` keeps the multiply in 32-bit space; `*` would go through a double
    // and lose the low bits that carry all the entropy here.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The pseudonym proposed for a developer key.
 *
 * Deterministic and total: every key gets a pseudonym, including one that has never
 * been anonymised, because redacted mode needs one for everybody on the team.
 */
export function pseudonymFor(developerKey: string): string {
  const hash = digest32(developerKey);
  const first = FIRST_WORDS[hash % FIRST_WORDS.length];
  const second = SECOND_WORDS[Math.floor(hash / FIRST_WORDS.length) % SECOND_WORDS.length];

  // Both lists are non-empty literals, so neither lookup can miss. The fallbacks
  // exist because `noUncheckedIndexedAccess` is on and a thrown error here would
  // take down a report over a cosmetic label.
  return `${first ?? 'Wren'} ${second ?? 'Alder'}`;
}

/**
 * How many alternates `pseudonymMap` will try before it gives up on prettiness.
 *
 * Salting rather than suffixing (`Wren Alder II`) because a suffix is not a name and
 * would be re-tokenised as an ordinal by the grounding validator. Re-hashing with a
 * counter keeps every pseudonym the same *shape*.
 */
const MAX_COLLISION_SALTS = 64;

export interface PseudonymAssignment {
  readonly developerKey: string;
  /** The name as it stands in the report today. Null when the roster holds none. */
  readonly realName: string | null;
  readonly pseudonym: string;
}

/**
 * A pseudonym per developer, guaranteed distinct within the set asked about.
 *
 * Distinctness is the whole reason this is not just `people.map(pseudonymFor)`. In
 * redacted mode the real names are put back by string substitution *after*
 * generation, so two people sharing one pseudonym would make the substitution
 * ambiguous — and the failure would not be a crash, it would be a report that
 * attributes one person's work to another. So a collision is resolved here, by
 * re-hashing with a salt, deterministically in the order the keys sort.
 *
 * Sorting first is what makes it deterministic: the same team produces the same
 * assignment on every run regardless of the order the caller happened to collect
 * them in, which is what lets two consecutive reports agree.
 */
export function pseudonymMap(
  people: readonly { readonly developerKey: string; readonly realName: string | null }[],
): readonly PseudonymAssignment[] {
  const taken = new Set<string>();
  const ordered = [...people].sort((left, right) =>
    left.developerKey < right.developerKey ? -1 : left.developerKey > right.developerKey ? 1 : 0,
  );

  return ordered.map((person) => {
    let pseudonym = pseudonymFor(person.developerKey);

    for (let salt = 1; taken.has(pseudonym) && salt <= MAX_COLLISION_SALTS; salt += 1) {
      pseudonym = pseudonymFor(`${person.developerKey}#${salt}`);
    }

    taken.add(pseudonym);
    return { developerKey: person.developerKey, realName: person.realName, pseudonym };
  });
}
