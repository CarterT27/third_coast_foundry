// Cloudflare's free plan allows 50 subrequests (outgoing fetches) per incoming request; past
// that every fetch fails, including the database writes that save a run's work. Every fetch
// in the Worker spends from a budget carried on `env`, so a run can stop searching or scoring
// early and still save and return what it has.
import type { Env } from "../env";

export const MAX_SUBREQUESTS = 50;

type Budget = { used: number; limit: number; parent?: Budget };

const BUDGET = Symbol("subrequests");
type Budgeted = Env & { [BUDGET]?: Budget };

export class SubrequestLimitError extends Error {
  override name = "SubrequestLimitError";
}

/**
 * A copy of `env` whose fetches may use at most `limit` subrequests. Nests inside any budget
 * `env` already has: spending counts against both.
 */
export function withSubrequestLimit(env: Env, limit: number): Env {
  const budgeted: Budgeted = { ...env, [BUDGET]: { used: 0, limit, parent: (env as Budgeted)[BUDGET] } };
  return budgeted;
}

/** Subrequests `env` may still make (Infinity without a budget, e.g. in tests). */
export function subrequestsLeft(env: Env): number {
  let left = Infinity;
  for (let b = (env as Budgeted)[BUDGET]; b; b = b.parent) left = Math.min(left, b.limit - b.used);
  return left;
}

/** Call right before each fetch. Throws SubrequestLimitError instead of going over the limit. */
export function spendSubrequest(env: Env): void {
  if (subrequestsLeft(env) <= 0) throw new SubrequestLimitError("Out of subrequests for this request");
  for (let b = (env as Budgeted)[BUDGET]; b; b = b.parent) b.used++;
}
