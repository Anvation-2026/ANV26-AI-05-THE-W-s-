import { Link } from 'react-router-dom';
import { Button, toast, useConfirm } from '../components/ui';
import { clearAllLocalData, useApp } from '../store/app';
import { useBackend } from '../api/backend';
import { clearUploadConsent } from '../lib/consent';
import { deleteMyVideoAndResults } from '../lib/serverData';
import { useVideo } from '../store/video';
import { Footer } from '../shell/Layout';

const UPDATED = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

export function Terms() {
  return (
    <>
      <div className="page">
        <div className="legal">
          <h1>Terms of service</h1>
          <p className="muted" style={{ marginTop: 8 }}>
            Last updated {UPDATED}.
          </p>
          <h2>What this is</h2>
          <p>SignalTwin is a prototype built for a hackathon. It estimates traffic demand from video or counts, simulates a junction, and recommends a signal plan. It is provided to explore and compare plans, nothing more.</p>
          <h2>Not for operating a signal</h2>
          <p>Do not use SignalTwin to operate, adjust or approve the timing of any real traffic signal. The plans it produces are recommendations from a simulation. They have not been certified for safety. A qualified traffic engineer must review any change before it reaches the road.</p>
          <h2>Results are simulation outputs</h2>
          <p>Every result depends on the video or counts you provide, the timing you enter and the assumptions on the Parameters page. Vehicle size, people per vehicle and saturation flow are assumptions. The simulator is a simplified queue model. It does not predict exact travel times on a real road.</p>
          <h2>Your data</h2>
          <p>You keep ownership of your videos, counts and junction files. Counts files and the sample junction are processed in your browser. A video is uploaded to the SignalTwin back end only when you press Analyse video, after a notice that asks you to agree. You can delete it at any time. See the <Link to="/privacy">Privacy policy</Link> for what is stored, where and for how long.</p>
          <h2>Acceptable use</h2>
          <ul>
            <li>Use only video you are allowed to use. Check the licence of any footage before using it in a public demo.</li>
            <li>Do not use SignalTwin to identify people or track individuals. It counts and classifies vehicles.</li>
            <li>Only upload video that you have the right to upload. Footage taken in a public place can still show faces and number plates.</li>
            <li>Do not attempt to disrupt the service or use it in a way that breaks the law.</li>
          </ul>
          <h2>No warranty</h2>
          <p>SignalTwin is provided as is, without warranty of any kind. The team is not liable for decisions made using its output.</p>
          <h2>Changes</h2>
          <p>These terms may change as the project grows. The date above shows the latest version.</p>
          <h2>Contact</h2>
          <p>[Team contact to be added before launch.]</p>
        </div>
      </div>
      <Footer />
    </>
  );
}

