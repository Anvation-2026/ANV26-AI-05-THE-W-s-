import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveRunner } from '../engine/live';
import type { Sim } from '../engine/sim';
import { computeMetrics } from '../engine/metrics';
import type { Metrics } from '../contracts';
import { IconButton, Segmented } from './ui';
import { phaseName } from '../engine/params';

/* --------------------------------------------------------------- scoreboard */
const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : 'none');

interface Cell {
  key: string;
  label: string;
  unit: string;
  pick: (m: Metrics) => number;
  digits: number;
  better: 'lower' | 'higher';
}
const CELLS: Cell[] = [
  { key: 'delay', label: 'Average delay', unit: 'seconds per vehicle', pick: (m) => m.avgDelayVeh, digits: 1, better: 'lower' },
  { key: 'red', label: 'Longest red', unit: 'seconds', pick: (m) => m.longestRed, digits: 0, better: 'lower' },
  { key: 'thr', label: 'Throughput', unit: 'vehicles per hour', pick: (m) => m.throughputVeh, digits: 0, better: 'higher' },
  { key: 'person', label: 'Person delay', unit: 'seconds per person', pick: (m) => m.avgDelayPerson, digits: 1, better: 'lower' },
  { key: 'queue', label: 'Maximum queue', unit: 'PCU', pick: (m) => m.maxQueue, digits: 1, better: 'lower' },
];

