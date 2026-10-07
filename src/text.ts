/** Lower-case kebab id: "Fix README links!" -> "fix-readme-links". */
export function slug(text: string, maxLength = 48): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "");
}

/**
 * Makes two failures comparable: drops ANSI colors, numbers (timings, line
 * numbers, pids) and whitespace differences.
 */
export function normalizeError(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars)}`;
}

export function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}
