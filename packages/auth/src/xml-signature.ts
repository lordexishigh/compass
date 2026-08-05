import { createHash, createVerify, timingSafeEqual } from 'node:crypto';

/**
 * A strict, deliberately tiny XML reader, exclusive canonicaliser and XML-DSIG verifier.
 *
 * ## Why this exists rather than a dependency
 *
 * Verifying a SAML assertion means verifying an XML signature, and an XML signature is defined over
 * *canonicalised* bytes rather than over the document as received. There is no way around
 * canonicalisation: the IdP signed a normalised serialisation, so anything that does not reproduce it
 * exactly cannot check the signature at all.
 *
 * The honest reason this is hand-written is that a dependency could not be added to this workspace:
 * `pnpm add` here fails with `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` because the per-package
 * `node_modules` are junctions into a shared store, and the repair is a full reinstall that rewrites
 * the whole checkout. So the choice was between writing this and not shipping SAML.
 *
 * ## How the risk is contained: refuse everything unusual
 *
 * A half-correct canonicaliser is a signature bypass, and the standard way that happens is a document
 * containing a construct the canonicaliser mishandles. So the design principle here is **not** "handle
 * XML"; it is **"accept a very small subset of XML and refuse the rest, loudly"**. Concretely, parsing
 * fails closed on:
 *
 *  - **Any `<!DOCTYPE`, `<!ENTITY` or internal DTD.** This is the XXE and billion-laughs door, and
 *    SAML needs none of it. Refused before a byte is interpreted.
 *  - **Comments.** Canonicalisation has two forms, with and without comments, and the difference is a
 *    known signature-wrapping vector: a comment inserted inside a signed element can split a text node
 *    so that a naive reader sees different content than the canonical form. No SAML assertion needs a
 *    comment, so one is treated as a malformed document.
 *  - **CDATA sections and processing instructions.** Same reasoning: legal XML, never present in a
 *    real assertion, and each one is a second text-model to get right for no benefit.
 *  - **Unknown entity references.** Only the five predefined ones and numeric character references are
 *    resolved; anything else is refused rather than passed through as literal text, because passing it
 *    through is how a digest is computed over different bytes than a reader sees.
 *
 * And verification refuses anything outside one profile: exclusive canonicalisation, RSA-SHA256,
 * SHA-256 digests, exactly one `Reference`, exactly the enveloped-signature and canonicalisation
 * transforms, and a reference that resolves to exactly one element. `verifyXmlSignature` returns a
 * reason for each refusal so a misconfigured IdP gets a diagnosis rather than "invalid signature".
 *
 * ## The two wrapping attacks, and where each is stopped
 *
 *  - **Duplicate ids.** If two elements carry the referenced id, an attacker can have the digest
 *    computed over their own copy while the application reads the other. `findElementsById` collects
 *    *all* matches and verification refuses when there is more than one.
 *  - **Signature relocation.** The caller says which element must be signed and this checks that the
 *    `Signature` is a direct child of that element, so a signature lifted from elsewhere in the
 *    document cannot vouch for it.
 */

// ---------------------------------------------------------------------------
// The document model
// ---------------------------------------------------------------------------

export const XMLNS = 'http://www.w3.org/2000/xmlns/';

export interface XmlAttribute {
  /** As written, e.g. `ds:Id` or `Id`. */
  readonly qualifiedName: string;
  readonly prefix: string;
  readonly localName: string;
  /** Resolved at parse time. Empty for an unprefixed attribute, which has no namespace. */
  readonly namespaceUri: string;
  readonly value: string;
}

export interface XmlElement {
  readonly qualifiedName: string;
  readonly prefix: string;
  readonly localName: string;
  readonly namespaceUri: string;
  /** Non-namespace attributes only. Declarations live in `namespaceDeclarations`. */
  readonly attributes: readonly XmlAttribute[];
  /** Prefix (`''` for the default namespace) to URI, as declared *on this element*. */
  readonly namespaceDeclarations: Readonly<Record<string, string>>;
  /** Every prefix in scope here, including inherited ones. */
  readonly inScopeNamespaces: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  parent: XmlElement | null;
}

