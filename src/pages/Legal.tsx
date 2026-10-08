import { Link } from 'react-router-dom';
import { Button, toast, useConfirm } from '../components/ui';
import { clearAllLocalData } from '../store/app';
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
          <p>You keep ownership of your videos, counts and junction files. This version processes them in your browser and does not upload them. See the <Link to="/privacy">Privacy policy</Link> for what is stored on your device.</p>
          <h2>Acceptable use</h2>
          <ul>
            <li>Use only video you are allowed to use. Check the licence of any footage before using it in a public demo.</li>
            <li>Do not use SignalTwin to identify people or track individuals. It counts and classifies vehicles.</li>
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
  return (
    <>
      <div className="page">
        <div className="legal">
          <h1>Privacy policy</h1>
          <p className="muted" style={{ marginTop: 8 }}>
            Last updated {UPDATED}.
          </p>
          <h2>The short version</h2>
          <p>This version of SignalTwin runs in your browser. Your videos and files are read on your device and are not uploaded. There are no accounts, no analytics and no advertising trackers.</p>
          <h2>What is processed</h2>
          <p>Videos, counts files and junction files you choose are opened by your browser. Detection, counting and simulation use your device's processor. Nothing is sent to a server.</p>
          <h2>What is stored on your device</h2>
          <ul>
            <li>Your saved junction: name, geometry, calibration and observed timing.</li>
            <li>Parameters, applied demand and accepted calibration.</li>
            <li>Recent runs, up to eight, so you can restore them.</li>
            <li>A draft of an unfinished junction, if you pressed Save draft.</li>
            <li>Your theme choice.</li>
          </ul>
          <p>An uploaded video itself is held only in the open tab. It is gone when you close the tab. The values above live in your browser's local storage and stay until you delete them.</p>
          <h2>Delete everything</h2>
          <p>This removes every item listed above from this browser and resets the app to the sample junction.</p>
          <div className="row" style={{ marginTop: 12 }}>
            <Button
              variant="danger"
              onClick={async () => {
                if (await ask('Delete all local data', 'Your saved junction, parameters, runs, draft and theme choice are removed from this browser. This cannot be undone.', 'Delete everything', true)) {
                  clearVideo();
                  try {
                    localStorage.removeItem('signaltwin-draft-v1');
                  } catch {
                    /* ignore */
                  }
                  clearAllLocalData();
                  toast('All local data deleted.');
                }
              }}
            >
              Delete all local data
            </Button>
          </div>
          <h2>If a back end is connected later</h2>
          <p>A future version may send videos to a server to detect vehicles. If that happens, this page will say what is sent, where it is processed and how long it is kept, and the app will tell you before anything leaves your device.</p>
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