export function Privacy() {
  const { ask, node } = useConfirm();
  const clearVideo = useVideo((s) => s.clear);
  const serverVideo = useApp((s) => s.serverVideo);
  const status = useBackend((s) => s.status);
  const limits = useBackend((s) => s.limits);
  const hours = limits?.retentionHours ?? 24;
  return (
    <>
      <div className="page">
        <div className="legal">
          <h1>Privacy policy</h1>
          <p className="muted" style={{ marginTop: 8 }}>
            Last updated {UPDATED}.
          </p>
          <h2>The short version</h2>
          <p>
            Your junction, settings and results stay in your browser. The one thing that can leave it is a video, and only when you press Analyse video and agree to the notice. Then the video is sent to the SignalTwin back end, kept for {hours} hours, and deleted automatically
            or when you ask. There are no accounts, no analytics and no advertising trackers.
          </p>
          <h2>What is sent to the back end</h2>
          <ul>
            <li>The video file you chose to analyse, and its name.</li>
            <li>The junction drawing: stop lines, upstream lines, queue zones, calibration points and the timing you entered.</li>
            <li>Counts and detections, when you ask for demand to be estimated while the back end is connected. These are numbers, not pictures.</li>
          </ul>
          <p>Nothing is sent for the sample junction or for a counts file you have not asked to be estimated. If the back end is not connected, nothing is sent at all and everything runs in your browser.</p>
          <h2>What the back end does with it</h2>
          <ul>
            <li>It finds and tracks vehicles in the video, counts them at your lines, and measures queues, waits, speeds and saturation flow. It does not look for faces or number plates and saves no pictures other than the video you sent, but they may be visible in that video.</li>
            <li>The video, the analysis and its result are stored on the server for {hours} hours, then deleted. The same video analysed again is recognised by a fingerprint of its contents so the earlier result can be reused.</li>
            <li>The server log records the time, the address of the request, the result code and a reference number. It does not record video content. Requests from one address are counted in memory to limit abuse and are forgotten when the server restarts.</li>
            <li>Who runs the back end decides where it is hosted. If you use a back end run by someone else, ask them about their storage and backups.</li>
          </ul>
          <h2>What is stored on your device</h2>
          <ul>
            <li>Your saved junction: name, geometry, calibration and observed timing.</li>
            <li>Parameters, applied demand and accepted calibration.</li>
            <li>Recent runs, up to eight, so you can restore them.</li>
            <li>The result of your last video analysis, so a reload does not lose it, and the reference needed to delete the server copy.</li>
            <li>A draft of an unfinished junction, if you pressed Save draft.</li>
            <li>Your theme choice, your answer to the upload notice, and the back end address if you changed it.</li>
          </ul>
          <p>The video file itself is held only in the open tab. It is gone when you close the tab. The other items live in your browser's storage and stay until you delete them.</p>
          <h2>Delete my video and results</h2>
          <p>
            This removes the video you uploaded, every analysis of it and its results from the server, and removes the saved result from this browser.{' '}
            {serverVideo ? `The video on record is ${serverVideo.filename}, uploaded ${new Date(serverVideo.uploadedAt).toLocaleString()}.` : 'No uploaded video is on record in this browser.'}
          </p>
          <div className="row" style={{ marginTop: 12 }}>
            <Button
              variant="danger"
              disabled={!serverVideo}
              disabledReason="No uploaded video is on record in this browser."
              onClick={async () => {
                if (await ask('Delete my video and results', 'The video and all its analyses are removed from the server, and the saved result is removed from this browser. This cannot be undone.', 'Delete video and results', true)) {
                  await deleteMyVideoAndResults();
                }
              }}
            >
              Delete my video and results
            </Button>
          </div>
          {serverVideo && status !== 'connected' && status !== 'degraded' && <p className="field-error">The back end is not reachable right now, so the server copy cannot be deleted yet. Start it or fix the address in Back end settings, then try again. The server also deletes it by itself after {hours} hours.</p>}
          <h2>Delete everything</h2>
          <p>This removes every item listed above from this browser, deletes the server copy of your video first if there is one, and resets the app to the sample junction.</p>
          <div className="row" style={{ marginTop: 12 }}>
            <Button
              variant="danger"
              onClick={async () => {
                if (await ask('Delete all data', 'Your uploaded video and its results on the server, and your saved junction, parameters, runs, draft and theme choice in this browser are removed. This cannot be undone.', 'Delete everything', true)) {
                  if (useApp.getState().serverVideo && !(await deleteMyVideoAndResults())) return; // keep the local record so the deletion can be retried
                  clearVideo();
                  clearUploadConsent();
                  try {
                    localStorage.removeItem('signaltwin-draft-v1');
                  } catch {
                    /* ignore */
                  }
                  clearAllLocalData();
                  toast('All data deleted.');
                }
              }}
            >
              Delete all data
            </Button>
          </div>
          <h2>Fonts</h2>
          <p>Fonts are bundled with the app, so loading the page does not contact a font service.</p>
          <h2>Contact</h2>
          <p>[Team contact to be added before launch.]</p>
        </div>
      </div>
      <Footer />
      {node}
    </>
  );
}

export function NotFound() {
  return (
    <>
      <section className="notfound" aria-labelledby="nf-h">
        <div>
          <div className="notfound-code" aria-hidden="true">
            404
          </div>
        </div>
        <div className="stack">
          <h1 id="nf-h">This page does not exist</h1>
          <p>The address may be mistyped, or the page may have moved. These pages are available:</p>
          <div className="row">
            <Link to="/console" className="btn btn-primary">
              Console
            </Link>
            <Link to="/setup" className="btn btn-secondary">
              Setup
            </Link>
            <Link to="/method" className="btn btn-secondary">
              Method
            </Link>
            <Link to="/" className="btn btn-quiet">
              Home
            </Link>
          </div>
        </div>
      </section>
      <Footer />
    </>
  );
}
