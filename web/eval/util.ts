import * as fs from 'fs';
import * as path from 'path';

/** lowercase, drop punctuation, collapse whitespace — "Northwind Analytics Inc." → "northwind analytics inc" */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Fuzzy name match. Exact match after normalisation, or containment when the
 * shorter side is >= 4 chars ("Brightpath Consulting" ~ "Brightpath Consulting LLC").
 * Exact string match is far too strict for LLM output.
 */
export function fuzzyMatch(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short);
}

export function prf(truePos: number, falsePos: number, falseNeg: number) {
  const precision = truePos + falsePos ? truePos / (truePos + falsePos) : 0;
  const recall = truePos + falseNeg ? truePos / (truePos + falseNeg) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision: round(precision), recall: round(recall), f1: round(f1) };
}

export const round = (n: number) => Math.round(n * 1000) / 1000;
export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Writes eval/results/<prefix>-<ISO timestamp>.json and returns the path. */
export function writeReport(prefix: string, report: unknown): string {
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${prefix}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

/**
 * Heuristic instruction-injection sniffer for extracted graph text.
 * Deliberately a WARNING signal, not a hard failure — a real document about
 * prompt security would legitimately contain these words.
 */
export const INJECTION_MARKERS = [
  'ignore previous', 'ignore all', 'disregard', 'system prompt', 'your instructions',
  'you are now', 'jailbreak', 'developer mode', 'reveal your', 'override',
  'do not extract', 'instead output', 'new instructions', 'as an ai',
];

export function sniffInjection(text: string): string[] {
  const t = norm(text);
  return INJECTION_MARKERS.filter((m) => t.includes(norm(m)));
}
