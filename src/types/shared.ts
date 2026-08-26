/**
 * Types shared across module boundaries.
 *
 * Errors are values at module boundaries and exceptions inside, so `Result` is
 * the shape crossing every seam in this codebase.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * The set of ways an action can fail. Closed by design: the executor never lets
 * a raw exception escape, so every failure has to land in one of these buckets
 * and stays classifiable by the deterministic evaluator pass.
 */
export const ERROR_KINDS = [
  /** The snapshot the action referred to has been superseded. */
  'STALE_SNAPSHOT',
  /** No element carries that ref in the current snapshot. */
  'REF_NOT_FOUND',
  /** The ref resolved to more than one element. We refuse to guess. */
  'REF_AMBIGUOUS',
  /** Found, but not visible/enabled/stable enough to act on. */
  'ELEMENT_NOT_ACTIONABLE',
  /** The action is not meaningful for that element (e.g. select on a button). */
  'WRONG_ELEMENT_TYPE',
  /** Playwright timed out waiting for the operation. */
  'TIMEOUT',
  /** Navigation was attempted outside the origin allowlist. */
  'NAVIGATION_BLOCKED',
  /** The executor's destructive-action denylist refused it. */
  'ACTION_BLOCKED',
  /** An action referenced a secret that is not configured. */
  'SECRET_NOT_FOUND',
  /** There was nowhere to go back to. */
  'NO_HISTORY',
  /** The page or context died underneath us. */
  'BROWSER_CRASHED',
  /** Anything genuinely unexpected. Should stay rare; investigate when seen. */
  'UNKNOWN',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export type ActionError = {
  readonly kind: ErrorKind;
  /** Safe to show a model and to persist: never contains secret values. */
  readonly message: string;
};

/**
 * The outcome of one attempted action. Every Playwright operation returns one
 * of these; no raw exception escapes the executor, so the loop and the
 * evaluator never have to reason about stack traces.
 */
export type ActionResult = {
  readonly ok: boolean;
  /** Present exactly when `ok` is false. */
  readonly error?: ActionError;
  readonly durationMs: number;
  /** True when the action caused a top-level navigation. */
  readonly navigated: boolean;
  /** How the target was found, when the action had one. */
  readonly resolvedVia?: 'ref' | 'role-name';
};