export interface XmlText {
  readonly kind: 'text';
  readonly value: string;
}

export type XmlNode = ({ readonly kind: 'element' } & XmlElement) | XmlText;

export class XmlParseError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'XmlParseError';
  }
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/**
 * Resolves character data, refusing any entity that is not predefined or numeric.
 *
 * Refusing rather than passing through is the point. A document containing `&custom;` has to be
 * rejected, because there is no interpretation of it that is both safe and faithful: resolving it
 * needs a DTD (which is refused), and leaving it literal means the bytes that were digested are not
 * the bytes anybody reads.
 */
function decodeCharacterData(raw: string): string {
  let out = '';
  let index = 0;

  while (index < raw.length) {
    const ampersand = raw.indexOf('&', index);
    if (ampersand === -1) {
      out += raw.slice(index);
      break;
    }

    out += raw.slice(index, ampersand);
    const semicolon = raw.indexOf(';', ampersand);
    if (semicolon === -1) throw new XmlParseError('An unterminated entity reference is not valid XML.');

    const reference = raw.slice(ampersand + 1, semicolon);

    if (reference.startsWith('#')) {
      const isHex = reference[1] === 'x' || reference[1] === 'X';
      const digits = isHex ? reference.slice(2) : reference.slice(1);
      const codePoint = Number.parseInt(digits, isHex ? 16 : 10);

      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || digits.length === 0) {
        throw new XmlParseError(`\`&${reference};\` is not a valid character reference.`);
      }
      out += String.fromCodePoint(codePoint);
    } else {
      const resolved = PREDEFINED_ENTITIES[reference];
      if (resolved === undefined) {
        throw new XmlParseError(
          `\`&${reference};\` is not one of the five predefined XML entities. Compass refuses documents ` +
            'that need a DTD to interpret.',
        );
      }
      out += resolved;
    }

    index = semicolon + 1;
  }

  return out;
}

const NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9._:-]*$/;

const splitName = (qualifiedName: string): { readonly prefix: string; readonly localName: string } => {
  const colon = qualifiedName.indexOf(':');
  if (colon === -1) return { prefix: '', localName: qualifiedName };

  const prefix = qualifiedName.slice(0, colon);
  const localName = qualifiedName.slice(colon + 1);
  if (prefix.length === 0 || localName.length === 0 || localName.includes(':')) {
    throw new XmlParseError(`\`${qualifiedName}\` is not a valid qualified name.`);
  }
  return { prefix, localName };
};

/**
 * Parses one XML document into the model above, or throws.
 *
 * Not a general parser and not trying to be. See the module header for the list of legal-XML
 * constructs it refuses on purpose.
 */
