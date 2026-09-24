// Errors whose message is written for the person using the app. index.ts shows these as-is
// and replaces every other error (provider bodies, db errors, validation dumps) with a
// generic message, so internals never reach the page.

export class PublicError extends Error {
  override name = "PublicError";
}
