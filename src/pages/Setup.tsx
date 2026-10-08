import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APPROACH_NAMES, APPROACHES, JunctionSchema, type Approach, type Geometry, type JunctionConfig, type Point } from '../contracts';
import { Link } from 'react-router-dom';
import { GeometryEditor, SampleFrame, type Tool } from '../components/GeometryEditor';
import { JunctionView } from '../components/JunctionView';
import { Button, Dialog, EmptyState, FileDrop, IconButton, NumberField, PageHeader, Segmented, SkeletonBlock, Swap, toast, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { useApp } from '../store/app';
import { useVideo } from '../store/video';
import { SAMPLE_JUNCTION, SCENARIOS } from '../engine/params';
import { countGeometry, emptyGeometry, sampleCalibration, sampleGeometry, SAMPLE_FRAME } from '../engine/geometry';
import { fitCalibration, metresPerPixel, nearlyCollinear, polyArea, applyH, dist } from '../lib/homography';
import { COUNTS_TEMPLATE, parseCountsCsv } from '../api/MockApi';
import { downloadText, slug } from '../lib/util';
import { useRunner } from '../hooks/useRunner';
import { makeSim, profileFor } from '../engine/experiment';
import { useSetup } from '../hooks/useSetup';
import { Footer } from '../shell/Layout';

const STEPS = ['Source', 'Geometry', 'Calibration', 'Observed timing', 'Review'] as const;
const DRAFT_KEY = 'signaltwin-draft-v1';

interface Snap {
  geometry: Geometry;
  cal: Point[];
}

function sampleDraft(): JunctionConfig {
  return { ...SAMPLE_JUNCTION, geometry: sampleGeometry(), calibration: sampleCalibration() };
}

function loadDraft(): JunctionConfig | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JunctionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as unknown as JunctionConfig) : null;
  } catch {
    return null;
  }
}

