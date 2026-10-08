import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APPROACH_NAMES, APPROACHES, PerceptionSchema, VEHICLE_CLASSES, type PerceptionResult } from '../contracts';
import { JunctionView, type Overlays } from '../components/JunctionView';
import { Transport } from '../components/widgets';
import { Histogram, LineChart, type Series } from '../components/charts';
import { Badge, Button, Check, Dialog, EmptyState, FileDrop, PageHeader, Segmented, toast } from '../components/ui';
import { useApp } from '../store/app';
import { useVideo } from '../store/video';
import { useRunner } from '../hooks/useRunner';
import { useCommands } from '../shell/Layout';
import { useRunStatus } from '../shell/status';
import { CAPTURE_DURATION, CAPTURE_SEED, captureDemand, captureParams } from '../engine/capture';
import { DEFAULT_OPTIONS, NO_NOISE } from '../engine/params';
import { Sim } from '../engine/sim';
import { hash01 } from '../engine/rng';
import { Footer } from '../shell/Layout';

type Source = 'sample' | 'file' | 'backend';

export default function Perception() {
  const params = useApp((s) => s.params);
  const junction = useApp((s) => s.junction);
  const perception = useApp((s) => s.perception);
  const setPerception = useApp((s) => s.setPerception);
  const video = useVideo();
  const setStatus = useRunStatus((s) => s.set);
  const hasVideo = junction.source === 'video' && !!video.url;
  const [source, setSource] = useState<Source>(hasVideo ? 'file' : 'sample');
  const [logic, setLogic] = useState<'vac' | 'observed' | 'signaltwin'>('vac');
  const [layers, setLayers] = useState({ boxes: true, ids: true, speeds: false, counts: true, queueZones: true });
  const [importOpen, setImportOpen] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);

  const factory = useCallback(() => {
    const p = captureParams(params);
    return [
      new Sim({
        params: p,
        demand: captureDemand(params),
        kind: logic,
        options: DEFAULT_OPTIONS,
        seed: CAPTURE_SEED,
        horizon: CAPTURE_DURATION,
        noise: NO_NOISE,
        emergencies: [],
        observed: junction.observed,
        record: true,
      }),
    ];
  }, [params, junction.observed, logic]);
  const runner = useRunner(factory, CAPTURE_DURATION, [factory]);
  const sim = runner.sims[0];
  useEffect(() => {
    runner.seek(60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setStatus(runner.playing ? 'Playing the sample feed' : 'Paused');
    return () => setStatus('Idle');
  }, [runner.playing, setStatus]);
  useCommands({ toggle: () => runner.toggle(), restart: () => runner.reset(), speed: (d) => runner.setSpeed(Math.max(1, Math.min(8, d > 0 ? runner.speed * 2 : runner.speed / 2))) });

  const overlays: Overlays = { boxes: layers.boxes, ids: layers.ids, speeds: layers.speeds, counts: layers.counts, queueZones: layers.queueZones, labels: true };

  const stats = useMemo(() => {
    const counts = APPROACHES.map(() => VEHICLE_CLASSES.map(() => 0));
    const speeds: number[] = [];
    const conf: number[] = [];
    if (!sim) return { counts, speeds, conf, twoShare: 0 };
    let two = 0;
    let total = 0;
    for (let t = 0; t < sim.t; t++) {
      for (const v of sim.arrivals[t] ?? []) {
        counts[v.ap][VEHICLE_CLASSES.indexOf(v.cls)]++;
        speeds.push(v.speed * 3.6);
        conf.push(0.55 + hash01(v.id * 11) * 0.43);
        total++;
        if (v.cls === 'twoWheeler') two++;
      }
    }
    return { counts, speeds, conf, twoShare: total ? two / total : 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.version]);

  const queueSeries: Series[] = useMemo(
    () =>
      APPROACHES.map((a, ap) => ({
        id: a,
        label: APPROACH_NAMES[a],
        data: (sim?.qSeries[ap] ?? []).filter((_, t) => t % 5 === 0).map((v, i) => [i * 5, v] as [number, number]),
        tone: ap % 2 === 0 ? ('new' as const) : ('old' as const),
        dash: ap < 2 ? undefined : '6 4',
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runner.version],
  );

  const eventTicks = useMemo(() => {
    if (!sim) return [];
    const out: number[] = [];
    for (let t = 0; t < sim.t; t++) if ((sim.arrivals[t]?.length ?? 0) > 0) out.push(t);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.version]);

  const importFile = async (f: File) => {
    setImportErr(null);
    try {
      const parsed = PerceptionSchema.safeParse(JSON.parse(await f.text()));
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        return setImportErr(`${i.path.join('.') || 'file'}: ${i.message}. The file must follow the perception format described in src/contracts.`);
      }
      setPerception(parsed.data);
      setSource('file');
      setImportOpen(false);
      toast(`Perception file imported: ${parsed.data.frames.length} frames.`);
    } catch {
      setImportErr('That file is not valid JSON.');
    }
  };

  const fileMode = source === 'file';
  const total = stats.counts.reduce((s, r) => s + r.reduce((a, b) => a + b, 0), 0);
  const maxQ = sim ? Math.max(0, ...sim.maxQueue) : 0;

  return (
    <>
      <div className="page page-wide">
        <PageHeader
          title="Perception"
          lede="See what the system detects and counts. On the sample junction the feed is generated, so the detections behave like real tracker output."
          actions={
            <Button variant="secondary" icon="upload" onClick={() => setImportOpen(true)}>
              Import perception file
            </Button>
          }
        />
        <div className="controls">
          <div className="field">
            <span className="field-label">Detection source</span>
            <Segmented
              label="Detection source"
              value={source}
              options={[
                { value: 'sample', label: 'Sample feed' },
                { value: 'file', label: 'Imported perception file' },
                { value: 'backend', label: 'Back end', disabledReason: 'Not connected yet. This version has no vision back end.' },
              ]}
              onChange={setSource}
            />
          </div>
          {!fileMode && (
            <div className="field">
              <span className="field-label">Signal logic on this feed</span>
              <Segmented
                label="Signal logic on this feed"
                value={logic}
                options={[
                  { value: 'vac', label: 'VAC, clears the queue zone' },
                  { value: 'observed', label: 'Fixed plan as recorded' },
                  { value: 'signaltwin', label: 'SignalTwin' },
                ]}
                onChange={setLogic}
              />
            </div>
          )}
          <div className="field">
            <span className="field-label">Layers</span>
            <div className="row">
              <Check label="Boxes" checked={layers.boxes} onChange={(v) => setLayers({ ...layers, boxes: v })} />
              <Check label="Track numbers" checked={layers.ids} onChange={(v) => setLayers({ ...layers, ids: v })} />
              <Check label="Counting lines" checked={layers.counts} onChange={(v) => setLayers({ ...layers, counts: v })} />
              <Check label="Queue zones" checked={layers.queueZones} onChange={(v) => setLayers({ ...layers, queueZones: v })} />
              <Check label="Speeds" checked={layers.speeds} onChange={(v) => setLayers({ ...layers, speeds: v })} />
            </div>
          </div>
          <Badge tone={fileMode ? 'plain' : 'paint'}>{fileMode ? 'Your video' : 'Sample data'}</Badge>
        </div>

        <div className="split split-b" style={{ marginTop: 'var(--s-3)' }}>
          <section className="stack-sm" aria-label="Camera view">
            {!fileMode && (
              <>
                <div className="panel-asphalt on-asphalt" style={{ padding: 8 }}>
                  <JunctionView runner={runner} simIndex={0} overlays={overlays} caption="Sample camera, plan view" />
                </div>
                <div className="panel">
                  <Transport runner={runner} />
                  <EventStrip ticks={eventTicks} duration={CAPTURE_DURATION} t={runner.t} />
                </div>
              </>
            )}
            {fileMode && <VideoPerception hasVideo={hasVideo} url={video.url} perception={perception} layers={layers} onImport={() => setImportOpen(true)} />}
          </section>

          <div className="stack">
            <section className="panel" aria-labelledby="pc-h">
              <h2 id="pc-h" style={{ marginBottom: 8 }}>
                Counts
              </h2>
              <div className="table-wrap">
                <table className="table" aria-label="Vehicles counted per approach and class">
                  <thead>
                    <tr>
                      <th>Approach</th>
                      {VEHICLE_CLASSES.map((c) => (
                        <th key={c} className="num">
                          {params.classes[c].label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {APPROACHES.map((a, ap) => (
                      <tr key={a}>
                        <td>{APPROACH_NAMES[a]}</td>
                        {(fileMode ? fileCounts(perception)[ap] : stats.counts[ap]).map((n, i) => (
                          <td key={i} className="num">
                            {n}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted tnum" style={{ marginTop: 8 }}>
                {fileMode ? (perception ? 'From your imported file.' : 'No detections for this video yet.') : `${total} vehicles crossed the upstream lines so far. Sample run.`}
              </p>
            </section>
            {!fileMode && (
              <>
                <section className="panel">
                  <LineChart title="Queue over time by approach" series={queueSeries} height={220} xLabel="Time (s)" yLabel="Queue (PCU)" xDomain={[0, CAPTURE_DURATION]} xFormat={(n) => String(Math.round(n))} yFormat={(n) => n.toFixed(0)} unit="PCU" cursor={runner.t} />
                </section>
                <section className="panel">
                  <Histogram title="Speed at the upstream line" values={stats.speeds} bins={10} xLabel="km/h" height={190} xFormat={(n) => n.toFixed(0)} />
                </section>
                <section className="panel">
                  <Histogram title="Detection confidence" values={stats.conf} bins={9} xLabel="Confidence" height={190} mark={{ x: 0.5, label: 'Typical cut-off 0.5' }} xFormat={(n) => n.toFixed(2)} />
                </section>
              </>
            )}
            <section className="panel" aria-labelledby="weak-h">
              <h2 id="weak-h">Known weaknesses</h2>
              <ul style={{ marginTop: 8 }}>
                <li>
                  <strong>Occlusion in dense traffic.</strong> {fileMode ? 'Not measured until detections exist.' : `Peak queue so far is ${maxQ.toFixed(0)} PCU. Risk rises above about 25 PCU, when vehicles hide each other.`}
                </li>
                <li>
                  <strong>Night video.</strong> {fileMode ? 'Check the clip. Night footage loses small vehicles first.' : 'The sample feed is daylight, so this risk is not exercised here.'}
                </li>
                <li>
                  <strong>Two-wheelers weaving between lanes.</strong> {fileMode ? 'Not measured until detections exist.' : `Two-wheelers are ${(stats.twoShare * 100).toFixed(0)} percent of vehicles so far. They are the class most often missed or merged.`}
                </li>
              </ul>
              <p className="muted" style={{ marginTop: 8 }}>
                Because detection is never perfect, the Experiments page tests the controller with up to 30 percent of vehicles missed.
              </p>
            </section>
          </div>
        </div>
      </div>
      <Footer />
      <Dialog open={importOpen} title="Import a perception file" onClose={() => setImportOpen(false)}>
        <p>Choose the JSON file produced by the vision pipeline. It lists detections per frame and, optionally, line crossings. The format is documented in src/contracts.</p>
        <FileDrop accept="application/json,.json" label="Drop a perception JSON file here" hint="Frames with boxes, classes and confidence." onFile={importFile} error={importErr} icon="upload" />
        {perception && (
          <Button
            variant="danger"
            onClick={() => {
              setPerception(null);
              toast('Perception file removed.');
            }}
          >
            Remove the current file
          </Button>
        )}
      </Dialog>
    </>
  );
}

function fileCounts(p: PerceptionResult | null): number[][] {
  const c = APPROACHES.map(() => VEHICLE_CLASSES.map(() => 0));
  p?.counts?.filter((x) => x.line === 'upstream').forEach((x) => c[APPROACHES.indexOf(x.approach)][VEHICLE_CLASSES.indexOf(x.cls)]++);
  return c;
}

function EventStrip({ ticks, duration, t }: { ticks: number[]; duration: number; t: number }) {
  return (
    <svg width="100%" height="22" viewBox={`0 0 ${duration} 22`} preserveAspectRatio="none" role="img" aria-label={`Each mark is a second in which a vehicle crossed a counting line. ${ticks.length} so far.`} style={{ display: 'block', marginTop: 6, background: 'var(--surface-2)' }}>
      {ticks.map((x) => (
        <rect key={x} x={x} y={4} width={0.9} height={14} fill="var(--sign)" />
      ))}
      <rect x={t} y={0} width={2} height={22} fill="var(--ink)" />
    </svg>
  );
}

function VideoPerception({ hasVideo, url, perception, layers, onImport }: { hasVideo: boolean; url: string | null; perception: PerceptionResult | null; layers: { boxes: boolean; ids: boolean }; onImport: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const on = () => {
      setT(v.currentTime);
      setPlaying(!v.paused);
    };
    ['timeupdate', 'play', 'pause', 'seeked'].forEach((e) => v.addEventListener(e, on));
    return () => ['timeupdate', 'play', 'pause', 'seeked'].forEach((e) => v.removeEventListener(e, on));
  }, [url]);
  if (!hasVideo || !url) {
    return (
      <EmptyState
        title="No video is loaded"
        body="Videos are not kept between visits. Load the video again in Setup, or switch the source to the sample feed."
        action={
          <a className="btn btn-primary" href="/setup">
            Go to Setup
          </a>
        }
      />
    );
  }
  const frame = perception ? perception.frames.reduce((best, f) => (Math.abs(f.t - t) < Math.abs(best.t - t) ? f : best), perception.frames[0]) : null;
  const W = perception?.width ?? ref.current?.videoWidth ?? 1280;
  const H = perception?.height ?? ref.current?.videoHeight ?? 720;
  return (
    <div className="stack-sm">
      <div className="canvas-stage" style={{ position: 'relative' }}>
        <video ref={ref} src={url} muted playsInline preload="auto" style={{ width: '100%', display: 'block' }} aria-label="Your video with detections" />
        {frame && (
          <svg viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} aria-hidden="true">
            {layers.boxes &&
              frame.detections.map((d) => (
                <g key={d.id}>
                  <rect x={d.x - d.w / 2} y={d.y - d.h / 2} width={d.w} height={d.h} fill="none" stroke="var(--marking)" strokeWidth={Math.max(1.5, W / 640)} strokeDasharray={d.cls === 'twoWheeler' ? '3 3' : d.cls === 'autoRickshaw' ? '8 4' : d.cls === 'truck' ? '14 4' : undefined} />
                  <text x={d.x - d.w / 2} y={d.y - d.h / 2 - 3} fill="var(--marking)" fontSize={Math.max(10, W / 100)} fontWeight="700">
                    {d.cls[0].toUpperCase()}
                    {layers.ids ? d.id : ''} {d.conf.toFixed(2)}
                  </text>
                </g>
              ))}
          </svg>
        )}
      </div>
      <div className="panel row">
        <Button variant="secondary" icon={playing ? 'pause' : 'play'} onClick={() => (ref.current?.paused ? ref.current.play() : ref.current?.pause())}>
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
          <p className="muted">Import a perception file to draw boxes and counts on your video, or switch the source to the sample feed.</p>
          <Button variant="primary" icon="upload" onClick={onImport}>
            Import perception file
          </Button>
        </div>
      )}
    </div>
  );
}

