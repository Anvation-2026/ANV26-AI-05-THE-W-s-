import { useState } from 'react';
import { useBackend } from '../api';
import { Button, Dialog, Segmented } from './ui';

export function BackendBadge({ onClick }: { onClick: () => void }) {
  const status = useBackend((s) => s.status);
  const text = status === 'connected' ? 'Back end connected' : status === 'checking' ? 'Checking back end' : status === 'degraded' ? 'Back end needs a model' : 'Back end not connected';
  const tone = status === 'connected' ? 'badge-sign' : status === 'degraded' ? '' : 'badge-plain';
  return (
    <button type="button" className={`badge badge-button ${tone}`} onClick={onClick} aria-haspopup="dialog" data-testid="backend-badge" title="Show the back end connection and settings">
      {text}
    </button>
  );
}

export function BackendDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { status, info, limits, error, urlOverride, setUrl, apiKey, setApiKey, check, simulation, setSimulation, checkedAt } = useBackend();
  const [url, setUrlDraft] = useState(urlOverride);
  const [key, setKey] = useState(apiKey);
  const [busy, setBusy] = useState(false);
  const recheck = async () => {
    setBusy(true);
    await check();
    setBusy(false);
  };
  const line = (label: string, value: string) => (
    <li key={label}>
      <span>{label}</span>
      <span>{value}</span>
    </li>
  );
  return (
    <Dialog
      open={open}
      title="Back end"
      onClose={onClose}
      actions={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p>
        {status === 'connected' && 'The back end is running. Video analysis is available, and demand estimates from counts or detections are computed there.'}
        {status === 'degraded' && 'The back end is running but its detection model file is missing, so it cannot analyse video. Demand estimates still work.'}
        {status === 'checking' && 'Checking the back end.'}
        {(status === 'offline' || status === 'none') && 'The back end is not connected. Everything except analysing an uploaded video works in the browser.'}
      </p>
      {status === 'offline' && error && (
        <p className="field-error">
          {error} Start the back end (see the README), or change the address below.
        </p>
      )}
      {info && (
        <ul className="status-list tnum" aria-label="Back end details">
          {line('Version', `${info.version}, pipeline ${info.pipelineVersion}`)}
          {line('Detector', `${info.model.detector}, ${info.model.name}${info.model.available ? '' : ' (missing)'}`)}
          {line('Analyses', `${info.queue.running} running, ${info.queue.queued} waiting, ${info.queue.workers} at a time`)}
          {line('Storage', `${info.storage.kind}, ${info.storage.freeGb} GB free`)}
          {limits && line('Limits', `${limits.maxUploadMb} MB, ${Math.round(limits.maxDurationS / 60)} min, kept ${limits.retentionHours} h`)}
          {checkedAt > 0 && line('Last checked', new Date(checkedAt).toLocaleTimeString())}
        </ul>
      )}
      <div className="stack-sm">
        <label className="field-label" htmlFor="be-url">
          Back end address
        </label>
        <input id="be-url" className="input" value={url} placeholder="http://localhost:8000" onChange={(e) => setUrlDraft(e.target.value)} spellCheck={false} />
        <span className="muted">Leave empty to use the address this app was built with.</span>
        {info?.authRequired && (
          <>
            <label className="field-label" htmlFor="be-key">
              Access key
            </label>
            <input id="be-key" className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
            <span className="muted">Kept for this tab only.</span>
          </>
        )}
        <div className="row">
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              if (key !== apiKey) setApiKey(key);
              if (url.trim() !== urlOverride) setUrl(url.trim());
              else void recheck();
            }}
          >
            Check again
          </Button>
        </div>
      </div>
      <div className="stack-sm">
        <span className="field-label">Where simulations run</span>
        <Segmented
          label="Where simulations run"
          value={simulation}
          options={[
            { value: 'browser', label: 'In this browser' },
            { value: 'server', label: 'On the back end', disabledReason: status === 'connected' || status === 'degraded' ? undefined : 'The back end is not connected.' },
          ]}
          onChange={setSimulation}
        />
        <span className="muted">The browser is the default and the reference. The back end runs the same rules and gives the same numbers, which its tests check against the browser. It is slower for a single run and useful for large experiments.</span>
      </div>
    </Dialog>
  );
}
