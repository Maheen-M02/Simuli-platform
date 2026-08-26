/**
 * Redaction of secret values.
 *
 * This runs on write, not as a post-hoc cleanup pass. A secret that reaches a
 * log file or a session record has already leaked; sweeping it up afterwards
 * does not un-leak it. Every path that persists or displays text derived from
 * the page goes through here first.
 *
 * The values themselves never enter prompts or model output by construction —
 * actions reference credentials by name. This is the second line: a page can
 * echo a submitted value straight back into its own HTML.
 */

export type Redactor = (text: string) => string;

/** Below this length a "secret" would match everywhere and destroy the text. */
const MIN_REDACTABLE_LENGTH = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a redactor over the configured credentials. Longest values are
 * replaced first, so a secret that contains another secret does not leave a
 * fragment of the longer one behind.
 */
export function createRedactor(secrets: ReadonlyMap<string, string>): Redactor {
  const entries = [...secrets.entries()]
    .filter(([, value]) => value.length >= MIN_REDACTABLE_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);

  if (entries.length === 0) return (text) => text;

  const patterns = entries.map(
    ([name, value]) => [new RegExp(escapeRegExp(value), 'g'), `[REDACTED:${name}]`] as const,
  );

  return (text: string): string => {
    let output = text;
    for (const [pattern, replacement] of patterns) output = output.replace(pattern, replacement);
    return output;
  };
}

/** Applies a redactor across a whole JSON-shaped value, keys included. */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[redact(key)] = redactDeep(item, redact);
    return output as T;
  }
  return value;
}
