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
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
