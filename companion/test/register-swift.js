import { register } from 'node:module';

// Tests import the Swift helper as text. esbuild does that for the bundle;
// this hook does it for `node --test` running the TypeScript sources.
await register('./swift-loader.js', import.meta.url);
