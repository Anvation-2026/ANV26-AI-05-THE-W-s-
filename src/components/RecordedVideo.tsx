import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { APPROACH_NAMES, APPROACHES, type Geometry, type PerceptionResult } from '../contracts';
import { Histogram, LineChart, type Series } from './charts';
import { Badge, Button, EmptyState } from './ui';

/** The sampled picture whose time is nearest to t, or null when the nearest one is more than `tol` seconds away. */
/**
 * The detections at time t, with each tracked vehicle's box slid between the two analysed pictures around t.
 * The analysis keeps about 10 pictures a second and the video plays at 25 or 30, so without this each box would sit still for a few
 * frames and then jump. A vehicle seen in only one of the two pictures stays where it was seen, for at most `hold` seconds.
 */
export function boxesAt(frames: PerceptionResult['frames'], t: number, hold: number): PerceptionResult['frames'][number]['detections'] {
  if (!frames.length) return [];
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const next = frames[lo];
  if (next.t < t) return t - next.t <= hold ? next.detections : []; // after the last picture
  if (lo === 0) return next.t - t <= hold ? next.detections : []; // before the first picture
  const prev = frames[lo - 1];
  const span = next.t - prev.t;
  if (span > 2 * hold) {
    // a gap in the analysis: show the nearer picture only if it is close
    const [near, d] = t - prev.t <= next.t - t ? [prev, t - prev.t] : [next, next.t - t];
    return d <= hold ? near.detections : [];
  }
  const k = span > 0 ? (t - prev.t) / span : 0;
  const later = new Map(next.detections.map((d) => [d.id, d]));
  const out: PerceptionResult['frames'][number]['detections'] = [];
  for (const a of prev.detections) {
    const b = later.get(a.id);
    if (b) {
      out.push({ ...a, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k, conf: a.conf + (b.conf - a.conf) * k });
      later.delete(a.id);
    } else if (k < 0.5) out.push(a); // gone in the next picture: keep it until halfway
  }
  if (k >= 0.5) for (const b of later.values()) out.push(b); // new in the next picture: show it from halfway
  return out;
}

