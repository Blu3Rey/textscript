// Test helpers shared with other packages as `@textscript/core/testing`.
// Test-only: it imports fast-check, which is a dev dependency.

export { at, kitchenSink, said, workedExample } from './fixtures';
export * as arbitraries from './arbitraries';
