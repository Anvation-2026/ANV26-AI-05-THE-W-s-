import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { APPROACHES, type JunctionConfig } from '../contracts';
import { api, friendlyError, useBackend, type AnalyseProgress } from '../api';
import type { Friendly } from '../api/problem';
import { useApp } from '../store/app';
import { useVideo } from '../store/video';
import { putResult } from '../store/results';
import { giveUploadConsent, hasUploadConsent } from '../lib/consent';
import { Badge, Button, Dialog, Meter, toast } from './ui';

const fileKeyOf = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

const STAGE_LABEL: Record<AnalyseProgress['stage'], string> = {
  upload: 'Uploading',
  queued: 'Waiting for a free slot',
  decoding: 'Reading the video',
  detecting: 'Finding and tracking vehicles',
  postprocessing: 'Measuring queues and speeds',
  download: 'Downloading the result',
};

function eta(s?: number): string {
  if (s === undefined || !Number.isFinite(s)) return '';
  if (s < 90) return `about ${Math.max(1, Math.round(s))} s left`;
  return `about ${Math.round(s / 60)} min left`;
}

/**
 * Sends the person's video to the back end and follows the analysis to the end.
 * `prepare` saves the junction as drawn and returns it, or returns a reason why the drawing cannot be used yet.
 */
