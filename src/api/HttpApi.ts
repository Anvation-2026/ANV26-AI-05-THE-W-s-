import { PerceptionSchema, type CountsRow, type DemandEstimate, type JunctionConfig, type Params, type PerceptionResult, type SimRequest, type SimResult } from '../contracts';
import { Cancelled, type ExperimentRequest, type ExperimentResult, type Progress } from '../engine/experiment';
import { baseUrl, useBackend } from './backend';
import { ApiProblem, networkProblem, type Problem } from './problem';
import { NotConnectedError, type AnalyseOutcome, type AnalyseProgress, type AnalyseRequest, type SignalTwinApi } from './SignalTwinApi';

export interface VideoInfo {
  videoId: string;
  sha256: string;
  filename: string;
  sizeBytes: number;
  durationS: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  warnings: string[];
  deduplicated?: boolean;
}

interface JobView {
  jobId: string;
  videoId: string;
  state: 'queued' | 'probing' | 'decoding' | 'detecting' | 'postprocessing' | 'done' | 'error' | 'cancelled';
  progress: { fraction?: number; message?: string; etaS?: number; eta_s?: number; processed_s?: number; total_s?: number };
  error: Problem | null;
  fromCache: boolean;
}

const headers = (extra: Record<string, string> = {}): Record<string, string> => {
  const k = useBackend.getState().apiKey;
  return k ? { 'X-API-Key': k, ...extra } : extra;
};

