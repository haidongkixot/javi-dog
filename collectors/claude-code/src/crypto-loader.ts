// JD-M11 is loaded only when a project has a recovery key or `init --privacy` runs, so hooks of
// L0 projects (most of them) do not pay for resolving and type-stripping it at start-up when
// javi runs from a checkout. scripts/build.mjs swaps this file for crypto-loader.bundle.ts: in
// the single-file bundle a static import costs nothing extra, while a dynamic one would make
// esbuild wrap every shared dependency (zod included) in lazy initialisers.
export const loadCrypto = () => import('@javis-dog/crypto');