export function AnalysePanel({ prepare }: { prepare: () => { junction: JunctionConfig } | { reason: string } }) {
  const status = useBackend((s) => s.status);
  const limits = useBackend((s) => s.limits);
  const video = useVideo();
  const params = useApp((s) => s.params);
  const serverVideo = useApp((s) => s.serverVideo);
  const perception = useApp((s) => s.perception);
  const origin = useApp((s) => s.perceptionOrigin);
  const setPerception = useApp((s) => s.setPerception);
  const setServerVideo = useApp((s) => s.setServerVideo);
  const [phase, setPhase] = useState<'idle' | 'running' | 'error' | 'done'>(perception && origin === 'backend' ? 'done' : 'idle');
  const [prog, setProg] = useState<AnalyseProgress | null>(null);
  const [err, setErr] = useState<Friendly | null>(null);
  const [consent, setConsent] = useState(false);
  const [cached, setCached] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const file = video.file;
  const tooLong = limits && video.size && video.size.duration > limits.maxDurationS;
  const tooBig = limits && file && file.size > limits.maxUploadMb * 1048576;
  const disabledReason =
    status === 'none' || status === 'offline'
      ? 'The back end is not connected. Start it (see the README), then press Check again in the Back end settings.'
      : status === 'checking'
        ? 'Checking the back end.'
        : status === 'degraded'
          ? 'The back end is running but its detection model is missing, so it cannot analyse video.'
          : !file
            ? 'Choose the video file again in step 1. Videos are not kept in the browser between visits.'
            : tooBig
              ? `The video is over the ${limits?.maxUploadMb} MB limit. Trim it or lower its resolution.`
              : tooLong
                ? `The video is longer than the ${Math.round((limits?.maxDurationS ?? 0) / 60)} minute limit. Trim it first.`
                : undefined;

  const run = async () => {
    if (!file) return;
    const prepared = prepare();
    if ('reason' in prepared) {
      setErr({ title: 'The junction drawing is not ready', detail: prepared.reason, fix: 'Go back to the earlier steps, complete them, and try again.' });
      setPhase('error');
      return;
    }
    const c = new AbortController();
    ctrl.current = c;
    setErr(null);
    setCached(false);
    setProg({ stage: 'upload', fraction: 0, overall: 0, message: `Uploading ${file.name}` });
    setPhase('running');
    try {
      const key = fileKeyOf(file);
      const out = await api.analyseVideo({
        file,
        junction: prepared.junction,
        params,
        signal: c.signal,
        onProgress: setProg,
        knownVideoId: serverVideo?.fileKey === key ? serverVideo.videoId : undefined,
      });
      const resultKey = `result-${out.jobId}`;
      const stored = await putResult(resultKey, out.result);
      if (!stored) toast('The result is too large for this browser to keep. It stays in memory until you close the tab.', 'error');
      setServerVideo({ videoId: out.videoId, filename: file.name, size: file.size, fileKey: key, uploadedAt: new Date().toISOString(), jobId: out.jobId, resultKey: stored ? resultKey : undefined });
      setPerception(out.result, 'backend');
      setCached(out.fromCache);
      setPhase('done');
      toast(out.fromCache ? 'Reused an earlier analysis of this video.' : 'Analysis finished.');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setPhase('idle');
        setProg(null);
        toast('Analysis cancelled.');
        return;
      }
      setErr(friendlyError(e));
      setPhase('error');
    } finally {
      ctrl.current = null;
    }
  };

  const start = () => {
    if (!hasUploadConsent()) return setConsent(true);
    void run();
  };

  const counts = perception?.counts ?? [];
  const up = counts.filter((c) => c.line === 'upstream').length;
  const q = perception?.quality;

  return (
    <section className="panel stack" aria-labelledby="an-h">
      <div className="row-between">
        <h2 id="an-h">Analyse the video</h2>
        <Badge tone={status === 'connected' ? 'sign' : 'plain'}>{status === 'connected' ? 'Back end connected' : status === 'checking' ? 'Checking the back end' : 'Back end not connected'}</Badge>
      </div>
      <p className="muted">
        Sends your video to the back end, which finds and tracks vehicles, counts them at your lines and measures queues, waits, speeds and saturation flow.
        {limits ? ` Up to ${limits.maxUploadMb} MB and ${Math.round(limits.maxDurationS / 60)} minutes. Kept for ${limits.retentionHours} hours, or until you delete it.` : ''}
      </p>

      {phase === 'running' && prog && (
        <div className="stack-sm" role="status" aria-live="polite" data-testid="analyse-progress">
          <Meter value={prog.overall} max={1} label="Analysis progress" />
          <div className="row-between">
            <span>
              <strong>{STAGE_LABEL[prog.stage]}.</strong> {prog.message}
            </span>
            <span className="muted tnum">
              {Math.round(prog.overall * 100)} percent{prog.etaS !== undefined ? `, ${eta(prog.etaS)}` : ''}
            </span>
          </div>
          <div className="row">
            <Button variant="secondary" onClick={() => ctrl.current?.abort()}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {phase === 'error' && err && (
        <div className="error-state" role="alert" data-testid="analyse-error">
          <h3>{err.title}</h3>
          <p>{err.detail}</p>
          <p>
            <strong>What to do:</strong> {err.fix}
          </p>
          {err.reference && <p className="muted tnum">Reference {err.reference}</p>}
        </div>
      )}

      {phase === 'done' && perception && (
        <div className="stack-sm" data-testid="analyse-done">
          <ul className="status-list tnum">
            <li>
              <span>Vehicles counted on the upstream lines</span>
              <span>{up.toLocaleString()}</span>
            </li>
            <li>
              <span>Counts by approach</span>
              <span>{APPROACHES.map((a) => `${a} ${counts.filter((c) => c.line === 'upstream' && c.approach === a).length}`).join(', ')}</span>
            </li>
            {perception.meta && (
              <li>
                <span>Analysed</span>
                <span>
                  {perception.meta.durationS.toFixed(0)} s of video in {perception.meta.processingS.toFixed(0)} s{cached ? ', reused from an earlier run' : ''}
                </span>
              </li>
            )}
            {q && (
              <li>
                <span>Risk of missed counts</span>
                <span>{q.missedCountRisk}</span>
              </li>
            )}
            <li>
              <span>Inbound lanes assumed per approach</span>
              <span>{params.lanes}, change on Parameters and analyse again if wrong</span>
            </li>
          </ul>
          {(up === 0 || q?.missedCountRisk === 'high') && (
            <div className="error-state" role="alert" data-testid="analyse-poor">
              <h3>{up === 0 ? 'No vehicles were counted' : 'This analysis is probably incomplete'}</h3>
              <p>The detector missed most vehicles, so counts, queues and the twin built from them would be wrong. Do not use them for decisions.</p>
              <p>
                <strong>What to do:</strong> read the first warning below, use footage that suits the detector, and check that the lines are drawn across the lanes where vehicles drive.
              </p>
            </div>
          )}
          {q && q.warnings.length > 0 && (
            <ul>
              {q.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="row">
        {phase !== 'running' && (
          <Button variant="primary" icon="play" onClick={start} disabled={!!disabledReason} disabledReason={disabledReason}>
            {phase === 'done' ? 'Analyse again' : 'Analyse video'}
          </Button>
        )}
        {phase === 'done' && (
          <>
            <Link className="btn btn-secondary" to="/perception">
              Open Perception
            </Link>
            <Link className="btn btn-secondary" to="/demand">
              Use in Demand
            </Link>
          </>
        )}
        {phase === 'error' && (
          <Button variant="secondary" onClick={start} disabled={!!disabledReason} disabledReason={disabledReason}>
            Try again
          </Button>
        )}
      </div>

      <Dialog
        open={consent}
        title="Before your video is uploaded"
        onClose={() => setConsent(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConsent(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                giveUploadConsent();
                setConsent(false);
                void run();
              }}
            >
              Upload and analyse
            </Button>
          </>
        }
      >
        <p>Your video will be sent to the SignalTwin back end and analysed there. Until now it has stayed in this browser.</p>
        <ul>
          <li>It is stored for {limits?.retentionHours ?? 24} hours and then deleted automatically.</li>
          <li>You can delete it and all results at any time with Delete my video and results on the Privacy page.</li>
          <li>The back end uses it only to analyse your junction.</li>
          <li>The back end does not look for faces or number plates and saves no pictures other than the video you send, but they may be visible in that video. Only upload footage you have the right to use.</li>
        </ul>
      </Dialog>
    </section>
  );
}
