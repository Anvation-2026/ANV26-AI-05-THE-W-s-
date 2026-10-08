import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { scaleLinear } from 'd3-scale';
import { line as d3line, curveStepAfter, curveLinear, area as d3area } from 'd3-shape';
import { Check } from './ui';

export type Tone = 'old' | 'new' | 'ink';
const toneVar: Record<Tone, string> = { old: 'var(--series-old)', new: 'var(--series-new)', ink: 'var(--ink)' };

export interface Series {
  id: string;
  label: string;
  data: [number, number][];
  tone: Tone;
  dash?: string;
  width?: number;
  step?: boolean;
  band?: [number, number, number][];
}

function useSize(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(480);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(220, Math.floor(el.getBoundingClientRect().width))));
    ro.observe(el);
    setW(Math.max(220, Math.floor(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function PatternDefs() {
  const c = 'var(--sign)';
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <pattern id="pat-0" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill={c} />
        </pattern>
        <pattern id="pat-1" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--surface)" />
          <rect width="3" height="6" fill={c} />
        </pattern>
        <pattern id="pat-2" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="var(--surface)" />
          <rect width="6" height="3" fill={c} />
        </pattern>
        <pattern id="pat-3" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="var(--surface)" />
          <rect width="3" height="6" fill={c} />
          <rect width="6" height="3" fill={c} />
        </pattern>
        <pattern id="pat-4" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="var(--surface)" />
          <rect x="0" width="2" height="6" fill={c} />
        </pattern>
      </defs>
    </svg>
  );
}
export const patFill = (i: number) => `url(#pat-${i % 5})`;

export function ChartFrame({
  title,
  children,
  table,
  legend,
  actions,
}: {
  title: string;
  children: ReactNode;
  table?: { columns: string[]; rows: (string | number)[][] };
  legend?: ReactNode;
  actions?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="chart-frame" style={{ margin: 0 }}>
      <div className="row-between" style={{ marginBottom: 8 }}>
        <figcaption style={{ fontWeight: 700 }}>{title}</figcaption>
        <div className="row">
          {actions}
          {table && <Check label="View as table" checked={asTable} onChange={setAsTable} />}
        </div>
      </div>
      {asTable && table ? (
        <div className="table-wrap" style={{ maxHeight: 260 }} tabIndex={0} role="region" aria-label={`${title}, table view`}>
          <table className="table">
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c} className={c === table.columns[0] ? '' : 'num'}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={j === 0 ? '' : 'num'}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
      {legend}
    </figure>
  );
}

export function Legend({ items }: { items: { label: string; tone?: Tone; dash?: string; pattern?: number }[] }) {
  return (
    <ul className="legend">
      {items.map((it) => (
        <li key={it.label}>
          <svg width="28" height="10" aria-hidden="true">
            {it.pattern !== undefined ? (
              <rect width="28" height="10" fill={patFill(it.pattern)} stroke="var(--sign)" />
            ) : (
              <line x1="0" y1="5" x2="28" y2="5" stroke={toneVar[it.tone ?? 'ink']} strokeWidth="2.5" strokeDasharray={it.dash} />
            )}
          </svg>
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export interface LineChartProps {
  title: string;
  series: Series[];
  height?: number;
  xLabel: string;
  yLabel: string;
  xDomain?: [number, number];
  yDomain?: [number, number];
  xFormat?: (n: number) => string;
  yFormat?: (n: number) => string;
  refLines?: { y: number; label: string }[];
  vlines?: { x: number; label?: string }[];
  cursor?: number | null;
  onHoverX?: (x: number | null) => void;
  unit?: string;
  actions?: ReactNode;
}

const M = { l: 52, r: 16, t: 12, b: 38 };

export function LineChart(p: LineChartProps) {
  const [ref, width] = useSize();
  const height = p.height ?? 220;
  const [hover, setHover] = useState<{ x: number; px: number } | null>(null);
  const iw = Math.max(10, width - M.l - M.r);
  const ih = height - M.t - M.b;

  const { xs, ys } = useMemo(() => {
    let xmin = Infinity,
      xmax = -Infinity,
      ymin = 0,
      ymax = -Infinity;
    for (const s of p.series) {
      for (const [x, y] of s.data) {
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
        if (y > ymax) ymax = y;
        if (y < ymin) ymin = y;
      }
      s.band?.forEach(([x, , hi]) => {
        if (hi > ymax) ymax = hi;
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
      });
    }
    for (const r of p.refLines ?? []) ymax = Math.max(ymax, r.y * 1.05);
    if (!isFinite(xmin)) {
      xmin = 0;
      xmax = 1;
    }
    if (!isFinite(ymax) || ymax <= ymin) ymax = ymin + 1;
    const xd = p.xDomain ?? [xmin, xmax === xmin ? xmin + 1 : xmax];
    const yd = p.yDomain ?? [ymin, ymax * 1.08];
    return { xs: scaleLinear().domain(xd).range([0, iw]), ys: scaleLinear().domain(yd).range([ih, 0]).nice() };
  }, [p.series, p.xDomain, p.yDomain, p.refLines, iw, ih]);

  const fx = p.xFormat ?? ((n: number) => String(Math.round(n * 100) / 100));
  const fy = p.yFormat ?? ((n: number) => String(Math.round(n * 100) / 100));

  const nearest = (s: Series, x: number): [number, number] | null => {
    if (!s.data.length) return null;
    let lo = 0,
      hi = s.data.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.data[mid][0] < x) lo = mid + 1;
      else hi = mid;
    }
    const a = s.data[Math.max(0, lo - 1)];
    const b = s.data[lo];
    return Math.abs(a[0] - x) <= Math.abs(b[0] - x) ? a : b;
  };

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    const x = xs.invert(Math.max(0, Math.min(iw, px)));
    setHover({ x, px: e.clientX });
    p.onHoverX?.(x);
  };

  const tableRows = useMemo(() => {
    const base = p.series[0]?.data ?? [];
    const step = Math.max(1, Math.floor(base.length / 60));
    const rows: (string | number)[][] = [];
    for (let i = 0; i < base.length; i += step) {
      const x = base[i][0];
      rows.push([fx(x), ...p.series.map((s) => fy(nearest(s, x)?.[1] ?? 0))]);
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.series]);

  const ticksX = xs.ticks(Math.max(2, Math.floor(iw / 90)));
  const ticksY = ys.ticks(5);

  return (
    <ChartFrame
      title={p.title}
      table={{ columns: [p.xLabel, ...p.series.map((s) => s.label)], rows: tableRows }}
      actions={p.actions}
      legend={<Legend items={p.series.map((s) => ({ label: s.label, tone: s.tone, dash: s.dash }))} />}
    >
      <div ref={ref} style={{ position: 'relative' }}>
        <svg width={width} height={height} role="img" aria-label={`${p.title}. ${p.series.map((s) => s.label).join(', ')}. Use View as table for the values.`}>
          <g transform={`translate(${M.l},${M.t})`}>
            {ticksY.map((t) => (
              <g key={`y${t}`} transform={`translate(0,${ys(t)})`}>
                <line x2={iw} stroke="var(--rule)" strokeWidth="1" />
                <text x={-8} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--ink-muted)" className="tnum">
                  {fy(t)}
                </text>
              </g>
            ))}
            {ticksX.map((t) => (
              <g key={`x${t}`} transform={`translate(${xs(t)},${ih})`}>
                <line y2={5} stroke="var(--ink-muted)" />
                <text y={18} textAnchor="middle" fontSize="11" fill="var(--ink-muted)" className="tnum">
                  {fx(t)}
                </text>
              </g>
            ))}
            <line x1={0} x2={iw} y1={ih} y2={ih} stroke="var(--ink-muted)" />
            <text x={iw / 2} y={ih + 33} textAnchor="middle" fontSize="12" fill="var(--ink-muted)">
              {p.xLabel}
            </text>
            <text transform={`translate(-40,${ih / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="var(--ink-muted)">
              {p.yLabel}
            </text>

            {p.series.map((s) =>
              s.band ? (
                <path
                  key={`${s.id}-band`}
                  d={
                    d3area<[number, number, number]>()
                      .x((d) => xs(d[0]))
                      .y0((d) => ys(d[1]))
                      .y1((d) => ys(d[2]))(s.band) ?? ''
                  }
                  fill={toneVar[s.tone]}
                  opacity="0.18"
                />
              ) : null,
            )}
            {(p.refLines ?? []).map((r) => (
              <g key={r.label}>
                <line x1={0} x2={iw} y1={ys(r.y)} y2={ys(r.y)} stroke="var(--ink)" strokeDasharray="6 4" />
                <text x={iw - 4} y={ys(r.y) - 5} textAnchor="end" fontSize="11" fontWeight="700" fill="var(--ink)">
                  {r.label}
                </text>
              </g>
            ))}
            {(p.vlines ?? []).map((v) => (
              <g key={`v${v.x}`}>
                <line x1={xs(v.x)} x2={xs(v.x)} y1={0} y2={ih} stroke="var(--paint)" strokeWidth="2" />
                {v.label && (
                  <text x={xs(v.x) + 4} y={10} fontSize="11" fill="var(--ink)">
                    {v.label}
                  </text>
                )}
              </g>
            ))}
            {p.series.map((s) => {
              const gen = d3line<[number, number]>()
                .x((d) => xs(d[0]))
                .y((d) => ys(d[1]))
                .curve(s.step ? curveStepAfter : curveLinear);
              const d = gen(s.data) ?? '';
              return (
                <path
                  key={s.id}
                  d={d}
                  fill="none"
                  stroke={toneVar[s.tone]}
                  strokeWidth={s.width ?? 2.5}
                  strokeDasharray={s.dash}
                  className={s.dash ? 'fade-once' : 'draw-once'}
                  pathLength={s.dash ? undefined : 1}
                  strokeLinejoin="miter"
                />
              );
            })}
            {p.series.map((s) => {
              const last = s.data[s.data.length - 1];
              if (!last) return null;
              return (
                <text key={`${s.id}-lbl`} x={Math.min(iw - 2, xs(last[0]) + 4)} y={ys(last[1])} dy="-0.5em" textAnchor={xs(last[0]) > iw - 60 ? 'end' : 'start'} fontSize="11" fontWeight="700" fill={toneVar[s.tone]}>
                  {s.label}
                </text>
              );
            })}
            {p.cursor !== undefined && p.cursor !== null && (
              <line x1={xs(p.cursor)} x2={xs(p.cursor)} y1={0} y2={ih} stroke="var(--ink)" strokeWidth="1.5" />
            )}
            {hover && <line x1={xs(hover.x)} x2={xs(hover.x)} y1={0} y2={ih} stroke="var(--ink-muted)" strokeWidth="1" strokeDasharray="3 3" />}
            <rect
              x={0}
              y={0}
              width={iw}
              height={ih}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => {
                setHover(null);
                p.onHoverX?.(null);
              }}
            />
          </g>
        </svg>
        {hover && (
          <div className="tooltip" style={{ left: hover.px + 12, top: (ref.current?.getBoundingClientRect().top ?? 0) + 24 }}>
            <div>
              {p.xLabel} {fx(hover.x)}
            </div>
            {p.series.map((s) => {
              const n = nearest(s, hover.x);
              return (
                <div key={s.id}>
                  {s.label}: {n ? fy(n[1]) : 'none'}
                  {p.unit ? ` ${p.unit}` : ''}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------- histogram */
export function Histogram({
  title,
  values,
  bins = 12,
  xLabel,
  yLabel = 'Count',
  height = 200,
  mark,
  tone = 'new',
  xFormat,
}: {
  title: string;
  values: number[];
  bins?: number;
  xLabel: string;
  yLabel?: string;
  height?: number;
  mark?: { x: number; label: string };
  tone?: Tone;
  xFormat?: (n: number) => string;
}) {
  const [ref, width] = useSize();
  const iw = Math.max(10, width - M.l - M.r);
  const ih = height - M.t - M.b;
  const data = useMemo(() => {
    if (!values.length) return { bars: [] as { x0: number; x1: number; n: number }[], min: 0, max: 1, maxN: 1 };
    const min = Math.min(...values);
    const max = Math.max(...values, min + 1e-6);
    const w = (max - min) / bins;
    const arr = Array.from({ length: bins }, (_, i) => ({ x0: min + i * w, x1: min + (i + 1) * w, n: 0 }));
    for (const v of values) arr[Math.min(bins - 1, Math.floor((v - min) / w))].n++;
    return { bars: arr, min, max, maxN: Math.max(...arr.map((a) => a.n), 1) };
  }, [values, bins]);
  const xs = scaleLinear().domain([data.min, data.max]).range([0, iw]);
  const ys = scaleLinear().domain([0, data.maxN]).range([ih, 0]).nice();
  const fx = xFormat ?? ((n: number) => (Math.round(n * 100) / 100).toString());
  return (
    <ChartFrame title={title} table={{ columns: [xLabel, yLabel], rows: data.bars.map((b) => [`${fx(b.x0)} to ${fx(b.x1)}`, b.n]) }}>
      <div ref={ref}>
        <svg width={width} height={height} role="img" aria-label={`${title}. Histogram of ${values.length} values. Use View as table for the counts.`}>
          <g transform={`translate(${M.l},${M.t})`}>
            {ys.ticks(4).map((t) => (
              <g key={t} transform={`translate(0,${ys(t)})`}>
                <line x2={iw} stroke="var(--rule)" />
                <text x={-8} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--ink-muted)">
                  {t}
                </text>
              </g>
            ))}
            {data.bars.map((b, i) => (
              <rect key={i} x={xs(b.x0) + 1} y={ys(b.n)} width={Math.max(1, xs(b.x1) - xs(b.x0) - 2)} height={ih - ys(b.n)} fill={toneVar[tone]} />
            ))}
            {xs.ticks(5).map((t) => (
              <text key={t} x={xs(t)} y={ih + 16} textAnchor="middle" fontSize="11" fill="var(--ink-muted)">
                {fx(t)}
              </text>
            ))}
            <line x1={0} x2={iw} y1={ih} y2={ih} stroke="var(--ink-muted)" />
            <text x={iw / 2} y={ih + 33} textAnchor="middle" fontSize="12" fill="var(--ink-muted)">
              {xLabel}
            </text>
            <text transform={`translate(-38,${ih / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="var(--ink-muted)">
              {yLabel}
            </text>
            {mark && (
              <g>
                <line x1={xs(mark.x)} x2={xs(mark.x)} y1={0} y2={ih} stroke="var(--ink)" strokeDasharray="6 4" strokeWidth="2" />
                <text x={xs(mark.x) + 4} y={10} fontSize="11" fontWeight="700" fill="var(--ink)">
                  {mark.label}
                </text>
              </g>
            )}
          </g>
        </svg>
      </div>
    </ChartFrame>
  );
}

/* ------------------------------------------------------- stacked mix bars */
export function MixBars({
  title,
  rows,
  keys,
}: {
  title: string;
  rows: { label: string; parts: number[] }[];
  keys: string[];
}) {
  const [ref, width] = useSize();
  const labelW = 70;
  const barW = Math.max(60, width - labelW - 8);
  return (
    <ChartFrame
      title={title}
      table={{ columns: ['Approach', ...keys], rows: rows.map((r) => [r.label, ...r.parts.map((v) => `${(v * 100).toFixed(1)}%`)]) }}
      legend={<Legend items={keys.map((k, i) => ({ label: k, pattern: i }))} />}
    >
      <div ref={ref}>
        <svg width={width} height={rows.length * 34 + 4} role="img" aria-label={`${title}. Share of each vehicle class per approach. Use View as table for the numbers.`}>
          {rows.map((r, ri) => {
            let x = labelW;
            return (
              <g key={r.label} transform={`translate(0,${ri * 34 + 2})`}>
                <text x={0} y={19} fontSize="13" fontWeight="700" fill="var(--ink)">
                  {r.label}
                </text>
                {r.parts.map((v, i) => {
                  const w = v * barW;
                  const el = (
                    <g key={i}>
                      <rect x={x} y={4} width={Math.max(0, w)} height={24} fill={patFill(i)} stroke="var(--sign)" strokeWidth="1" />
                      {w > 38 && (
                        <text x={x + w / 2} y={20} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--ink)" stroke="var(--surface)" strokeWidth="3" paintOrder="stroke">
                          {Math.round(v * 100)}%
                        </text>
                      )}
                    </g>
                  );
                  x += w;
                  return el;
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </ChartFrame>
  );
}

/* ----------------------------------------------------------- strip plot */
export function StripPlot({
  title,
  groups,
  unit,
  refLine,
  height = 200,
}: {
  title: string;
  groups: { label: string; values: number[]; tone: Tone }[];
  unit: string;
  refLine?: { y: number; label: string };
  height?: number;
}) {
  const [ref, width] = useSize();
  const iw = Math.max(10, width - M.l - M.r);
  const ih = height - M.t - M.b;
  const all = groups.flatMap((g) => g.values);
  const ymax = Math.max(...all, refLine?.y ?? 0, 1) * 1.08;
  const ys = scaleLinear().domain([0, ymax]).range([ih, 0]).nice();
  const band = iw / Math.max(1, groups.length);
  return (
    <ChartFrame
      title={title}
      table={{
        columns: ['Seed', ...groups.map((g) => g.label)],
        rows: Array.from({ length: Math.max(0, ...groups.map((g) => g.values.length)) }, (_, i) => [i + 1, ...groups.map((g) => (g.values[i] ?? 0).toFixed(1))]),
      }}
    >
      <div ref={ref}>
        <svg width={width} height={height} role="img" aria-label={`${title}. One mark per random seed. Use View as table for the values.`}>
          <g transform={`translate(${M.l},${M.t})`}>
            {ys.ticks(5).map((t) => (
              <g key={t} transform={`translate(0,${ys(t)})`}>
                <line x2={iw} stroke="var(--rule)" />
                <text x={-8} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--ink-muted)">
                  {t}
                </text>
              </g>
            ))}
            <text transform={`translate(-38,${ih / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="var(--ink-muted)">
              {unit}
            </text>
            {refLine && (
              <g>
                <line x1={0} x2={iw} y1={ys(refLine.y)} y2={ys(refLine.y)} stroke="var(--ink)" strokeDasharray="6 4" strokeWidth="2" />
                <text x={iw - 4} y={ys(refLine.y) - 5} textAnchor="end" fontSize="11" fontWeight="700" fill="var(--ink)">
                  {refLine.label}
                </text>
              </g>
            )}
            {groups.map((g, gi) => {
              const cx = band * gi + band / 2;
              const mean = g.values.reduce((a, b) => a + b, 0) / Math.max(1, g.values.length);
              return (
                <g key={g.label}>
                  {g.values.map((v, i) => (
                    <rect key={i} x={cx - 16 + ((i * 37) % 32)} y={ys(v) - 1.5} width={5} height={3} fill={toneVar[g.tone]} />
                  ))}
                  <line x1={cx - 24} x2={cx + 24} y1={ys(mean)} y2={ys(mean)} stroke={toneVar[g.tone]} strokeWidth="3" />
                  <text x={cx} y={ih + 18} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--ink)">
                    {g.label}
                  </text>
                  <text x={cx + 28} y={ys(mean)} dy="0.32em" fontSize="11" fill="var(--ink)" className="tnum">
                    {mean.toFixed(1)}
                  </text>
                </g>
              );
            })}
            <line x1={0} x2={iw} y1={ih} y2={ih} stroke="var(--ink-muted)" />
          </g>
        </svg>
      </div>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------- score bar */
export function ScoreBar({
  q,
  e,
  a,
  max,
  label,
}: {
  q: number;
  e: number;
  a: number;
  max: number;
  label: string;
}) {
  const total = q + e + a;
  const pc = (v: number) => (v / Math.max(1e-9, max)) * 100;
  return (
    <div className="scorebar" role="img" aria-label={`${label}. Queue ${q.toFixed(1)}, arrivals ${e.toFixed(1)}, aging ${a.toFixed(1)}, total ${total.toFixed(1)}.`}>
      <svg width="100%" height="22">
        <rect x="0%" y="0" width={`${pc(q)}%`} height="22" fill={patFill(0)} />
        <rect x={`${pc(q)}%`} y="0" width={`${pc(e)}%`} height="22" fill={patFill(1)} stroke="var(--sign)" />
        <rect x={`${pc(q + e)}%`} y="0" width={`${pc(a)}%`} height="22" fill={patFill(2)} stroke="var(--sign)" />
      </svg>
    </div>
  );
}