export default function Setup() {
  const stored = useApp((s) => s.junction);
  const usingSample = useApp((s) => s.usingSample);
  const setJunction = useApp((s) => s.setJunction);
  const setParams = useApp((s) => s.setParams);
  const params = useApp((s) => s.params);
  const setCounts = useApp((s) => s.setCounts);
  const video = useVideo();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<JunctionConfig>(() => loadDraft() ?? (usingSample ? sampleDraft() : stored));
  const [tool, setTool] = useState<Tool>('select');
  const [ap, setAp] = useState<Approach>('N');
  const [cal, setCal] = useState<Point[]>(() => draft.calibration?.points ?? []);
  const [dists, setDists] = useState<number[]>(() => draft.calibration?.distances ?? [0, 0, 0, 0]);
  const [srcError, setSrcError] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvInfo, setCsvInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { ask, node: confirmNode } = useConfirm();

  /* ------------------------------------------------------------ history */
  const hist = useRef<{ stack: Snap[]; idx: number }>({ stack: [{ geometry: draft.geometry, cal }], idx: 0 });
  const [, bump] = useState(0);
  const timer = useRef<number | null>(null);
  const pushHistory = useCallback((geometry: Geometry, calPts: Point[]) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const h = hist.current;
      const top = h.stack[h.idx];
      if (JSON.stringify(top) === JSON.stringify({ geometry, cal: calPts })) return;
      h.stack = [...h.stack.slice(0, h.idx + 1), { geometry, cal: calPts }].slice(-60);
      h.idx = h.stack.length - 1;
      bump((n) => n + 1);
    }, 350);
  }, []);
  const flush = () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
      const h = hist.current;
      const cur = { geometry: draft.geometry, cal };
      if (JSON.stringify(h.stack[h.idx]) !== JSON.stringify(cur)) {
        h.stack = [...h.stack.slice(0, h.idx + 1), cur];
        h.idx = h.stack.length - 1;
      }
    }
  };
  const undo = () => {
    flush();
    const h = hist.current;
    if (h.idx > 0) {
      h.idx--;
      setDraft((d) => ({ ...d, geometry: h.stack[h.idx].geometry }));
      setCal(h.stack[h.idx].cal);
      bump((n) => n + 1);
    }
  };
  const redo = () => {
    const h = hist.current;
    if (h.idx < h.stack.length - 1) {
      h.idx++;
      setDraft((d) => ({ ...d, geometry: h.stack[h.idx].geometry }));
      setCal(h.stack[h.idx].cal);
      bump((n) => n + 1);
    }
  };
  const setGeometry = (g: Geometry) => {
    setDraft((d) => ({ ...d, geometry: g }));
    pushHistory(g, cal);
  };
  const setCalPoints = (pts: Point[]) => {
    setCal(pts);
    pushHistory(draft.geometry, pts);
  };

  /* --------------------------------------------------------- derived */
  const isVideo = draft.source === 'video';
  const isCounts = draft.source === 'counts';
  const isSample = draft.source === 'sample';
  const frame = isVideo && video.size ? { w: video.size.w, h: video.size.h } : SAMPLE_FRAME;
  const fit = useMemo(() => (cal.length === 4 && dists.every((x) => x > 0) ? fitCalibration(cal, dists) : null), [cal, dists]);
  const cg = countGeometry(draft.geometry);
  const missingStop = APPROACHES.filter((a) => !draft.geometry.stopLines[a]);
  const missingUp = APPROACHES.filter((a) => !draft.geometry.upstreamLines[a]);
  const missingZone = APPROACHES.filter((a) => (draft.geometry.queueZones[a]?.length ?? 0) < 3);
  const collinear = cal.length === 4 && nearlyCollinear(cal);
  const calOk = cal.length === 4 && !!fit && !collinear;
  const observed = draft.observed;
  const nPhases = observed.fourPhase ? 4 : 2;
  const greens = Array.from({ length: nPhases }, (_, i) => observed.greens[i] ?? observed.greens[observed.greens.length - 1] ?? 30);
  const timingErr = greens.findIndex((g) => g < params.minGreen) >= 0 ? `Each green must be at least the ${params.minGreen} s minimum green.` : observed.yellow < 1 || observed.allRed < 0 ? 'Yellow must be at least 1 s.' : null;

  const stepReason = (s: number): string | null => {
    if (s === 0) {
      if (isVideo && !video.url) return 'Choose the video file again. Videos are not kept between visits.';
      if (isCounts && !(draft.countsRows && draft.countsRows > 0)) return 'Choose a counts file with at least one row.';
      return null;
    }
    if (s === 1) {
      if (isCounts) return null;
      if (missingStop.length) return `Draw the stop line for ${missingStop.map((a) => APPROACH_NAMES[a]).join(', ')}.`;
      if (missingUp.length) return `Draw the upstream line for ${missingUp.map((a) => APPROACH_NAMES[a]).join(', ')}.`;
      return null;
    }
    if (s === 2) {
      if (isCounts) return null;
      if (cal.length < 4) return `Place ${4 - cal.length} more calibration point${4 - cal.length === 1 ? '' : 's'} on the road.`;
      if (dists.some((x) => !(x > 0))) return 'Enter the real distance in metres for all four sides.';
      if (collinear) return 'The points are nearly in a straight line. Move them to the corners of a rectangle on the road.';
      return null;
    }
    if (s === 3) return timingErr;
    return null;
  };
  const doneStep = (s: number) => stepReason(s) === null;
  const reason = stepReason(step);

  /* ---------------------------------------------------------- source */
  const onVideo = (f: File) => {
    setSrcError(null);
    if (!/^video\/(mp4|webm|quicktime)$/.test(f.type) && !/\.(mp4|mov|webm)$/i.test(f.name)) return setSrcError('That file is not a video. Use an MP4, MOV or WebM file.');
    if (f.size > 800 * 1024 * 1024) return setSrcError(`That video is ${(f.size / 1048576).toFixed(0)} MB. The limit is 800 MB. Trim it or lower its resolution first.`);
    setLoading(true);
    const url = URL.createObjectURL(f);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      if (!v.videoWidth) {
        URL.revokeObjectURL(url);
        setLoading(false);
        return setSrcError('This browser cannot read that video. Try an H.264 MP4.');
      }
      if (v.duration < 3) {
        URL.revokeObjectURL(url);
        setLoading(false);
        return setSrcError(`The video is only ${v.duration.toFixed(1)} s long. Use a clip of at least 3 s, ideally several minutes.`);
      }
      const size = { w: v.videoWidth, h: v.videoHeight, duration: v.duration };
      video.set({ url, name: f.name, size });
      setDraft({ ...draft, source: 'video', name: f.name.replace(/\.[^.]+$/, ''), videoName: f.name, videoSize: size, geometry: emptyGeometry(), calibration: null });
      setCal([]);
      setDists([0, 0, 0, 0]);
      hist.current = { stack: [{ geometry: emptyGeometry(), cal: [] }], idx: 0 };
      setLoading(false);
      toast(`Video loaded: ${v.videoWidth} by ${v.videoHeight}, ${Math.round(v.duration)} s.`);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      setLoading(false);
      setSrcError('The video could not be opened. It may be damaged or in a format this browser does not support.');
    };
    v.src = url;
  };
  const onCsv = async (f: File) => {
    setCsvError(null);
    setCsvInfo(null);
    if (!/\.csv$/i.test(f.name) && f.type !== 'text/csv') return setCsvError('That file is not a CSV. Use a .csv file.');
    if (f.size > 40 * 1024 * 1024) return setCsvError('That file is over 40 MB. Aggregate the counts into longer time bins first.');
    const text = await f.text();
    const { rows, error } = parseCountsCsv(text);
    if (error) return setCsvError(error);
    setCounts(rows);
    const tmax = rows.reduce((m, r) => Math.max(m, r.t), 0);
    setCsvInfo(`${rows.length.toLocaleString()} rows, ${rows.reduce((s, r) => s + r.count, 0).toLocaleString()} vehicles, ${Math.round(tmax)} s of data.`);
    setDraft({ ...draft, source: 'counts', name: f.name.replace(/\.[^.]+$/, ''), countsRows: rows.length, geometry: emptyGeometry(), calibration: null });
    toast('Counts file read.');
  };
  const useSample = () => {
    const d = sampleDraft();
    setDraft(d);
    setCal(d.calibration!.points);
    setDists(d.calibration!.distances);
    hist.current = { stack: [{ geometry: d.geometry, cal: d.calibration!.points }], idx: 0 };
    video.clear();
    toast('Sample junction loaded.');
  };

  /* --------------------------------------------------------- navigation */
  const go = (n: number) => {
    flush();
    if (n > step) {
      for (let s = step; s < n; s++) {
        const r = stepReason(s);
        if (r) {
          toast(r, 'error');
          return;
        }
      }
    }
    setStep(n);
  };
  const saveDraft = () => {
    flush();
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, calibration: cal.length === 4 ? { points: cal, distances: dists } : null }));
      toast('Draft saved in this browser.');
    } catch {
      toast('The draft could not be saved. Browser storage is full or blocked.', 'error');
    }
  };
  const resetStep = async () => {
    const ok = await ask('Reset this step', `This clears what you entered in step ${step + 1}, ${STEPS[step]}.`, 'Reset step', true);
    if (!ok) return;
    if (step === 1) setGeometry(emptyGeometry());
    if (step === 2) {
      setCal([]);
      setDists([0, 0, 0, 0]);
    }
    if (step === 3) setDraft({ ...draft, observed: SAMPLE_JUNCTION.observed });
    if (step === 0) useSample();
    toast('Step reset.');
  };

  const save = () => {
    flush();
    const j: JunctionConfig = {
      ...draft,
      id: isSample ? SAMPLE_JUNCTION.id : draft.id === SAMPLE_JUNCTION.id ? `junction-${Date.now()}` : draft.id,
      calibration: cal.length === 4 && dists.every((x) => x > 0) ? { points: cal, distances: dists } : null,
      updatedAt: new Date().toISOString(),
    };
    setJunction(isSample ? { ...j, geometry: SAMPLE_JUNCTION.geometry, calibration: null } : j, isSample);
    setParams({ yellow: j.observed.yellow, allRed: j.observed.allRed, fourPhase: j.observed.fourPhase });
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
    toast('Junction saved.');
  };
  const exportJson = () => {
    const j = { ...draft, calibration: cal.length === 4 ? { points: cal, distances: dists } : null };
    downloadText(`${slug(draft.name) || 'junction'}.json`, JSON.stringify(j, null, 2), 'application/json');
    toast('Junction exported as JSON.');
  };
  const importJson = async (f: File) => {
    setImportErr(null);
    try {
      const parsed = JunctionSchema.safeParse(JSON.parse(await f.text()));
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        return setImportErr(`${i.path.join('.') || 'file'}: ${i.message}. Export a junction from this page and use that file.`);
      }
      const j = parsed.data as unknown as JunctionConfig;
      setDraft(j);
      setCal(j.calibration?.points ?? []);
      setDists(j.calibration?.distances ?? [0, 0, 0, 0]);
      hist.current = { stack: [{ geometry: j.geometry, cal: j.calibration?.points ?? [] }], idx: 0 };
      setImportOpen(false);
      toast('Junction imported.');
    } catch {
      setImportErr('That file is not valid JSON.');
    }
  };

  const setTiming = (patch: Partial<typeof observed>) => setDraft({ ...draft, observed: { ...observed, ...patch, greens: patch.greens ?? greens } });

  /* ------------------------------------------------------------ render */
  const toolBtn = (t: Tool, label: string, icon: Parameters<typeof IconButton>[0]['icon']) => <IconButton key={t} icon={icon} label={label} pressed={tool === t} onClick={() => setTool(t)} />;
  const background = isVideo && video.url ? <VideoStage url={video.url} /> : <SampleFrame />;

  return (
    <>
      <div className="page page-wide">
        <PageHeader
          title="Setup"
          lede="Describe the junction once. SignalTwin keeps it, so every other page can use it."
          actions={
            <>
              <Button variant="secondary" icon="upload" onClick={() => setImportOpen(true)}>
                Import JSON
              </Button>
              <Button variant="secondary" icon="download" onClick={exportJson}>
                Export JSON
              </Button>
            </>
          }
        />
        <div className="setup-grid">
          <nav className="stepper" aria-label="Setup steps">
            {STEPS.map((s, i) => (
              <button key={s} className="step-btn" aria-current={step === i ? 'step' : undefined} onClick={() => go(i)}>
                <span className="step-n">{i + 1}</span>
                <span>{s}</span>
                <span className="step-state">{step === i ? 'Current' : i < step || (doneStep(i) && i < 4 && step > i) ? 'Done' : 'Not finished'}</span>
              </button>
            ))}
          </nav>

          <div className="stack" style={{ minWidth: 0 }}>
            <Swap id={step}>
            {step === 0 && (
              <div className="stack">
                <section className="panel stack" aria-labelledby="src-v">
                  <h2 id="src-v">Video of the junction</h2>
                  <p className="muted">A fixed camera, one junction, daylight if possible. The video is read in this browser and is not uploaded.</p>
                  <FileDrop accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" label="Drop an MP4 here" hint="MP4, MOV or WebM, up to 800 MB." onFile={onVideo} error={srcError} icon="video" />
                  {loading && <SkeletonBlock lines={2} />}
                  {isVideo && video.url && (
                    <div className="stack-sm">
                      <VideoPoster url={video.url} />
                      <p className="tnum">
                        {draft.videoName}, {draft.videoSize?.w} by {draft.videoSize?.h}, {Math.round(draft.videoSize?.duration ?? 0)} s.
                      </p>
                    </div>
                  )}
                  {isVideo && !video.url && <p className="field-error">The saved junction used a video that is no longer loaded. Choose the file again to keep drawing on it.</p>}
                </section>
                <section className="panel stack" aria-labelledby="src-c">
                  <h2 id="src-c">Counts file</h2>
                  <p className="muted">No video? Provide counts instead: time in seconds, approach, vehicle class and count.</p>
                  <FileDrop accept=".csv,text/csv" label="Drop a CSV here" hint="Columns: time, approach, class, count." onFile={onCsv} error={csvError} icon="report" />
                  <div className="row">
                    <Button variant="quiet" icon="download" onClick={() => downloadText('signaltwin-counts-template.csv', COUNTS_TEMPLATE)}>
                      Download the template
                    </Button>
                    {csvInfo && <span className="tnum">{csvInfo}</span>}
                  </div>
                </section>
                <section className="panel stack" aria-labelledby="src-s">
                  <h2 id="src-s">Sample junction</h2>
                  <p className="muted">A built-in four-way junction with generated traffic, so every page works without any upload. Everything it shows is labelled as sample data.</p>
                  <div className="row">
                    <Button variant={isSample ? 'secondary' : 'primary'} onClick={useSample}>
                      Use the sample junction
                    </Button>
                    {isSample && <span className="badge">In use</span>}
                  </div>
                </section>
              </div>
            )}

            {step === 1 && (
              <>
                {isCounts ? (
                  <EmptyState title="A counts file needs no drawing" body="Stop lines and zones are only needed to measure a video. Continue to the next step." />
                ) : (
                  <section className="stack-sm" aria-labelledby="geo-h">
                    <h2 id="geo-h" className="sr-only">
                      Draw the geometry
                    </h2>
                    <div className="toolbar" role="toolbar" aria-label="Drawing tools">
                      {toolBtn('select', 'Select and move points', 'cursor')}
                      {toolBtn('stop', 'Draw a stop line', 'drawLine')}
                      {toolBtn('upstream', 'Draw an upstream line', 'drawLine')}
                      {toolBtn('zone', 'Draw a queue zone', 'drawZone')}
                      <span style={{ width: 12 }} />
                      <IconButton icon="undo" label="Undo" onClick={undo} disabled={hist.current.idx === 0} disabledReason="Nothing to undo." />
                      <IconButton icon="redo" label="Redo" onClick={redo} disabled={hist.current.idx >= hist.current.stack.length - 1} disabledReason="Nothing to redo." />
                      <span style={{ width: 12 }} />
                      <span className="field-label">Approach</span>
                      <Segmented label="Approach to draw" value={ap} options={APPROACHES.map((a) => ({ value: a, label: `${a} ${APPROACH_NAMES[a]}` }))} onChange={setAp} />
                      <Button
                        variant="quiet"
                        icon="trash"
                        onClick={() => {
                          const g = JSON.parse(JSON.stringify(draft.geometry)) as Geometry;
                          delete g.stopLines[ap];
                          delete g.upstreamLines[ap];
                          delete g.queueZones[ap];
                          setGeometry(g);
                        }}
                      >
                        Clear {APPROACH_NAMES[ap]}
                      </Button>
                    </div>
                    {isVideo && video.url && <VideoScrub />}
                    <GeometryEditor frame={frame} background={background} geometry={draft.geometry} onGeometry={setGeometry} tool={tool} approach={ap} calPoints={cal} onCalPoints={setCalPoints} H={fit?.H} visible={{ geometry: true, calibration: false }} onMessage={(m) => toast(m)} />
                    <p className="muted" aria-live="polite">
                      {tool === 'select' && 'Select a point and drag it, or use the arrow keys. Press Delete to remove the shape.'}
                      {tool === 'stop' && `Press at one end of the ${APPROACH_NAMES[ap]} stop line and drag to the other end.`}
                      {tool === 'upstream' && `Draw the ${APPROACH_NAMES[ap]} upstream line about 40 to 60 m before the stop line.`}
                      {tool === 'zone' && `Click the corners of the ${APPROACH_NAMES[ap]} queue zone. Press Enter or double-click to finish.`}
                    </p>
                  </section>
                )}
              </>
            )}

            {step === 2 && (
              <>
                {isCounts ? (
                  <EmptyState title="A counts file needs no calibration" body="Calibration turns pixels into metres for speeds. Continue to the next step." />
                ) : (
                  <section className="stack-sm" aria-labelledby="cal-h">
                    <h2 id="cal-h" className="sr-only">
                      Calibrate
                    </h2>
                    <div className="toolbar" role="toolbar" aria-label="Calibration tools">
                      {toolBtn('calibrate', 'Place a calibration point', 'calibrate')}
                      {toolBtn('select', 'Select and move points', 'cursor')}
                      <Button
                        variant="quiet"
                        icon="trash"
                        onClick={() => {
                          setCalPoints([]);
                          setTool('calibrate');
                        }}
                      >
                        Clear points
                      </Button>
                      <span className="muted tnum">{cal.length} of 4 placed</span>
                    </div>
                    {isVideo && video.url && <VideoScrub />}
                    <GeometryEditor frame={frame} background={background} geometry={draft.geometry} onGeometry={setGeometry} tool={tool === 'select' ? 'select' : 'calibrate'} approach={ap} calPoints={cal} onCalPoints={setCalPoints} H={fit?.H} visible={{ geometry: false, calibration: true }} onMessage={(m) => toast(m)} />
                    <p className="muted">Click four corners of a rectangle on the road, in order around it. A pedestrian crossing and a stretch of lane marking work well.</p>
                  </section>
                )}
              </>
            )}

            {step === 3 && (
              <section className="panel stack" aria-labelledby="tim-h">
                <h2 id="tim-h">Observed signal timing</h2>
                <p className="muted">Watch the video with a stopwatch and enter what the existing signal does. This becomes the current plan that SignalTwin is compared against.</p>
                <div className="field">
                  <span className="field-label">Phases</span>
                  <Segmented label="Number of phases" value={observed.fourPhase ? 4 : 2} options={[{ value: 2, label: 'Two phases, NS and EW' }, { value: 4, label: 'Four phases, one approach each' }]} onChange={(v) => setTiming({ fourPhase: v === 4, greens: Array.from({ length: v }, (_, i) => greens[i] ?? greens[greens.length - 1]) })} />
                </div>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  {greens.map((g, i) => (
                    <div key={i} style={{ width: 160 }}>
                      <NumberField label={`Green, ${observed.fourPhase ? APPROACH_NAMES[APPROACHES[i]] : i === 0 ? 'North and South' : 'East and West'}`} value={g} min={1} max={180} unit="s" onChange={(n) => setTiming({ greens: greens.map((x, j) => (j === i ? n : x)) })} />
                    </div>
                  ))}
                  <div style={{ width: 140 }}>
                    <NumberField label="Yellow" value={observed.yellow} min={1} max={10} step={0.5} unit="s" onChange={(n) => setTiming({ yellow: n })} />
                  </div>
                  <div style={{ width: 140 }}>
                    <NumberField label="All red" value={observed.allRed} min={0} max={10} step={0.5} unit="s" onChange={(n) => setTiming({ allRed: n })} />
                  </div>
                </div>
                {timingErr && (
                  <p className="field-error" role="alert">
                    {timingErr}
                  </p>
                )}
                <Stopwatch
                  video={isVideo && !!video.url}
                  phases={greens.map((_, i) => (observed.fourPhase ? APPROACH_NAMES[APPROACHES[i]] : i === 0 ? 'North and South' : 'East and West'))}
                  onUse={(i, s) => setTiming({ greens: greens.map((x, j) => (j === i ? Math.round(s) : x)) })}
                  background={isVideo && video.url ? <VideoStage url={video.url} compact /> : null}
                />
              </section>
            )}

            {step === 4 && (
              <ReviewStep
                draft={draft}
                setName={(name) => setDraft({ ...draft, name })}
                counts={cg}
                missing={{ stop: missingStop.length, up: missingUp.length, zone: missingZone.length }}
                calOk={calOk}
                rms={fit?.rms}
                isCounts={isCounts}
                isSample={isSample}
                timingOk={!timingErr}
                greens={greens}
                onSave={save}
              />
            )}

            </Swap>

            <div className="row-between panel">
              <div className="row">
                <Button variant="secondary" onClick={() => go(Math.max(0, step - 1))} disabled={step === 0} disabledReason="This is the first step.">
                  Back
                </Button>
                {step < 4 ? (
                  <Button variant="primary" onClick={() => go(step + 1)} disabled={!!reason} disabledReason={reason ?? undefined}>
                    Continue
                  </Button>
                ) : (
                  <Button variant="primary" onClick={save} disabled={!draft.name.trim()} disabledReason="Give the junction a name first.">
                    Save junction
                  </Button>
                )}
              </div>
              <div className="row">
                {reason && step < 4 && <span className="field-error">{reason}</span>}
                <Button variant="quiet" onClick={saveDraft}>
                  Save draft
                </Button>
                <Button variant="quiet" onClick={resetStep}>
                  Reset step
                </Button>
              </div>
            </div>
          </div>

          <aside className="stack" aria-label="Step details">
            {step === 1 && (
              <section className="panel">
                <h2>Drawing status</h2>
                <ul className="status-list" style={{ marginTop: 8 }}>
                  <li>
                    <span>Stop lines</span>
                    <span className={cg.stop === 4 ? 'status-ok' : 'status-miss'}>{cg.stop} of 4</span>
                  </li>
                  <li>
                    <span>Upstream lines</span>
                    <span className={cg.up === 4 ? 'status-ok' : 'status-miss'}>{cg.up} of 4</span>
                  </li>
                  <li>
                    <span>Queue zones</span>
                    <span className={cg.zone === 4 ? 'status-ok' : 'status-warn'}>{cg.zone} of 4</span>
                  </li>
                </ul>
                {!isCounts && <p className="muted" style={{ marginTop: 12 }}>Queue zones are optional but give the best queue length. The upstream line counts arrivals and the stop line counts departures.</p>}
                {isSample && (
                  <p className="muted" style={{ marginTop: 12 }}>
                    The sample junction comes with its shapes already drawn. Edit them or clear them to practise.
                  </p>
                )}
              </section>
            )}
            {step === 2 && !isCounts && (
              <CalibrationPanel cal={cal} dists={dists} setDists={setDists} fit={fit} collinear={collinear} stop={draft.geometry.stopLines.N} />
            )}
            {step === 3 && (
              <section className="panel">
                <h2>Why this matters</h2>
                <p className="muted" style={{ marginTop: 8 }}>
                  The cycle you enter here is what the digital twin replays as the current plan. The Webster plan and the SignalTwin plan are tested against it on identical traffic.
                </p>
                <p className="tnum" style={{ marginTop: 12 }}>
                  Cycle length: <strong>{greens.reduce((a, b) => a + b, 0) + nPhases * (observed.yellow + observed.allRed)} s</strong>
                </p>
              </section>
            )}
            {(step === 0 || step === 4) && (
              <section className="panel">
                <h2>Where this goes</h2>
                <p className="muted" style={{ marginTop: 8 }}>
                  Saved junctions stay in this browser. Nothing is sent to a server. Once saved, open <Link to="/perception">Perception</Link> to see what the system sees.
                </p>
              </section>
            )}
          </aside>
        </div>
      </div>
      <Footer />
      <Dialog open={importOpen} title="Import a junction" onClose={() => setImportOpen(false)}>
        <p>Choose a JSON file exported from the Setup page.</p>
        <FileDrop accept="application/json,.json" label="Drop a JSON file here" hint="Exported from this page." onFile={importJson} error={importErr} icon="upload" />
      </Dialog>
      {confirmNode}
      {msg && <span className="sr-only">{msg}</span>}
    </>
  );
}

