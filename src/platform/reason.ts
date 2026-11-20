/**
 * Reason strings. Owned by A. Every `reason` the API shows is plain sentences an operator
 * understands at 8 a.m.: one line, no stack traces, ends with a full stop, no doubled labels
 * like "Blocked: Blocked by a captcha".
 */

const MAX = 240;

/** One clean sentence: first non-empty line, single spaces, capped, ending in . ! or ? */
export function sentence(text: string, max = MAX): string {
  const line = (text ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  let s = line.replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return /[.!?…]$/.test(s) ? s : s + ".";
}

/** Joins sentences with single spaces, skipping empty parts. */
export function join(...parts: (string | null | undefined)[]): string {
  return parts.map((p) => sentence(p ?? "")).filter(Boolean).join(" ");
}

/**
 * "Label: reason." unless the reason already opens with the label's words,
 * so C's "Blocked by a captcha …" does not become "Blocked: Blocked by a captcha …".
 */
export function labelled(label: string, reason: string): string {
  const body = sentence(reason);
  if (!body) return sentence(label);
  const key = label.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const head = body.toLowerCase();
  if (head.startsWith(key) || head.startsWith(key.split(" ")[0]!)) return body;
  return `${label}: ${body}`;
}

/** "1 open tender", "23 open tenders". */
export function count(n: number, singular: string, plural = singular + "s"): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
