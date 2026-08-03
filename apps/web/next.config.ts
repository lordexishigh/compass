import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship as ESM with type declarations; Next consumes them
  // directly from their built `dist`, so `pnpm build` builds packages first.
  //
  // Nothing is listed in `serverExternalPackages`, and that is a deliberate outcome
  // rather than an omission: Argon2id comes from `hash-wasm`, which inlines its
  // WebAssembly and therefore bundles like any other JavaScript. A native binding needed
  // an entry here *and* still failed, because its binary lives in a separate
  // per-platform package the externals list does not name. See
  // `packages/auth/src/password.ts` for the whole of that reasoning.
  //
  // ## There is deliberately no `headers()` here
  //
  // Three static headers used to be set from this file. They now come from
  // `middleware.ts` along with the CSP, and this comment is the record of why the move
  // was necessary rather than tidy.
  //
  // A strict CSP needs a per-response nonce. `headers()` is evaluated once, at build
  // time, and cannot vary per response — so the CSP has to come from middleware. And a
  // header declared in *both* places is emitted twice: browsers then intersect the two
  // policies, which is the strictest possible reading of a mistake, and any assertion
  // that a header equals its documented value fails against a joined string.
  //
  // So middleware owns all six, `apps/web/lib/security-headers.ts` is the single source
  // of their values, and `tests/security-headers.test.ts` asserts this file declares no
  // `headers()` at all — the comment is not what keeps the ownership single.
};

export default config;