async function readProblem(res: Response): Promise<ApiProblem> {
  let body: Partial<Problem> | null = null;
  try {
    body = (await res.json()) as Partial<Problem>;
  } catch {
    /* not JSON: a proxy page or an empty body */
  }
  if (body && body.title && body.fix) {
    const retry = Number(res.headers.get('Retry-After'));
    return new ApiProblem({ code: body.code ?? 'error', status: res.status, title: body.title, detail: body.detail ?? '', fix: body.fix, correlationId: body.correlationId ?? res.headers.get('X-Correlation-Id') ?? undefined, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : body.retryAfterS });
  }
  const gateway = res.status === 502 || res.status === 503 || res.status === 504;
  return new ApiProblem({
    code: gateway ? 'unavailable' : 'error',
    status: res.status,
    title: gateway ? 'The server is not available' : 'The server sent an unexpected answer',
    detail: `It answered with status ${res.status}.`,
    fix: gateway ? 'Wait a minute and try again. If the back end was just started, it may still be loading.' : 'Try again. If it keeps happening, check the server log.',
    correlationId: res.headers.get('X-Correlation-Id') ?? undefined,
  });
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, { ...init, headers: headers((init.headers as Record<string, string>) ?? {}) });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    void useBackend.getState().check();
    throw networkProblem(baseUrl());
  }
  if (!res.ok) throw await readProblem(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Uploads with progress. XMLHttpRequest is used because fetch cannot report upload progress. */
function uploadVideo(file: File, onProgress: (loaded: number, total: number) => void, signal: AbortSignal): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl()}/v1/videos`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    const key = useBackend.getState().apiKey;
    if (key) xhr.setRequestHeader('X-API-Key', key);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onerror = () => reject(networkProblem(baseUrl()));
    xhr.ontimeout = () => reject(networkProblem(baseUrl()));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* handled below */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) return resolve(body as VideoInfo);
      const b = (body ?? {}) as Partial<Problem>;
      const retry = Number(xhr.getResponseHeader('Retry-After'));
      reject(
        b.title && b.fix
          ? new ApiProblem({ code: b.code ?? 'error', status: xhr.status, title: b.title, detail: b.detail ?? '', fix: b.fix, correlationId: b.correlationId, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : undefined })
          : new ApiProblem({ code: 'error', status: xhr.status, title: 'The upload failed', detail: `The server answered with status ${xhr.status}.`, fix: 'Try again. If it keeps happening, check the server log.' }),
      );
    };
    if (signal.aborted) return reject(new DOMException('Upload cancelled', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

interface SseEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

/** Reads server-sent events with fetch, so the API key header can be sent. Reconnects with Last-Event-ID. */
async function streamEvents(jobId: string, onEvent: (e: SseEvent) => void, signal: AbortSignal): Promise<void> {
  let lastId = 0;
  let failures = 0;
  const terminal = new Set(['done', 'error', 'cancelled']);
  while (!signal.aborted) {
    try {
      const res = await fetch(`${baseUrl()}/v1/jobs/${jobId}/events`, { headers: headers({ Accept: 'text/event-stream', ...(lastId ? { 'Last-Event-ID': String(lastId) } : {}) }), signal });
      if (!res.ok || !res.body) throw await readProblem(res);
      failures = 0;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let cur: { id?: string; event?: string; data: string[] } = { data: [] };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            if (cur.event && cur.data.length) {
              const id = cur.id ? Number(cur.id) : lastId;
              if (Number.isFinite(id)) lastId = Math.max(lastId, id);
              let data: Record<string, unknown> = {};
              try {
                data = JSON.parse(cur.data.join('\n')) as Record<string, unknown>;
              } catch {
                /* ignore a malformed event */
              }
              onEvent({ id, type: cur.event, data });
              if (terminal.has(cur.event)) return;
            }
            cur = { data: [] };
          } else if (line.startsWith(':')) {
            continue;
          } else {
            const i = line.indexOf(':');
            const field = i < 0 ? line : line.slice(0, i);
            const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
            if (field === 'id') cur.id = val;
            else if (field === 'event') cur.event = val;
            else if (field === 'data') cur.data.push(val);
          }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiProblem && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      failures++;
      if (failures > 6) throw e instanceof ApiProblem ? e : networkProblem(baseUrl());
    }
    await new Promise((r) => setTimeout(r, Math.min(4000, 500 * 2 ** failures)));
  }
}

type FinalJob = { state: JobView['state']; error: Problem | null; fromCache: boolean };

/**
 * Follows a job until it ends. Events come over a stream; a slow poll is the safety net in case a proxy holds the
 * stream back. Resolves with the final state. Rejects only when the stream itself cannot be kept up.
 */
function followJob(jobId: string, start: FinalJob, signal: AbortSignal, onEvent: (e: SseEvent) => void): Promise<FinalJob> {
  return new Promise<FinalJob>((resolve, reject) => {
    let final: FinalJob = start;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const poll = window.setInterval(async () => {
      try {
        const j = await call<JobView>(`/v1/jobs/${jobId}`, { signal });
        if (j.state === 'done' || j.state === 'error' || j.state === 'cancelled') {
          final = { state: j.state, error: j.error, fromCache: j.fromCache };
          ctrl.abort();
          resolve(final);
        }
      } catch {
        /* the stream reports real failures */
      }
    }, 5000);
    streamEvents(
      jobId,
      (ev) => {
        onEvent(ev);
        if (ev.type === 'done') final = { state: 'done', error: null, fromCache: ev.data.fromCache === true };
        else if (ev.type === 'error') final = { state: 'error', error: (ev.data.problem ?? null) as Problem | null, fromCache: false };
        else if (ev.type === 'cancelled') final = { state: 'cancelled', error: null, fromCache: false };
      },
      ctrl.signal,
    )
      .then(() => resolve(final))
      .catch(reject)
      .finally(() => {
        window.clearInterval(poll);
        signal.removeEventListener('abort', onAbort);
      });
  });
}

const problemOf = (p: Problem | null): ApiProblem =>
  new ApiProblem(p ?? { code: 'job_failed', status: 500, title: 'The job failed', detail: 'The server did not say why.', fix: 'Try again.' });

async function fetchResult<T>(jobId: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(`${baseUrl()}/v1/jobs/${jobId}/result`, { headers: headers(), signal });
  if (!res.ok) throw await readProblem(res);
  return (await res.json()) as T;
}

const STAGE_SPAN: Record<string, [number, number]> = { upload: [0, 0.15], queued: [0.15, 0.17], decoding: [0.17, 0.2], detecting: [0.2, 0.93], postprocessing: [0.93, 0.97], download: [0.97, 1] };
const mb = (n: number) => `${(n / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB`;

export class HttpApi implements SignalTwinApi {
  getJunction(): never {
    throw new NotConnectedError('Reading the junction from the server');
  }
  saveJunction(): never {
    throw new NotConnectedError('Saving the junction to the server');
  }

  async deleteServerVideo(videoId: string): Promise<void> {
    if (!baseUrl()) return; // no server is configured, so there is nothing to delete
    try {
      await call<void>(`/v1/videos/${encodeURIComponent(videoId)}`, { method: 'DELETE' });
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 404) return; // already gone is the goal
      throw e;
    }
  }

  async analyseVideo(req: AnalyseRequest): Promise<AnalyseOutcome> {
    const { file, junction, params, signal, onProgress } = req;
    const emit = (stage: AnalyseProgress['stage'], fraction: number, message: string, extra: Partial<AnalyseProgress> = {}) => {
      const [a, b] = STAGE_SPAN[stage];
      onProgress({ stage, fraction, overall: a + (b - a) * Math.max(0, Math.min(1, fraction)), message, ...extra });
    };
    let jobId = '';
    const abort = () => {
      if (jobId) void fetch(`${baseUrl()}/v1/jobs/${jobId}/cancel`, { method: 'POST', headers: headers() }).catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      // 1. upload (skipped when the same file is already on the server in this session)
      let video: VideoInfo | null = null;
      if (req.knownVideoId) {
        try {
          video = await call<VideoInfo>(`/v1/videos/${encodeURIComponent(req.knownVideoId)}`, { signal });
        } catch (e) {
          if (!(e instanceof ApiProblem && e.status === 404)) throw e;
        }
      }
      if (!video) {
        emit('upload', 0, `Uploading ${file.name}`);
        video = await uploadVideo(file, (l, t) => emit('upload', l / t, `Uploading ${file.name}: ${mb(l)} of ${mb(t)}`), signal);
      }
      emit('upload', 1, 'Upload finished');

      // 2. job
      const created = await call<JobView>('/v1/perception/jobs', { ...json({ videoId: video.videoId, junction, params, options: req.model ? { model: req.model } : {} }), signal });
      jobId = created.jobId;
      let final: FinalJob = { state: created.state, error: created.error, fromCache: created.fromCache };
      if (created.state !== 'done') {
        emit('queued', 0, 'Waiting for a free analysis slot');
        final = await followJob(jobId, final, signal, (ev) => {
          const d = ev.data;
          if (ev.type === 'queued') emit('queued', 0, typeof d.position === 'number' && d.position > 1 ? `Waiting for a free analysis slot, place ${d.position}` : 'Waiting for a free analysis slot', { position: typeof d.position === 'number' ? d.position : undefined });
          else if (ev.type === 'state') {
            const st = String(d.state);
            if (st === 'decoding' || st === 'probing') emit('decoding', 0, 'Reading the video');
            else if (st === 'detecting') emit('detecting', 0, 'Finding and tracking vehicles');
            else if (st === 'postprocessing') emit('postprocessing', 0, 'Measuring queues, speeds and saturation flow');
          } else if (ev.type === 'progress') {
            const stage = (d.stage as AnalyseProgress['stage']) in STAGE_SPAN ? (d.stage as AnalyseProgress['stage']) : 'detecting';
            emit(stage, typeof d.fraction === 'number' ? d.fraction : 0, typeof d.message === 'string' ? d.message : 'Analysing', { etaS: typeof d.eta_s === 'number' ? d.eta_s : undefined });
          }
        });
      }
      if (signal.aborted || final.state === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
      if (final.state === 'error') throw problemOf(final.error);

      // 3. result
      emit('download', 0, 'Downloading the result');
      const result = PerceptionSchema.parse(await fetchResult<unknown>(jobId, signal)) as PerceptionResult;
      emit('download', 1, 'Done');
      return { result, videoId: video.videoId, jobId, fromCache: final.fromCache || created.fromCache };
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async estimateDemand(
    src: { kind: 'sample' } | { kind: 'counts'; rows: CountsRow[] } | { kind: 'perception'; result: PerceptionResult },
    junction: JunctionConfig,
    params: Params,
    smoothing?: number,
    binSeconds?: number,
  ): Promise<DemandEstimate> {
    if (src.kind === 'sample') throw new NotConnectedError('The sample junction is computed in the browser, so this');
    // The server only needs counts and the last frame time, so the bulky frames stay in the browser.
    const source =
      src.kind === 'counts'
        ? src
        : { kind: 'perception' as const, result: { ...src.result, frames: [{ t: src.result.frames.reduce((m, f) => Math.max(m, f.t), 0), detections: [] }], meta: undefined, queue: undefined, speeds: undefined, departures: undefined } };
    const e = await call<DemandEstimate>('/v1/demand/estimate', json({ source, junction, params, smoothing, binSeconds }));
    return { ...e, computedBy: 'server' };
  }

  runSimulation(req: SimRequest): Promise<SimResult> {
    return call<SimResult>('/v1/simulate', json(req));
  }

  runExperiment(req: ExperimentRequest, onProgress: (p: Progress) => void): { promise: Promise<ExperimentResult>; cancel: () => void } {
    const ctrl = new AbortController();
    let jobId = '';
    const promise = (async (): Promise<ExperimentResult> => {
      const created = await call<JobView>('/v1/experiments', { ...json(req), signal: ctrl.signal });
      jobId = created.jobId;
      let final: FinalJob = { state: created.state, error: created.error, fromCache: created.fromCache };
      if (created.state !== 'done') {
        final = await followJob(jobId, final, ctrl.signal, (ev) => {
          const d = ev.data;
          if (ev.type === 'progress' && typeof d.total === 'number' && d.total > 0) onProgress({ done: Number(d.done ?? 0), total: d.total, label: String(d.message ?? 'Running') });
        });
      }
      if (ctrl.signal.aborted || final.state === 'cancelled') throw new Cancelled();
      if (final.state === 'error') throw problemOf(final.error);
      return fetchResult<ExperimentResult>(jobId, ctrl.signal);
    })();
    return {
      promise,
      cancel: () => {
        ctrl.abort();
        if (jobId) void fetch(`${baseUrl()}/v1/jobs/${jobId}/cancel`, { method: 'POST', headers: headers() }).catch(() => undefined);
      },
    };
  }
}

export const httpApi = new HttpApi();