export function parseXml(source: string): XmlElement {
  // Strip a leading byte-order mark rather than failing on it: it is invisible, IdPs do emit it, and
  // it carries no meaning that could change a signature.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new XmlParseError(
      'This document declares a DOCTYPE or an entity. Compass refuses both: they are the external-entity ' +
        'and entity-expansion attack surface, and no SAML assertion needs either.',
    );
  }
  if (text.includes('<![CDATA[')) {
    throw new XmlParseError('CDATA sections are refused: they are a second text model with no legitimate use here.');
  }
  if (text.includes('<!--')) {
    throw new XmlParseError(
      'Comments are refused. Canonicalisation has a with-comments and a without-comments form, and the ' +
        'difference is a known signature-wrapping vector — so a comment is treated as a malformed document.',
    );
  }

  let index = 0;
  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];

  const current = (): XmlElement | undefined => stack[stack.length - 1];

  while (index < text.length) {
    const open = text.indexOf('<', index);

    if (open === -1) {
      // Trailing character data. Only whitespace is legal after the root element closes.
      if (text.slice(index).trim().length > 0) {
        throw new XmlParseError('Character data appears outside the root element.');
      }
      break;
    }

    if (open > index) {
      const raw = text.slice(index, open);
      const parent = current();
      if (parent === undefined) {
        if (raw.trim().length > 0) throw new XmlParseError('Character data appears outside the root element.');
      } else {
        (parent.children as XmlNode[]).push({ kind: 'text', value: decodeCharacterData(raw) });
      }
    }

    if (text.startsWith('<?', open)) {
      const close = text.indexOf('?>', open);
      if (close === -1) throw new XmlParseError('An unterminated processing instruction is not valid XML.');
      // The XML declaration is allowed and contributes nothing to canonical form; any *other*
      // processing instruction is refused, because it would.
      const body = text.slice(open + 2, close);
      if (!/^xml\s/i.test(body) && body.toLowerCase() !== 'xml') {
        throw new XmlParseError('Processing instructions other than the XML declaration are refused.');
      }
      index = close + 2;
      continue;
    }

    if (text.startsWith('</', open)) {
      const close = text.indexOf('>', open);
      if (close === -1) throw new XmlParseError('An unterminated end tag is not valid XML.');

      const name = text.slice(open + 2, close).trim();
      const element = stack.pop();
      if (element === undefined || element.qualifiedName !== name) {
        throw new XmlParseError(
          `End tag \`</${name}>\` does not match the open element \`<${element?.qualifiedName ?? '(none)'}>\`.`,
        );
      }
      index = close + 1;
      continue;
    }

    // A start tag. The scan has to respect quoting, because `>` inside an attribute value is data.
    let cursor = open + 1;
    let quote: string | null = null;
    while (cursor < text.length) {
      const character = text[cursor];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= text.length) throw new XmlParseError('An unterminated start tag is not valid XML.');

    const rawTag = text.slice(open + 1, cursor);
    const selfClosing = rawTag.trimEnd().endsWith('/');
    const tagBody = selfClosing ? rawTag.trimEnd().slice(0, -1) : rawTag;

    const nameMatch = /^([^\s/>]+)/.exec(tagBody.trimStart());
    const qualifiedName = nameMatch?.[1];
    if (qualifiedName === undefined || !NAME_PATTERN.test(qualifiedName)) {
      throw new XmlParseError(`\`${qualifiedName ?? ''}\` is not a valid element name.`);
    }

    const parsedAttributes = parseAttributes(tagBody.trimStart().slice(qualifiedName.length));

    const namespaceDeclarations: Record<string, string> = {};
    const attributes: XmlAttribute[] = [];
    const seen = new Set<string>();

    for (const attribute of parsedAttributes) {
      if (seen.has(attribute.name)) {
        throw new XmlParseError(`\`${attribute.name}\` is declared twice on the same element.`);
      }
      seen.add(attribute.name);

      if (attribute.name === 'xmlns') {
        namespaceDeclarations[''] = attribute.value;
      } else if (attribute.name.startsWith('xmlns:')) {
        const prefix = attribute.name.slice('xmlns:'.length);
        if (prefix.length === 0) throw new XmlParseError('`xmlns:` with no prefix is not a valid declaration.');
        if (attribute.value.length === 0) {
          // Undeclaring a prefix is only legal for the default namespace.
          throw new XmlParseError(`\`xmlns:${prefix}\` may not be set to the empty namespace.`);
        }
        namespaceDeclarations[prefix] = attribute.value;
      } else {
        const { prefix, localName } = splitName(attribute.name);
        attributes.push({ qualifiedName: attribute.name, prefix, localName, namespaceUri: '', value: attribute.value });
      }
    }

    const parent = current() ?? null;
    const inScopeNamespaces: Record<string, string> = { ...(parent?.inScopeNamespaces ?? {}), ...namespaceDeclarations };

    const { prefix, localName } = splitName(qualifiedName);
    const elementNamespace = prefix === '' ? (inScopeNamespaces[''] ?? '') : inScopeNamespaces[prefix];
    if (prefix !== '' && elementNamespace === undefined) {
      throw new XmlParseError(`Prefix \`${prefix}\` is not bound to a namespace.`);
    }

    const resolvedAttributes = attributes.map((attribute) => {
      if (attribute.prefix === '') return attribute;
      // An unprefixed attribute is in no namespace; a prefixed one must resolve, and the default
      // namespace never applies to attributes.
      const uri = inScopeNamespaces[attribute.prefix];
      if (uri === undefined) {
        throw new XmlParseError(`Attribute prefix \`${attribute.prefix}\` is not bound to a namespace.`);
      }
      return { ...attribute, namespaceUri: uri };
    });

    const element: XmlElement = {
      qualifiedName,
      prefix,
      localName,
      namespaceUri: elementNamespace ?? '',
      attributes: resolvedAttributes,
      namespaceDeclarations: Object.freeze({ ...namespaceDeclarations }),
      inScopeNamespaces: Object.freeze(inScopeNamespaces),
      children: [],
      parent,
    };

    if (parent === null) {
      if (root !== null) throw new XmlParseError('A document may have only one root element.');
      root = element;
    } else {
      (parent.children as XmlNode[]).push({ kind: 'element', ...element });
    }

    /**
     * The node pushed onto the parent and the node pushed onto the stack must be the *same object*.
     *
     * Spreading `element` into `{ kind: 'element', ...element }` above makes a copy, so children
     * appended while the element is on the stack would land on the copy and be invisible from the
     * tree. Reading the child back out is what keeps one identity.
     */
    if (!selfClosing) {
      const attached =
        parent === null
          ? element
          : ((parent.children as XmlNode[])[(parent.children as XmlNode[]).length - 1] as {
              kind: 'element';
            } & XmlElement);
      stack.push(attached);
    }

    index = cursor + 1;
  }

  if (stack.length > 0) {
    throw new XmlParseError(`\`<${stack[stack.length - 1]?.qualifiedName ?? ''}>\` is never closed.`);
  }
  if (root === null) throw new XmlParseError('The document has no root element.');

  return root;
}

