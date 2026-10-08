import { METRIC_KEYS, type Metrics, type Stat } from '../contracts';
import { METRIC_LABELS } from '../engine/metrics';

export function downloadText(filename: string, text: string, mime = 'text/csv') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  downloadBlob(filename, blob);
}
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: (string | number)[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

export const fmtMetric = (key: keyof Metrics, v: number): string => v.toFixed(METRIC_LABELS[key].digits);
export const fmtStat = (key: keyof Metrics, s: Stat): string => `${fmtMetric(key, s.mean)} ± ${fmtMetric(key, s.ci)}`;

export const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const KEYS = METRIC_KEYS;

export function isGood(key: keyof Metrics, delta: number): boolean {
  return METRIC_LABELS[key].better === 'lower' ? delta < 0 : delta > 0;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