export function Scoreboard({
  runner,
  oldIndex = 0,
  newIndex = 1,
  cells = 4,
  tag,
  oldLabel = 'Current plan',
}: {
  runner: LiveRunner;
  oldIndex?: number;
  newIndex?: number;
  cells?: number;
  tag?: string;
  oldLabel?: string;
}) {
  const t = runner.t;
  const [mo, mn] = useMemo(() => {
    const a = runner.sims[oldIndex];
    const b = runner.sims[newIndex];
    return [a ? computeMetrics(a) : null, b ? computeMetrics(b) : null] as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.version, oldIndex, newIndex]);
  const ready = t >= 30 && mo && mn;
  return (
    <div>
    <dl className="scoreboard" aria-label={`Scoreboard, ${oldLabel} against SignalTwin plan`}>
      {CELLS.slice(0, cells).map((c) => {
        const a = mo ? c.pick(mo) : 0;
        const b = mn ? c.pick(mn) : 0;
        const pct = a !== 0 ? ((b - a) / Math.abs(a)) * 100 : 0;
        const good = c.better === 'lower' ? pct < -0.5 : pct > 0.5;
        const bad = c.better === 'lower' ? pct > 0.5 : pct < -0.5;
        return (
          <div className="score-cell" key={c.key}>
            <dt>{c.label}</dt>
            <dd>
              <span className="score-row">
                <span>
                  <span className="score-num score-num-old">{ready ? fmt(a, c.digits) : 'none'}</span>
                  <br />
                  <span className="score-tag">{oldLabel}</span>
                </span>
                <span>
                  <span className="score-num score-num-new">{ready ? fmt(b, c.digits) : 'none'}</span>
                  <br />
                  <span className="score-tag">SignalTwin plan</span>
                </span>
              </span>
              {ready && Math.abs(pct) >= 0.5 && (
                <span className={`score-delta ${good ? 'delta-good' : bad ? 'delta-bad' : ''}`}>
                  {pct > 0 ? 'Up' : 'Down'} {Math.abs(pct).toFixed(0)} percent
                </span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
    <p className="score-tag score-note">
      {ready ? `${tag ?? 'Sample run'}, ${Math.round(t / 60)} minutes of traffic so far.` : 'Numbers appear after 30 seconds of traffic.'}
    </p>
    </div>
  );
}

/* ---------------------------------------------------------- phase timeline */
const LAMP_NAMES = ['Red', 'Yellow', 'Green'];
export function PhaseTimeline({ sim, window: win = 180, height = 118 }: { sim: Sim; window?: number; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const t = sim.t;
  const start = Math.max(0, t - win);
  const names = ['N', 'S', 'E', 'W'];
  const labelW = 22;
  const iw = w - labelW;
  const rowH = (height - 18) / 4;
  const x = (s: number) => labelW + ((s - start) / Math.max(1, Math.min(win, Math.max(t, 30)))) * iw;
  const spanEnd = Math.max(t, Math.min(win, 30));
  const xx = (s: number) => labelW + ((s - start) / Math.max(1, spanEnd - start)) * iw;
  void x;
  const rows = [0, 1, 2, 3].map((ap) => {
    const ser = sim.lampSeries[ap];
    const runs: { s: number; e: number; v: number }[] = [];
    for (let i = start; i < ser.length; i++) {
      const v = ser[i];
      const last = runs[runs.length - 1];
      if (last && last.v === v) last.e = i + 1;
      else runs.push({ s: i, e: i + 1, v });
    }
    return runs;
  });
  const colors = ['var(--stop)', 'var(--caution)', 'var(--go)'];
  const heights = [0.22, 0.6, 1];
  return (
    <div ref={ref} className="phase-timeline">
      <svg
        width={w}
        height={height}
        role="img"
        aria-label={`Signal timeline for the last ${Math.round(Math.min(win, t))} seconds. Green is a tall bar, yellow a medium bar, red a thin bar. Current phase ${phaseName(sim.phases[sim.signal.phase])}.`}
      >
        {rows.map((runs, ap) => (
          <g key={ap} transform={`translate(0,${ap * rowH + 2})`}>
            <text x={0} y={rowH / 2 + 4} fontSize="12" fontWeight="700" fill="var(--ink)">
              {names[ap]}
            </text>
            {runs.map((r, i) => {
              const hh = rowH * heights[r.v];
              return <rect key={i} x={xx(r.s)} y={rowH - 3 - hh} width={Math.max(1, xx(r.e) - xx(r.s))} height={hh} fill={colors[r.v]}>
                <title>{`${LAMP_NAMES[r.v]}, ${r.e - r.s} s`}</title>
              </rect>;
            })}
          </g>
        ))}
        <line x1={labelW} x2={w} y1={height - 14} y2={height - 14} stroke="var(--ink-muted)" />
        <text x={labelW} y={height - 2} fontSize="11" fill="var(--ink-muted)">
          {Math.round(start)} s
        </text>
        <text x={w} y={height - 2} fontSize="11" textAnchor="end" fill="var(--ink-muted)">
          {Math.round(t)} s
        </text>
      </svg>
    </div>
  );
}

/* --------------------------------------------------------------- transport */
export function Transport({
  runner,
  showScrub = true,
  onSeek,
  speeds = [1, 2, 4, 8],
}: {
  runner: LiveRunner;
  showScrub?: boolean;
  onSeek?: (t: number) => void;
  speeds?: number[];
}) {
  const raf = useRef(0);
  const seek = (t: number) => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      runner.pause();
      runner.seek(t);
      onSeek?.(t);
    });
  };
  return (
    <div className="stack-sm">
      <div className="row">
        <div className="transport" role="group" aria-label="Playback">
          <IconButton icon="restart" label="Restart" onClick={() => runner.reset()} />
          <IconButton icon="step" label="Step one second" onClick={() => runner.stepOnce()} />
          <IconButton icon={runner.playing ? 'pause' : 'play'} label={runner.playing ? 'Pause' : 'Play'} onClick={() => runner.toggle()} />
        </div>
        <Segmented label="Speed" value={runner.speed} options={speeds.map((s) => ({ value: s, label: `${s}x` }))} onChange={(v) => runner.setSpeed(v)} />
        <span className="tnum muted" aria-live="off">
          {Math.floor(runner.t / 60)}:{String(runner.t % 60).padStart(2, '0')} of {Math.floor(runner.horizon / 60)}:{String(runner.horizon % 60).padStart(2, '0')}
        </span>
      </div>
      {showScrub && (
        <input
          className="slider timeline-scrub"
          type="range"
          min={0}
          max={runner.horizon}
          step={1}
          value={runner.t}
          aria-label="Simulation time"
          aria-valuetext={`${runner.t} seconds`}
          onChange={(e) => seek(Number(e.target.value))}
        />
      )}
    </div>
  );
}

