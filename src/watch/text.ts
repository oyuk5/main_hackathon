const DEFAULT_MAX_REASON_LENGTH = 240;

const RAW_ERROR_PATTERNS: readonly RegExp[] = [
  /^\s*at\s+\S+/m,
  /\s+at\s+\S+:\d+:\d+/,
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|ZodError|AggregateError|Error):/,
  /\b(?:page|locator|frame|browser|context)\.[a-zA-Z]+\s*:/,
  /timeout\s+\d+\s*ms\s+exceeded/i,
  /\b(?:ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOENT|net::ERR_)\b/i,
  /\b(?:Cannot read propert|Cannot set propert|is not a function|is not defined|is not valid JSON)\b/i,
  /(?:[A-Za-z]:\\|\/(?:src|app|usr|home|var|tmp)\/)\S+/,
  /\bgolden\s+mismatch\b/i,
  /\bsnapshot\s+status\b/i,
  /\brepair\s+model\s+error\b/i,
  /\bfresh\s+attach\s+failed\b/i,
];

/** Capitalizes the first character of a non-empty string. */
export function capitalize(text: string): string {
  if (text.length === 0) return text;
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** Formats a count with proper singular or plural noun phrasing. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Normalizes a string into a single clean sentence ending with punctuation. */
export function formatSingleSentence(text: string, fallback = "", maxLength?: number): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^\s*at\s+/.test(line));
  if (!firstLine) return fallback;

  let normalized = firstLine.replace(/\s+/g, " ").trim().replace(/[:;]+$/, "");
  if (normalized.length === 0) return fallback;

  if (maxLength !== undefined && normalized.length > maxLength) {
    normalized = `${normalized.slice(0, maxLength - 1).replace(/\s+\S*$/, "")}…`;
  }

  const ended = /[.!?…]$/.test(normalized) ? normalized : `${normalized}.`;
  return capitalize(ended);
}

/**
 * Ensures an operator-facing reason is one plain-English sentence without raw
 * JS errors, stack traces, file paths, or internal jargon.
 */
export function sanitizeOperatorReason(
  raw: string,
  fallback: string,
  maxLength = DEFAULT_MAX_REASON_LENGTH,
): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  if (RAW_ERROR_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return fallback;
  }
  return formatSingleSentence(trimmed, fallback, maxLength);
}
