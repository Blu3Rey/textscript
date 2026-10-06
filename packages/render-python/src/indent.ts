/** One level of Python indentation (PEP 8: four spaces). */
export const INDENT_UNIT = '    ';

/**
 * Prefixes each line with `depth` levels of indentation.
 *
 * Empty lines stay empty so rendered code never has trailing whitespace.
 */
export function indentLines(lines: readonly string[], depth: number): string[] {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new RangeError(`depth must be a non-negative integer, got ${String(depth)}`);
  }
  const prefix = INDENT_UNIT.repeat(depth);
  return lines.map((line) => (line === '' ? line : prefix + line));
}
