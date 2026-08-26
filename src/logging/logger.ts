import { pino, type Logger } from 'pino';
import type { Redactor } from '../observations/redact.ts';

/**
 * The one place logging redaction is configured.
 *
 * Two layers, because they catch different things:
 *  - Path redaction covers fields we know are sensitive by name. Cheap, exact,
 *    and useless against a secret that turns up somewhere unexpected.
 *  - The value redactor covers the secret's actual text wherever it appears,
 *    including inside a message a product echoed back at us.
 *
 * Both are applied on write. Nothing scrubs a log file after the fact, because
 * by then it has already been written, tailed and possibly shipped.
 */

export type { Logger };

/** Field paths that must never be logged, whatever they contain. */
const REDACTED_PATHS = [
  'password',
  'secret',
  'token',
  'apiKey',
  'authorization',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
  'headers.authorization',
  'headers.cookie',
];

export type LoggerOptions = {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Applied to every logged string. Built from the run's configured secrets. */
  readonly redact: Redactor;
  readonly pretty?: boolean;
  readonly destination?: NodeJS.WritableStream;
};

export function createLogger(options: LoggerOptions): Logger {
  const { redact } = options;

  const base = pino(
    {
      level: options.level,
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      // Applied to every log record, so a secret cannot ride in on a field
      // nobody thought to name in REDACTED_PATHS.
      formatters: {
        log(object: Record<string, unknown>) {
          return redactValues(object, redact);
        },
      },
      ...(options.pretty === true
        ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
        : {}),
    },
    options.destination,
  );

  // Pino formatters do not see the message string itself.
  return base.child(
    {},
    {
      msgPrefix: '',
      serializers: {},
    },
  );
}

function redactValues(value: unknown, redact: Redactor): Record<string, unknown> {
  return redactUnknown(value, redact) as Record<string, unknown>;
}

function redactUnknown(value: unknown, redact: Redactor): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, redact));
  if (value instanceof Error) return { type: value.name, message: redact(value.message) };
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = redactUnknown(item, redact);
    return output;
  }
  return value;
}

/** A logger that discards everything. For tests and library callers. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