export function nearestFrame(frames: PerceptionResult['frames'], t: number, tol: number) {
  let lo = 0;
  let hi = frames.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const a = frames[lo];
  const b = frames[Math.max(0, lo - 1)];
  const best = Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
  return Math.abs(best.t - t) <= tol ? best : null;
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export function VideoPerception({
  hasVideo,
  url,
  perception,
  layers,
  geometry,
  backend,
  onImport,
}: {
  hasVideo: boolean;
  url: string | null;
  perception: PerceptionResult | null;
  layers: { boxes: boolean; ids: boolean; counts: boolean; queueZones: boolean };
  geometry: Geometry;
  backend: boolean;
  onImport: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  useEffect(() => {
    const v = ref.current as VideoWithFrameCallback | null;
    if (!v) return;
    setLoadErr(false);
    const on = () => {
      setT(v.currentTime);
      setPlaying(!v.paused);
    };
    ['timeupdate', 'play', 'pause', 'seeked'].forEach((e) => v.addEventListener(e, on));
    // while playing, follow the frame that is on screen so the boxes do not lag behind the picture
    let handle = 0;
    const tick = (_now: number, meta: { mediaTime: number }) => {
      setT(meta.mediaTime);
      handle = v.requestVideoFrameCallback!(tick);
    };
    if (v.requestVideoFrameCallback) handle = v.requestVideoFrameCallback(tick);
    return () => {
      ['timeupdate', 'play', 'pause', 'seeked'].forEach((e) => v.removeEventListener(e, on));
      if (v.cancelVideoFrameCallback && handle) v.cancelVideoFrameCallback(handle);
    };
  }, [url]);
  if (!hasVideo || !url) {
    return (
      <EmptyState
        title={backend ? 'The video is not available' : 'No video is loaded'}
        body={backend ? 'The video is no longer in this browser and the server copy cannot be reached. The counts and charts still come from the saved analysis.' : 'Videos are not kept between visits. Load the video again in Setup, or switch the source to the sample feed.'}
        action={
          <Link className="btn btn-primary" to="/setup">
            Go to Setup
          </Link>
        }
      />
    );
  }
  const tol = perception ? Math.max(0.3, 1.5 / Math.max(1, perception.fps)) : 0.3;
  const boxes = perception ? boxesAt(perception.frames, t, tol) : [];
  const W = perception?.width ?? ref.current?.videoWidth ?? 1280;
  const H = perception?.height ?? ref.current?.videoHeight ?? 720;
  const stroke = Math.max(1.5, W / 640);
  const line = (l: { a: { x: number; y: number }; b: { x: number; y: number } } | undefined, key: string, dash?: string) =>
    l ? <line key={key} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} stroke="var(--marking)" strokeWidth={stroke * 1.4} strokeDasharray={dash} /> : null;
  return (
    <div className="stack-sm">
      <div className="canvas-stage" style={{ position: 'relative' }}>
        <video ref={ref} src={url} muted playsInline preload="auto" style={{ width: '100%', display: 'block' }} aria-label="Your video with detections" onError={() => setLoadErr(true)} />
        <svg viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} aria-hidden="true">
          {layers.queueZones &&
            APPROACHES.map((a) => {
              const z = geometry.queueZones[a];
              return z && z.length >= 3 ? <polygon key={`z${a}`} points={z.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--marking)" strokeWidth={stroke} strokeDasharray="4 4" opacity="0.8" /> : null;
            })}
          {layers.counts && APPROACHES.map((a) => [line(geometry.stopLines[a], `s${a}`), line(geometry.upstreamLines[a], `u${a}`, '10 6')])}
          {layers.boxes &&
            boxes.map((d) => (
              <g key={d.id}>
                <rect x={d.x - d.w / 2} y={d.y - d.h / 2} width={d.w} height={d.h} fill="none" stroke="var(--marking)" strokeWidth={stroke} strokeDasharray={d.cls === 'twoWheeler' ? '3 3' : d.cls === 'autoRickshaw' ? '8 4' : d.cls === 'truck' ? '14 4' : undefined} />
                <text x={d.x - d.w / 2} y={d.y - d.h / 2 - 3} fill="var(--marking)" fontSize={Math.max(10, W / 100)} fontWeight="700">
                  {d.cls[0].toUpperCase()}
                  {layers.ids ? d.id : ''} {d.conf.toFixed(2)}
                </text>
              </g>
            ))}
        </svg>
      </div>
      {loadErr && (
        <p className="field-error" role="alert">
          The video could not be played here. {backend ? 'The server copy may have been deleted or the server is not reachable.' : 'The file may have been moved.'} Counts and charts are not affected.
        </p>
      )}
      <div className="panel row">
        <Button variant="secondary" icon={playing ? 'pause' : 'play'} onClick={() => (ref.current?.paused ? void ref.current.play() : ref.current?.pause())}>
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button variant="secondary" icon="step" onClick={() => ref.current && (ref.current.currentTime += 1 / 30)}>
          Step frame
        </Button>
        <input className="slider" style={{ flex: 1, minWidth: 160 }} type="range" min={0} max={ref.current?.duration || 1} step={0.04} value={t} aria-label="Video time" onChange={(e) => ref.current && (ref.current.currentTime = Number(e.target.value))} />
        <span className="tnum muted">{t.toFixed(1)} s</span>
      </div>
      {!perception && (
        <div className="empty" role="status">
          <h3>No detections for this video yet</h3>
          <p className="muted">{backend ? 'Run Analyse video in the last step of Setup to draw boxes and counts on your video.' : 'Import a perception file to draw boxes and counts on your video, or switch the source to the sample feed.'}</p>
          {backend ? (
            <Link className="btn btn-primary" to="/setup">
              Go to Setup
            </Link>
          ) : (
            <Button variant="primary" icon="upload" onClick={onImport}>
              Import perception file
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Charts and quality numbers computed from a recorded analysis rather than from the generated sample feed. */
export function RecordedPanels({ perception, backend, assumed }: { perception: PerceptionResult; backend: boolean; assumed?: { vph: number[]; fairnessCap?: number } }) {
  const q = perception.queue;
  const series: Series[] = useMemo(
    () =>
      q
        ? APPROACHES.map((a, ap) => ({
            id: a,
            label: APPROACH_NAMES[a],
            data: (q.approaches[a] ?? []).filter((_, t) => t % 5 === 0).map((v, i) => [i * 5, v] as [number, number]),
            tone: ap % 2 === 0 ? ('new' as const) : ('old' as const),
            dash: ap < 2 ? undefined : '6 4',
          }))
        : [],
    [q],
  );
  const speeds = useMemo(() => (perception.speeds ?? []).map((s) => s.kmh), [perception.speeds]);
  const conf = useMemo(() => {
    const out: number[] = [];
    const step = Math.max(1, Math.floor(perception.frames.length / 400));
    for (let i = 0; i < perception.frames.length; i += step) for (const d of perception.frames[i].detections) out.push(d.conf);
    return out;
  }, [perception.frames]);
  const m = perception.meta;
  const ql = perception.quality;
  const sf = perception.satFlow;
  const warnings = [...(m?.warnings ?? []), ...(ql?.warnings ?? [])];
  const seconds = m?.durationS ?? Math.max(0, ...perception.frames.map((f) => f.t));
  const ups = (perception.counts ?? []).filter((c) => c.line === 'upstream');
  const perHour = APPROACHES.map((a) => ({ a, n: ups.filter((c) => c.approach === a).length }));
  const anyFlow = perHour.some((r) => r.n > 0);
  return (
    <>
      {assumed && (
        <section className="panel stack-sm" aria-labelledby="assumed-h">
          <div className="row-between">
            <h2 id="assumed-h">Busy-hour traffic used by the simulations</h2>
            <Badge tone="paint">Assumed for this example</Badge>
          </div>
          <div className="table-wrap">
            <table className="table" aria-label="Assumed busy-hour vehicles per hour">
              <thead>
                <tr>
                  <th>Approach</th>
                  <th className="num">Vehicles per hour</th>
                </tr>
              </thead>
              <tbody>
                {APPROACHES.map((a, i) => (
                  <tr key={a}>
                    <td>{APPROACH_NAMES[a]}</td>
                    <td className="num">{assumed.vph[i] > 0 ? assumed.vph[i].toLocaleString() : 'no traffic on this road'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {assumed.fairnessCap && <p className="muted">Longest red allowed for any road: {assumed.fairnessCap} s. This is a four-phase junction, where every road waits for three other greens, so the default of 60 s is too tight; the fixed Webster plan alone reaches about 87 s. You can change it on the Parameters page.</p>}
          <p className="muted">
            These are busy-hour volumes chosen for this example. They were not counted from the video, which is only a few seconds long, so its own counts are far smaller. The Console, Experiments and Report pages run the four signal plans on this traffic, the way Scenario A and B do for the sample junction.
          </p>
        </section>
      )}
      {anyFlow && seconds > 0 && (
        <section className="panel stack-sm" aria-labelledby="rate-h">
          <h2 id="rate-h">Flow at this clip's pace</h2>
          <div className="table-wrap">
            <table className="table" aria-label="Vehicles counted and the hourly rate they imply">
              <thead>
                <tr>
                  <th>Approach</th>
                  <th className="num">Counted in {seconds.toFixed(0)} s</th>
                  <th className="num">Rate per hour</th>
                </tr>
              </thead>
              <tbody>
                {perHour.map((r) => (
                  <tr key={r.a}>
                    <td>{APPROACH_NAMES[r.a]}</td>
                    <td className="num">{r.n}</td>
                    <td className="num">{r.n ? `${Math.round((r.n / seconds) * 3600).toLocaleString()} vehicles` : 'none seen'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            The hourly rate is the count scaled up from {seconds.toFixed(0)} seconds of video, so it is a rough extrapolation. It rises and falls with the signal phase and with how long the clip is. A clip of several minutes covering whole signal cycles gives a much steadier figure.
          </p>
        </section>
      )}
      {q && series.length > 0 && (
        <section className="panel">
          <LineChart title="Queue over time by approach, from your video" series={series} height={220} xLabel="Time (s)" yLabel="Queue (PCU)" xDomain={[0, Math.max(1, (q.approaches.N ?? []).length)]} xFormat={(n) => String(Math.round(n))} yFormat={(n) => n.toFixed(0)} unit="PCU" />
        </section>
      )}
      {speeds.length > 0 && (
        <section className="panel">
          <Histogram title="Speed at the stop line" values={speeds} bins={10} xLabel="km/h" height={190} xFormat={(n) => n.toFixed(0)} />
        </section>
      )}
      {conf.length > 0 && (
        <section className="panel">
          <Histogram title="Detection confidence" values={conf} bins={9} xLabel="Confidence" height={190} mark={{ x: 0.5, label: 'Typical cut-off 0.5' }} xFormat={(n) => n.toFixed(2)} />
        </section>
      )}
      {(ql || m || sf) && (
        <section className="panel stack-sm" aria-labelledby="qual-h">
          <div className="row-between">
            <h2 id="qual-h">Quality of this analysis</h2>
            {ql && <Badge tone={ql.missedCountRisk === 'low' ? 'sign' : ql.missedCountRisk === 'high' ? 'stop' : 'paint'}>Risk of missed counts: {ql.missedCountRisk}</Badge>}
          </div>
          <ul className="status-list tnum">
            {ql && (
              <>
                <li>
                  <span>Mean detection confidence</span>
                  <span>{ql.meanConfidence.toFixed(2)}</span>
                </li>
                <li>
                  <span>Tracks that ended inside the picture</span>
                  <span>{(ql.trackFragmentation * 100).toFixed(0)} percent</span>
                </li>
                <li>
                  <span>Camera movement</span>
                  <span>{ql.cameraMotionPx.toFixed(1)} px</span>
                </li>
                <li>
                  <span>Low light</span>
                  <span>{ql.lowLight ? 'Yes' : 'No'}</span>
                </li>
              </>
            )}
            {sf && (
              <>
                <li>
                  <span>Saturation flow</span>
                  <span>
                    {Math.round(sf.perLane)} PCU/h/lane{sf.isDefault ? ', default (not enough queue discharge)' : `, measured from ${sf.samples} headways`}
                  </span>
                </li>
                <li>
                  <span>Start-up lost time</span>
                  <span>
                    {sf.startupLost.toFixed(1)} s{sf.startupLostIsDefault || sf.isDefault ? ', default' : ', measured'}
                  </span>
                </li>
              </>
            )}
            {perception.waits && perception.waits.length > 0 && (
              <li>
                <span>Waits measured</span>
                <span>
                  {perception.waits.length} vehicles, mean {(perception.waits.reduce((a, b) => a + b, 0) / perception.waits.length).toFixed(0)} s
                </span>
              </li>
            )}
            {m && (
              <li>
                <span>Model</span>
                <span>
                  {m.model.name} on {m.model.device}, {m.frameCount.toLocaleString()} frames at {m.processedFps.toFixed(0)} per second
                </span>
              </li>
            )}
          </ul>
          {warnings.length > 0 ? (
            <ul>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No warnings.</p>
          )}
          {backend && <p className="muted">Counts come from a detector and a tracker, so they are estimates. The risk label says how likely they are to be low.</p>}
        </section>
      )}
    </>
  );
}
