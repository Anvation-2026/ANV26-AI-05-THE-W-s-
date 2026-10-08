import type { Point } from '../contracts';

export type Mat3 = number[]; // row-major, 9 numbers

/** Solve A x = b by Gaussian elimination with partial pivoting. Returns null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-10) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Four-point homography that maps src[i] to dst[i]. */
export function homographyFromQuad(src: Point[], dst: Point[]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  if (!h) return null;
  return [...h, 1];
}

export function applyH(H: Mat3, p: Point): Point {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

export function invertH(H: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H2 = -(a * f - c * d);
  const I = a * e - b * d;
  return [A / det, D / det, G / det, B / det, E / det, H2 / det, C / det, F / det, I / det];
}

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Area of a polygon by the shoelace formula. */
export function polyArea(p: Point[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** True if any three of the points are nearly in a straight line. */
export function nearlyCollinear(p: Point[]): boolean {
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      for (let k = j + 1; k < p.length; k++) {
        const a = p[i],
          b = p[j],
          c = p[k];
        const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
        const longest = Math.max(dist(a, b), dist(b, c), dist(a, c));
        if (longest > 0 && cross / (longest * longest) < 0.02) return true;
      }
    }
  }
  return false;
}

export interface CalibrationFit {
  H: Mat3;
  width: number; // metres
  height: number;
  rms: number; // metres, how far the typed distances are from the fitted rectangle
  mismatch: number; // largest relative difference between opposite sides
}

/** Fit a metric rectangle to four pixel points and four typed side lengths (p0p1, p1p2, p2p3, p3p0). */
export function fitCalibration(points: Point[], d: number[]): CalibrationFit | null {
  if (points.length !== 4 || d.length !== 4 || d.some((x) => !(x > 0))) return null;
  const width = (d[0] + d[2]) / 2;
  const height = (d[1] + d[3]) / 2;
  const H = homographyFromQuad(points, [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]);
  if (!H) return null;
  const fitted = [width, height, width, height];
  const rms = Math.sqrt(d.reduce((s, v, i) => s + (v - fitted[i]) ** 2, 0) / 4);
  const mismatch = Math.max(Math.abs(d[0] - d[2]) / Math.max(d[0], d[2]), Math.abs(d[1] - d[3]) / Math.max(d[1], d[3]));
  return { H, width, height, rms, mismatch };
}

/** Metres per pixel near a point, from the local Jacobian of the homography. */
export function metresPerPixel(H: Mat3, at: Point): number {
  const o = applyH(H, at);
  const px = applyH(H, { x: at.x + 1, y: at.y });
  const py = applyH(H, { x: at.x, y: at.y + 1 });
  return (dist(o, px) + dist(o, py)) / 2;
}