/* -------------------------------------------------------------- video bits */
function VideoStage({ url, compact }: { url: string; compact?: boolean }) {
  return (
    <video id="setup-video" src={url} muted playsInline preload="auto" controls={compact} style={{ display: 'block', width: '100%', height: 'auto', background: '#000' }} aria-label="The junction video" />
  );
}
function VideoPoster({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const f = () => {
      v.currentTime = Math.min(1, v.duration / 3);
    };
    v.addEventListener('loadedmetadata', f);
    return () => v.removeEventListener('loadedmetadata', f);
  }, [url]);
  return <video ref={ref} src={url} muted preload="metadata" style={{ maxWidth: 420, width: '100%', background: '#000' }} aria-label="Poster frame of the video" />;
}
function VideoScrub() {
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const v = document.getElementById('setup-video') as HTMLVideoElement | null;
    if (!v) return;
    const upd = () => {
      setT(v.currentTime);
      setDur(v.duration || 0);
      setPlaying(!v.paused);
    };
    v.addEventListener('timeupdate', upd);
    v.addEventListener('loadedmetadata', upd);
    v.addEventListener('play', upd);
    v.addEventListener('pause', upd);
    upd();
    return () => {
      v.removeEventListener('timeupdate', upd);
      v.removeEventListener('loadedmetadata', upd);
      v.removeEventListener('play', upd);
      v.removeEventListener('pause', upd);
    };
  }, []);
  const vid = () => document.getElementById('setup-video') as HTMLVideoElement | null;
  return (
    <div className="row" role="group" aria-label="Choose a frame">
      <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause video' : 'Play video'} onClick={() => (vid()?.paused ? vid()?.play() : vid()?.pause())} />
      <IconButton icon="step" label="Step forward one frame" onClick={() => vid() && (vid()!.currentTime += 1 / 30)} />
      <input className="slider" style={{ flex: 1, minWidth: 160 }} type="range" min={0} max={dur || 1} step={0.04} value={t} aria-label="Video frame" onChange={(e) => vid() && (vid()!.currentTime = Number(e.target.value))} />
      <span className="tnum muted">
        {t.toFixed(1)} of {dur.toFixed(1)} s
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- stopwatch */
function Stopwatch({ video, phases, onUse, background }: { video: boolean; phases: string[]; onUse: (i: number, s: number) => void; background: React.ReactNode }) {
  const [running, setRunning] = useState(false);
  const [start, setStart] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [last, setLast] = useState<number | null>(null);
  const now = () => {
    const v = video ? (document.getElementById('setup-video') as HTMLVideoElement | null) : null;
    return v ? v.currentTime : performance.now() / 1000;
  };
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setElapsed(now() - start), 100);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, start]);
  return (
    <div className="stack-sm" style={{ borderTop: '1px solid var(--rule)', paddingTop: 16 }}>
      <h3>Stopwatch helper</h3>
      <p className="muted">{video ? 'Play the video. Press Mark green start when a green begins and Mark green end when it ends.' : 'Press Mark green start and Mark green end while you watch, or type the numbers above.'}</p>
      {background}
      <div className="row">
        <Button
          variant="secondary"
          icon="stopwatch"
          onClick={() => {
            setStart(now());
            setElapsed(0);
            setRunning(true);
            setLast(null);
          }}
          disabled={running}
          disabledReason="Already timing. Mark green end first."
        >
          Mark green start
        </Button>
        <Button
          variant="secondary"
          icon="stopwatch"
          onClick={() => {
            const d = now() - start;
            setRunning(false);
            setElapsed(d);
            setLast(d);
          }}
          disabled={!running}
          disabledReason="Mark green start first."
        >
          Mark green end
        </Button>
        <span className="tnum" aria-live="off">
          {elapsed.toFixed(1)} s
        </span>
      </div>
      {last !== null && (
        <div className="row">
          <span>Measured {last.toFixed(1)} s. Use it as the green for</span>
          {phases.map((p, i) => (
            <Button key={p} size="sm" variant="secondary" onClick={() => onUse(i, last)}>
              {p}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- calibration */
function CalibrationPanel({ cal, dists, setDists, fit, collinear, stop }: { cal: Point[]; dists: number[]; setDists: (d: number[]) => void; fit: ReturnType<typeof fitCalibration>; collinear: boolean; stop?: { a: Point; b: Point } }) {
  const labels = ['P1 to P2', 'P2 to P3', 'P3 to P4', 'P4 to P1'];
  const [t, setT] = useState(0);
  const had4 = useRef(false);
  useEffect(() => {
    if (cal.length === 4 && !had4.current) {
      had4.current = true;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) return setT(1);
      const t0 = performance.now();
      let raf = 0;
      const tick = (n: number) => {
        const k = Math.min(1, (n - t0) / 500);
        setT(1 - Math.pow(1 - k, 3));
        if (k < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    if (cal.length < 4) {
      had4.current = false;
      setT(0);
    }
  }, [cal.length]);
  const mpp = fit && stop ? metresPerPixel(fit.H, { x: (stop.a.x + stop.b.x) / 2, y: (stop.a.y + stop.b.y) / 2 }) : null;
  const size = 220;
  const topDown = (() => {
    if (!fit) return null;
    const pad = 20;
    const s = Math.min((size - pad * 2) / fit.width, (size - pad * 2) / fit.height);
    return cal.map((p) => {
      const m = applyH(fit.H, p);
      return { x: pad + m.x * s, y: pad + m.y * s };
    });
  })();
  const norm = (() => {
    if (cal.length < 4) return null;
    const xs = cal.map((p) => p.x);
    const ys = cal.map((p) => p.y);
    const minx = Math.min(...xs),
      maxx = Math.max(...xs),
      miny = Math.min(...ys),
      maxy = Math.max(...ys);
    const s = Math.min((size - 40) / Math.max(1, maxx - minx), (size - 40) / Math.max(1, maxy - miny));
    return cal.map((p) => ({ x: 20 + (p.x - minx) * s, y: 20 + (p.y - miny) * s }));
  })();
  const poly = norm && topDown ? norm.map((p, i) => ({ x: p.x + (topDown[i].x - p.x) * t, y: p.y + (topDown[i].y - p.y) * t })) : null;
  return (
    <section className="panel stack" aria-labelledby="cal-p">
      <h2 id="cal-p">Real distances</h2>
      <p className="muted">Enter the real length in metres of each side of the rectangle you marked.</p>
      {labels.map((l, i) => (
        <NumberField key={l} label={l} value={dists[i]} min={0} max={500} step={0.1} unit="m" onChange={(n) => setDists(dists.map((d, j) => (j === i ? n : d)))} />
      ))}
      {collinear && (
        <p className="field-error" role="alert">
          The points are nearly in a straight line. Move them to the corners of a rectangle on the road.
        </p>
      )}
      {fit && (
        <ul className="status-list tnum">
          <li>
            <span>Fit error</span>
            <span className={fit.rms < 0.5 ? 'status-ok' : 'status-warn'}>{fit.rms.toFixed(2)} m RMS</span>
          </li>
          <li>
            <span>Opposite sides differ by</span>
            <span className={fit.mismatch < 0.1 ? 'status-ok' : 'status-warn'}>{(fit.mismatch * 100).toFixed(0)} percent</span>
          </li>
          {mpp !== null && (
            <li>
              <span>Metres per pixel at the North stop line</span>
              <span>{mpp.toFixed(3)}</span>
            </li>
          )}
          <li>
            <span>Marked area</span>
            <span>{polyArea(cal) > 0 ? `${(fit.width * fit.height).toFixed(0)} m2` : 'none'}</span>
          </li>
        </ul>
      )}
      <div>
        <strong>Top-down preview</strong>
        {poly ? (
          <svg width={size} height={size} role="img" aria-label="Top-down preview of the marked rectangle" style={{ display: 'block', background: 'var(--asphalt)', marginTop: 8 }}>
            <polygon points={poly.map((p) => `${p.x},${p.y}`).join(' ')} fill="var(--asphalt-2)" stroke="var(--marking)" strokeWidth="2" />
            {poly.map((p, i) => (
              <text key={i} x={p.x + 6} y={p.y - 6} fill="var(--marking)" fontSize="12" fontWeight="700">
                P{i + 1}
              </text>
            ))}
            {t >= 1 && fit && <text x={size / 2} y={size - 6} fill="var(--marking)" fontSize="12" textAnchor="middle">{fit.width.toFixed(1)} m by {fit.height.toFixed(1)} m</text>}
          </svg>
        ) : (
          <p className="muted">Place all four points and enter the distances to see the road from above.</p>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- review */
function ReviewStep({
  draft,
  setName,
  counts,
  missing,
  calOk,
  rms,
  isCounts,
  isSample,
  timingOk,
  greens,
  onSave,
}: {
  draft: JunctionConfig;
  setName: (n: string) => void;
  counts: { stop: number; up: number; zone: number };
  missing: { stop: number; up: number; zone: number };
  calOk: boolean;
  rms?: number;
  isCounts: boolean;
  isSample: boolean;
  timingOk: boolean;
  greens: number[];
  onSave: () => void;
}) {
  const setup = useSetup(SCENARIOS.A);
  const profile = useMemo(() => profileFor(setup), [setup]);
  const factory = useCallback(() => [makeSim(setup, 'observed', 3, profile)], [setup, profile]);
  const runner = useRunner(factory, 600, [factory]);
  useEffect(() => {
    runner.setSpeed(4);
    runner.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const item = (label: string, state: 'Complete' | 'Missing' | 'Needs attention' | 'Not needed', detail?: string) => (
    <li key={label}>
      <span>
        {label}
        {detail && <span className="muted">, {detail}</span>}
      </span>
      <span className={state === 'Complete' || state === 'Not needed' ? 'status-ok' : state === 'Missing' ? 'status-miss' : 'status-warn'}>{state}</span>
    </li>
  );
  const geo = isCounts || isSample;
  return (
    <div className="stack">
      <section className="panel stack" aria-labelledby="rev-h">
        <h2 id="rev-h">Review</h2>
        <div style={{ maxWidth: 420 }}>
          <label className="field-label" htmlFor="jname">
            Junction name
          </label>
          <input id="jname" className="input" value={draft.name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-invalid={!draft.name.trim()} />
          {!draft.name.trim() && <span className="field-error">Give the junction a name.</span>}
        </div>
        <div className="table-wrap">
          <table className="table" aria-label="Junction summary">
            <tbody>
              <tr>
                <th scope="row">Source</th>
                <td>{isSample ? 'Sample junction' : isCounts ? `Counts file, ${draft.countsRows} rows` : `Video, ${draft.videoName ?? 'not loaded'}`}</td>
              </tr>
              <tr>
                <th scope="row">Phases</th>
                <td>{draft.observed.fourPhase ? 'Four, one approach each' : 'Two, NS and EW'}</td>
              </tr>
              <tr>
                <th scope="row">Observed green</th>
                <td className="tnum">{greens.join(' s, ')} s</td>
              </tr>
              <tr>
                <th scope="row">Yellow and all red</th>
                <td className="tnum">
                  {draft.observed.yellow} s and {draft.observed.allRed} s
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <h3>Checklist</h3>
        <ul className="status-list">
          {item('Source', 'Complete')}
          {item('Stop lines', geo ? 'Not needed' : missing.stop === 0 ? 'Complete' : 'Missing', geo ? undefined : `${counts.stop} of 4`)}
          {item('Upstream lines', geo ? 'Not needed' : missing.up === 0 ? 'Complete' : 'Missing', geo ? undefined : `${counts.up} of 4`)}
          {item('Queue zones', geo ? 'Not needed' : missing.zone === 0 ? 'Complete' : 'Needs attention', geo ? undefined : `${counts.zone} of 4, optional`)}
          {item('Calibration', isCounts ? 'Not needed' : calOk ? 'Complete' : 'Needs attention', rms !== undefined ? `fit error ${rms.toFixed(2)} m` : undefined)}
          {item('Observed timing', timingOk ? 'Complete' : 'Needs attention')}
        </ul>
        <div className="row">
          <Button variant="primary" onClick={onSave} disabled={!draft.name.trim()} disabledReason="Give the junction a name first.">
            Save junction
          </Button>
          <span className="muted">Sample run preview of the current plan on the right.</span>
        </div>
      </section>
      <section className="panel-asphalt on-asphalt" style={{ maxWidth: 360 }}>
        <JunctionView runner={runner} simIndex={0} caption="Current plan, as entered" overlays={{ labels: true }} />
      </section>
    </div>
  );
}

export { dist };
