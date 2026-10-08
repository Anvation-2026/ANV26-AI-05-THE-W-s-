import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APPROACH_NAMES, APPROACHES, PerceptionSchema, VEHICLE_CLASSES, type PerceptionResult } from '../contracts';
import { JunctionView, type Overlays } from '../components/JunctionView';
import { Transport } from '../components/widgets';
import { Histogram, LineChart, type Series } from '../components/charts';
import { Badge, Button, Check, Dialog, EmptyState, FileDrop, PageHeader, Segmented, toast } from '../components/ui';
import { useApp } from '../store/app';
import { useVideo } from '../store/video';
import { baseUrl, useBackend } from '../api/backend';
import { useRunner } from '../hooks/useRunner';
import { useCommands } from '../shell/Layout';
import { useRunStatus } from '../shell/status';
import { CAPTURE_DURATION, CAPTURE_SEED, captureDemand, captureParams } from '../engine/capture';
import { DEFAULT_OPTIONS, NO_NOISE } from '../engine/params';
import { Sim } from '../engine/sim';
import { hash01 } from '../engine/rng';
import { Footer } from '../shell/Layout';
import { RecordedPanels, VideoPerception } from '../components/RecordedVideo';

type Source = 'sample' | 'file' | 'backend';

export default function Perception() {
  const params = useApp((s) => s.params);
  const junction = useApp((s) => s.junction);
  const perception = useApp((s) => s.perception);
  const setPerception = useApp((s) => s.setPerception);
  const origin = useApp((s) => s.perceptionOrigin);
  const serverVideo = useApp((s) => s.serverVideo);
  const backendStatus = useBackend((s) => s.status);
  const apiKey = useBackend((s) => s.apiKey);
  const video = useVideo();
  const setStatus = useRunStatus((s) => s.set);
  const hasVideo = junction.source === 'video' && !!video.url;
  // the video to show: the file in this browser if it is still loaded, otherwise the copy on the server
  const serverUrl = serverVideo && backendStatus !== 'offline' && backendStatus !== 'none' ? `${baseUrl()}/v1/videos/${serverVideo.videoId}/stream${apiKey ? `?api_key=${encodeURIComponent(apiKey)}` : ''}` : null;
  const videoUrl = video.url ?? serverUrl;
  const [source, setSource] = useState<Source>(origin === 'backend' && perception ? 'backend' : hasVideo ? 'file' : 'sample');
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

  const fileMode = source === 'file' || source === 'backend';
  const isBackend = source === 'backend';
  const shown = fileMode && (isBackend ? origin === 'backend' : origin !== 'backend') ? perception : null;
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
                {
                  value: 'backend',
                  label: 'Back end',
                  disabledReason: backendStatus === 'connected' || backendStatus === 'degraded' || (origin === 'backend' && !!perception) ? undefined : 'The back end is not connected. Start it (see the README) and press Check again in the Back end settings.',
                },
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
          <Badge tone={fileMode ? 'plain' : 'paint'}>{isBackend ? 'Your video, back end' : fileMode ? 'Your video' : 'Sample data'}</Badge>
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
            {fileMode && <VideoPerception hasVideo={!!videoUrl} url={videoUrl} perception={shown} layers={layers} geometry={junction.geometry} backend={isBackend} onImport={() => setImportOpen(true)} />}
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
                        {(fileMode ? fileCounts(shown)[ap] : stats.counts[ap]).map((n, i) => (
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
                {fileMode ? (shown ? (isBackend ? 'Counted by the back end on your upstream lines.' : 'From your imported file.') : isBackend ? 'No back end analysis yet. Run Analyse video in the last step of Setup.' : 'No detections for this video yet.') : `${total} vehicles crossed the upstream lines so far. Sample run.`}
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
            {fileMode && shown && <RecordedPanels perception={shown} backend={isBackend} />}
            <section className="panel" aria-labelledby="weak-h">
              <h2 id="weak-h">Known weaknesses</h2>
              <ul style={{ marginTop: 8 }}>
                <li>
                  <strong>Occlusion in dense traffic.</strong> {fileMode ? (shown?.quality ? `${(shown.quality.trackFragmentation * 100).toFixed(0)} percent of tracks stopped inside the picture, which is what hidden vehicles look like. Lower is better.` : 'Not measured until detections exist.') : `Peak queue so far is ${maxQ.toFixed(0)} PCU. Risk rises above about 25 PCU, when vehicles hide each other.`}
                </li>
                <li>
                  <strong>Night video.</strong> {fileMode ? (shown?.quality ? (shown.quality.lowLight ? 'This clip is dark. Small vehicles are the first to be missed.' : 'This clip is bright enough. Night footage would lose small vehicles first.') : 'Check the clip. Night footage loses small vehicles first.') : 'The sample feed is daylight, so this risk is not exercised here.'}
                </li>
                <li>
                  <strong>Two-wheelers weaving between lanes.</strong> {fileMode ? (shown?.counts?.length ? `Two-wheelers are ${((shown.counts.filter((c) => c.line === 'upstream' && c.cls === 'twoWheeler').length / Math.max(1, shown.counts.filter((c) => c.line === 'upstream').length)) * 100).toFixed(0)} percent of counted vehicles. They are the class most often missed or merged.` : 'Not measured until detections exist.') : `Two-wheelers are ${(stats.twoShare * 100).toFixed(0)} percent of vehicles so far. They are the class most often missed or merged.`}
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
