/** Normalize common spelling variants; never infer a charge from unrelated numbers. */
export function normalizeChargeReferences(input: string): string {
  return input
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\bCH\s*-?\s*(\d+)\b/gi, (_match, digits: string) => `CH-${digits}`);
}
export function extractCharges(input: string): string[] {
  return [...new Set(normalizeChargeReferences(input).match(/\bCH-\d+\b/gi) ?? [])];
}