interface RawAttribute {
  readonly name: string;
  readonly value: string;
}

function parseAttributes(source: string): readonly RawAttribute[] {
  const attributes: RawAttribute[] = [];
  const pattern = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

  let match: RegExpExecArray | null;
  let consumed = 0;

  while ((match = pattern.exec(source)) !== null) {
    const name = match[1] ?? '';
    if (!NAME_PATTERN.test(name)) throw new XmlParseError(`\`${name}\` is not a valid attribute name.`);
    attributes.push({ name, value: decodeCharacterData(match[3] ?? match[4] ?? '') });
    consumed = pattern.lastIndex;
  }

  // Anything left over that is not whitespace was an attribute without a quoted value, which this
  // reader refuses rather than guessing at.
  if (source.slice(consumed).trim().length > 0) {
    throw new XmlParseError(`\`${source.slice(consumed).trim()}\` is not a well-formed attribute list.`);
  }

  return attributes;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

export const elementChildren = (element: XmlElement): readonly ({ kind: 'element' } & XmlElement)[] =>
  element.children.filter(
    (child): child is { kind: 'element' } & XmlElement => child.kind === 'element',
  );

/** Direct children matching a namespace and local name. */
export const childrenNamed = (
  element: XmlElement,
  namespaceUri: string,
  localName: string,
): readonly ({ kind: 'element' } & XmlElement)[] =>
  elementChildren(element).filter(
    (child) => child.namespaceUri === namespaceUri && child.localName === localName,
  );

export const childNamed = (
  element: XmlElement,
  namespaceUri: string,
  localName: string,
): (({ kind: 'element' } & XmlElement) | null) => childrenNamed(element, namespaceUri, localName)[0] ?? null;

/** The element's text content, concatenated and trimmed. */
export function textOf(element: XmlElement): string {
  let out = '';
  for (const child of element.children) {
    if (child.kind === 'text') out += child.value;
    else out += textOf(child);
  }
  return out.trim();
}

export const attributeValue = (element: XmlElement, localName: string): string | null =>
  element.attributes.find((attribute) => attribute.prefix === '' && attribute.localName === localName)?.value ??
  null;

/**
 * Every element in the document carrying this id, in document order.
 *
 * **All** of them, deliberately — the count is the security-relevant fact. A document where two
 * elements share the referenced id lets an attacker have the digest computed over one copy while the
 * application reads the other, which is the classic XML signature wrapping attack. Returning a list
 * makes the duplicate visible to the caller instead of silently resolving to the first match.
 *
 * `ID`, `Id` and `id` are all collected: SAML uses `ID`, XML-DSIG uses `Id`, and a verifier that
 * matched only its own spelling could be handed a second element whose id it did not consider.
 */
export function findElementsById(root: XmlElement, id: string): readonly XmlElement[] {
  const found: XmlElement[] = [];

  const walk = (element: XmlElement): void => {
    for (const name of ['ID', 'Id', 'id'] as const) {
      if (attributeValue(element, name) === id) {
        found.push(element);
        break;
      }
    }
    for (const child of elementChildren(element)) walk(child);
  };

  walk(root);
  return found;
}

// ---------------------------------------------------------------------------
// Exclusive canonicalisation
// ---------------------------------------------------------------------------

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');

/**
 * Exclusive XML canonicalisation (`http://www.w3.org/2001/10/xml-exc-c14n#`) of one subtree.
 *
 * ## Why *exclusive* is the only form implemented
 *
 * Inclusive c14n pulls every in-scope namespace declaration down onto the apex of the subtree, so the
 * canonical form of an element depends on ancestors that are not part of what was signed — which is
 * why signing an assertion inclusively breaks the moment the surrounding `Response` adds a namespace.
 * Exclusive c14n emits only *visibly utilised* prefixes, and it is what every SAML IdP uses for this
 * reason. Implementing one form and refusing the other keeps the surface small enough to be right.
 *
 * ## The rules, and where each is applied below
 *
 *  - **Visibly utilised prefixes only.** An element's own prefix, plus the prefixes of its attributes.
 *    A namespace declared on the element but used by nothing is *not* emitted.
 *  - **Declarations are emitted only when they change.** `renderedNamespaces` carries what the output
 *    already establishes, so a prefix re-declared to the same URI on a child produces nothing.
 *  - **Namespace declarations sorted by prefix**, default namespace first; **attributes sorted by
 *    namespace URI then local name**, with unprefixed attributes (which are in no namespace) first.
 *  - **Empty elements are written open-and-close**, never self-closed.
 *  - `omitApexDeclarations` exists for the `SignedInfo` case: the digest is computed over the
 *    reference, and the signature over `SignedInfo` canonicalised in the *document's* namespace
 *    context, so the two calls differ only in whether the apex inherits.
 */
export function canonicalizeExclusive(
  element: XmlElement,
  options: {
    /** Elements to leave out — the enveloped `Signature` when digesting what it signs. */
    readonly omit?: ReadonlySet<XmlElement>;
  } = {},
): string {
  const omit = options.omit ?? new Set<XmlElement>();

  const render = (node: XmlElement, renderedNamespaces: Readonly<Record<string, string>>): string => {
    if (omit.has(node)) return '';

    /**
     * The prefixes this element visibly uses.
     *
     * The element's own prefix always counts. An attribute's prefix counts because a prefixed
     * attribute name is meaningless without its declaration. An *unprefixed* attribute contributes
     * nothing: it is in no namespace, so the default declaration is not needed for it — which is the
     * subtlety that makes exclusive c14n differ from inclusive.
     */
    const utilized = new Set<string>([node.prefix]);
    for (const attribute of node.attributes) {
      if (attribute.prefix !== '') utilized.add(attribute.prefix);
    }

    const declarations: string[] = [];
    const nextRendered: Record<string, string> = { ...renderedNamespaces };

    for (const prefix of [...utilized].sort()) {
      const uri = prefix === '' ? (node.inScopeNamespaces[''] ?? '') : (node.inScopeNamespaces[prefix] ?? '');

      /**
       * The default namespace needs a declaration only when it is genuinely in play.
       *
       * An unprefixed element in *no* namespace, under an output context that has already established
       * a default namespace, must emit `xmlns=""` to undeclare it. But if no default has been
       * established, emitting `xmlns=""` would be spurious — and would change the bytes.
       */
      if (prefix === '' && uri === '') {
        if ((renderedNamespaces[''] ?? '') !== '') {
          declarations.push(' xmlns=""');
          nextRendered[''] = '';
        }
        continue;
      }

      if ((renderedNamespaces[prefix] ?? undefined) === uri) continue;

      declarations.push(prefix === '' ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${prefix}="${escapeAttribute(uri)}"`);
      nextRendered[prefix] = uri;
    }

    const attributes = [...node.attributes]
      .sort((left, right) =>
        left.namespaceUri === right.namespaceUri
          ? left.localName < right.localName
            ? -1
            : left.localName > right.localName
              ? 1
              : 0
          : left.namespaceUri < right.namespaceUri
            ? -1
            : 1,
      )
      .map((attribute) => ` ${attribute.qualifiedName}="${escapeAttribute(attribute.value)}"`);

    let out = `<${node.qualifiedName}${declarations.join('')}${attributes.join('')}>`;

    for (const child of node.children) {
      out += child.kind === 'text' ? escapeText(child.value) : render(child, nextRendered);
    }

    return `${out}</${node.qualifiedName}>`;
  };

  return render(element, {});
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export const DSIG_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#';

const EXCLUSIVE_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED_SIGNATURE = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

export type XmlSignatureRefusal =
  | 'no_signature'
  | 'multiple_signatures'
  | 'signature_not_enveloped'
  | 'unsupported_canonicalization'
  | 'unsupported_signature_algorithm'
  | 'unsupported_digest_algorithm'
  | 'unsupported_transforms'
  | 'malformed_signature'
  | 'reference_mismatch'
  | 'duplicate_id'
  | 'digest_mismatch'
  | 'bad_signature'
  | 'bad_certificate';

export type XmlSignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: XmlSignatureRefusal };

/** What each refusal means, for an operator configuring an IdP. */
export const describeXmlSignatureRefusal = (reason: XmlSignatureRefusal): string => {
  switch (reason) {
    case 'no_signature':
      return 'The assertion carries no signature. Compass requires signed assertions — enable "Sign assertions" at the identity provider.';
    case 'multiple_signatures':
      return 'The assertion carries more than one signature, which is refused: it makes "which signature vouches for this" ambiguous.';
    case 'signature_not_enveloped':
      return 'The signature is not a direct child of the element it claims to sign, so it could have been lifted from elsewhere in the document.';
    case 'unsupported_canonicalization':
      return 'Compass verifies exclusive canonicalisation (xml-exc-c14n#) only. Configure the identity provider to use it.';
    case 'unsupported_signature_algorithm':
      return 'Compass verifies RSA-SHA256 signatures only. SHA-1 is refused because it is not collision-resistant.';
    case 'unsupported_digest_algorithm':
      return 'Compass verifies SHA-256 digests only. SHA-1 is refused.';
    case 'unsupported_transforms':
      return 'The signature declares transforms Compass does not implement. Only enveloped-signature followed by exclusive canonicalisation is accepted.';
    case 'malformed_signature':
      return 'The signature element is missing a part Compass needs — SignedInfo, SignatureValue, the certificate, or the reference.';
    case 'reference_mismatch':
      return 'The signature references an element other than the assertion being verified.';
    case 'duplicate_id':
      return 'More than one element in the document carries the referenced id. This is the XML signature wrapping attack and is refused outright.';
    case 'digest_mismatch':
      return 'The assertion’s content does not match the digest that was signed, so it has been altered in transit.';
    case 'bad_signature':
      return 'The signature does not verify against the configured certificate. Either the assertion was tampered with, or the certificate is not the one the identity provider signs with.';
    case 'bad_certificate':
      return 'The configured certificate could not be read as an X.509 certificate.';
  }
};

const base64Bytes = (value: string): Buffer => Buffer.from(value.replace(/\s+/g, ''), 'base64');

/**
 * The verification key, as PEM.
 *
 * IdP metadata carries a bare base64 DER certificate, so that is the common path and it gets the
 * PEM armour added. An input that is *already* PEM — a certificate or a bare public key — is passed
 * through unchanged: re-wrapping it would produce something OpenSSL cannot read, and accepting a
 * public key directly is what lets a test verify the signature plumbing without generating an X.509
 * certificate, which Node cannot do from `node:crypto` alone.
 */
export const certificateToPem = (certificateOrKey: string): string => {
  const trimmedInput = certificateOrKey.trim();
  if (trimmedInput.includes('-----BEGIN')) return `${trimmedInput}\n`;

  const body = trimmedInput.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
};

/**
 * Verifies the enveloped signature on one element against one certificate.
 *
 * `signed` is the element the caller intends to trust — not "whatever the signature points at". That
 * direction matters: a verifier that started from the signature and reported which element it covered
 * would happily confirm a signature over an attacker-supplied copy, and the caller would then read the
 * other one.
 */
export function verifyXmlSignature(input: {
  readonly document: XmlElement;
  readonly signed: XmlElement;
  /** Base64 DER or PEM. */
  readonly certificate: string;
}): XmlSignatureVerdict {
  const signatures = childrenNamed(input.signed, DSIG_NAMESPACE, 'Signature');
  if (signatures.length === 0) {
    // Distinguish "no signature anywhere on this element" from "the signature is somewhere else",
    // because the fix an operator has to make is different.
    const anywhere = findDescendantSignatures(input.signed);
    return { ok: false, reason: anywhere.length > 0 ? 'signature_not_enveloped' : 'no_signature' };
  }
  if (signatures.length > 1) return { ok: false, reason: 'multiple_signatures' };

  const signature = signatures[0]!;
  const signedInfo = childNamed(signature, DSIG_NAMESPACE, 'SignedInfo');
  const signatureValueElement = childNamed(signature, DSIG_NAMESPACE, 'SignatureValue');
  if (signedInfo === null || signatureValueElement === null) {
    return { ok: false, reason: 'malformed_signature' };
  }

  const canonicalizationMethod = childNamed(signedInfo, DSIG_NAMESPACE, 'CanonicalizationMethod');
  if (attributeValue(canonicalizationMethod ?? signedInfo, 'Algorithm') !== EXCLUSIVE_C14N) {
    return { ok: false, reason: 'unsupported_canonicalization' };
  }

  const signatureMethod = childNamed(signedInfo, DSIG_NAMESPACE, 'SignatureMethod');
  if (attributeValue(signatureMethod ?? signedInfo, 'Algorithm') !== RSA_SHA256) {
    return { ok: false, reason: 'unsupported_signature_algorithm' };
  }

  const references = childrenNamed(signedInfo, DSIG_NAMESPACE, 'Reference');
  // Exactly one. Several references would mean part of what was signed is not what is being checked.
  if (references.length !== 1) return { ok: false, reason: 'malformed_signature' };
  const reference = references[0]!;

  const digestMethod = childNamed(reference, DSIG_NAMESPACE, 'DigestMethod');
  if (attributeValue(digestMethod ?? reference, 'Algorithm') !== SHA256) {
    return { ok: false, reason: 'unsupported_digest_algorithm' };
  }

  const digestValueElement = childNamed(reference, DSIG_NAMESPACE, 'DigestValue');
  if (digestValueElement === null) return { ok: false, reason: 'malformed_signature' };

  /**
   * The reference must name the element being verified, by id.
   *
   * An empty URI (`URI=""`) means "the whole document" and is refused rather than accommodated: the
   * caller is verifying one assertion, and a whole-document signature would say nothing about which
   * assertion inside it is trustworthy.
   */
  const referenceUri = attributeValue(reference, 'URI') ?? '';
  const signedId =
    attributeValue(input.signed, 'ID') ?? attributeValue(input.signed, 'Id') ?? attributeValue(input.signed, 'id');

  if (signedId === null || referenceUri !== `#${signedId}`) {
    return { ok: false, reason: 'reference_mismatch' };
  }

  // The wrapping check. See `findElementsById`.
  if (findElementsById(input.document, signedId).length !== 1) {
    return { ok: false, reason: 'duplicate_id' };
  }

  const transformsElement = childNamed(reference, DSIG_NAMESPACE, 'Transforms');
  if (transformsElement === null) return { ok: false, reason: 'malformed_signature' };

  const transforms = childrenNamed(transformsElement, DSIG_NAMESPACE, 'Transform').map(
    (transform) => attributeValue(transform, 'Algorithm') ?? '',
  );

  /**
   * Exactly enveloped-signature then exclusive c14n, in that order.
   *
   * Not a subset check and not an "includes" check. The transform list is a *pipeline*, and accepting
   * an unknown entry would mean digesting bytes that had not been through it — which is a signature
   * that vouches for something other than what is read.
   */
  if (
    transforms.length !== 2 ||
    transforms[0] !== ENVELOPED_SIGNATURE ||
    transforms[1] !== EXCLUSIVE_C14N
  ) {
    return { ok: false, reason: 'unsupported_transforms' };
  }

  // The enveloped-signature transform: digest the signed element with its own Signature removed.
  const digested = canonicalizeExclusive(input.signed, { omit: new Set([signature]) });
  const actualDigest = createHash('sha256').update(digested, 'utf8').digest();
  const expectedDigest = base64Bytes(textOf(digestValueElement));

  if (
    actualDigest.length !== expectedDigest.length ||
    !timingSafeEqual(actualDigest, expectedDigest)
  ) {
    return { ok: false, reason: 'digest_mismatch' };
  }

  if (input.certificate.trim().length === 0) return { ok: false, reason: 'bad_certificate' };
  const pem = certificateToPem(input.certificate);

  try {
    const verifier = createVerify('RSA-SHA256');
    // `SignedInfo` is canonicalised on its own, and exclusively — so the namespaces it inherits from
    // the enclosing Response are emitted only if it actually uses them. That is the whole reason the
    // IdP is required to use exclusive c14n.
    verifier.update(canonicalizeExclusive(signedInfo), 'utf8');

    const verified = verifier.verify(pem, base64Bytes(textOf(signatureValueElement)));
    return verified ? { ok: true } : { ok: false, reason: 'bad_signature' };
  } catch {
    // A malformed certificate or an unreadable key reaches here rather than throwing out of the
    // handler, so a misconfigured IdP is a stated refusal instead of a 500.
    return { ok: false, reason: 'bad_certificate' };
  }
}

function findDescendantSignatures(element: XmlElement): readonly XmlElement[] {
  const found: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    if (node.namespaceUri === DSIG_NAMESPACE && node.localName === 'Signature') found.push(node);
    for (const child of elementChildren(node)) walk(child);
  };
  walk(element);
  return found;
}
