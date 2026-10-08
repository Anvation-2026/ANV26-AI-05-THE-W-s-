import { useCallback, useEffect, useMemo, useRef, useState, Component, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BrandMark, Icon, type IconName } from '../components/Icon';
import { Button, Dialog, IconButton, ToastHost, toast, useConfirm, useTheme } from '../components/ui';
import { DEMOS, demoOf, isDemoId, leaveDemo, loadDemo, restoreDemo } from '../demos';
import { PatternDefs } from '../components/charts';
import { useApp, clearAllLocalData } from '../store/app';
import { getResult } from '../store/results';
import { startBackendMonitor } from '../api';
import { BackendBadge, BackendDialog } from '../components/BackendDialog';
import type { PerceptionResult } from '../contracts';
import { SAMPLE_JUNCTION, SCENARIOS } from '../engine/params';
import { useRunStatus } from './status';

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/setup', label: 'Setup', icon: 'drawZone' },
  { to: '/perception', label: 'Perception', icon: 'camera' },
  { to: '/demand', label: 'Demand', icon: 'chart' },
  { to: '/twin', label: 'Twin', icon: 'junction' },
  { to: '/controller', label: 'Controller', icon: 'balance' },
  { to: '/console', label: 'Console', icon: 'signal' },
  { to: '/experiments', label: 'Experiments', icon: 'flask' },
  { to: '/report', label: 'Report', icon: 'report' },
];
const NAV2: { to: string; label: string; icon: IconName }[] = [
  { to: '/parameters', label: 'Parameters', icon: 'settings' },
  { to: '/method', label: 'Method', icon: 'book' },
];
const TOOL_ROUTES = ['/setup', '/perception', '/demand', '/twin', '/controller', '/console', '/experiments', '/report', '/parameters'];

const GOTO: Record<string, string> = {
  s: '/setup',
  p: '/perception',
  d: '/demand',
  t: '/twin',
  k: '/controller',
  c: '/console',
  x: '/experiments',
  r: '/report',
  a: '/parameters',
  m: '/method',
  h: '/',
};

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play or pause the simulation'],
  ['[ and ]', 'Slower or faster'],
  ['R', 'Restart the simulation'],
  ['E', 'Send an emergency vehicle on the East approach'],
  ['G then H', 'Go to Home'],
  ['G then S', 'Go to Setup'],
  ['G then P', 'Go to Perception'],
  ['G then D', 'Go to Demand'],
  ['G then T', 'Go to Twin'],
  ['G then K', 'Go to Controller'],
  ['G then C', 'Go to Console'],
  ['G then X', 'Go to Experiments'],
  ['G then R', 'Go to Report'],
  ['G then A', 'Go to Parameters'],
  ['G then M', 'Go to Method'],
  ['?', 'Open this list'],
];

export const emit = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(`st:${name}`, { detail }));

/** Subscribe a page to the global keyboard commands. */
export function useCommands(h: { toggle?: () => void; speed?: (dir: 1 | -1) => void; restart?: () => void; emergency?: () => void }) {
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => {
    const on = (n: string, f: (e: Event) => void) => {
      window.addEventListener(`st:${n}`, f);
      return () => window.removeEventListener(`st:${n}`, f);
    };
    const offs = [
      on('toggle', () => ref.current.toggle?.()),
      on('speed', (e) => ref.current.speed?.((e as CustomEvent).detail)),
      on('restart', () => ref.current.restart?.()),
      on('emergency', () => ref.current.emergency?.()),
    ];
    return () => offs.forEach((o) => o());
  }, []);
}

function TopBar({ onShortcuts }: { onShortcuts: () => void }) {
  const { theme, toggle } = useTheme();
  const usingSample = useApp((s) => s.usingSample);
  const junction = useApp((s) => s.junction);
  const setJunction = useApp((s) => s.setJunction);
  const [which, setWhich] = useState<'current' | 'sample'>(usingSample ? 'sample' : 'current');
  const [backendOpen, setBackendOpen] = useState(false);
  const { ask, node: confirmNode } = useConfirm();
  useEffect(() => setWhich(usingSample ? 'sample' : 'current'), [usingSample]);
  return (
    <>
    <header className="topbar">
      <Link to="/" className="brand" aria-label="SignalTwin, go to Home">
        <BrandMark />
        <span>SignalTwin</span>
      </Link>
      <div className="topbar-spacer" />
      <label className="sr-only" htmlFor="junction-select">
        Junction
      </label>
      <select
        id="junction-select"
        className="topbar-select"
        value={isDemoId(junction.id) ? junction.id : which}
        onChange={async (e) => {
          const v = e.target.value;
          if (v === 'current') return;
          const ownWork = !usingSample && !isDemoId(junction.id);
          if (ownWork && !(await ask('Replace your junction', `Choosing this replaces "${junction.name}", which is saved in this browser. Export it from Setup first if you want to keep it.`, 'Replace it', true))) return;
          if (v === 'sample') {
            leaveDemo();
            setJunction(SAMPLE_JUNCTION, true);
            setWhich('sample');
            toast('Switched to the sample junction.');
            return;
          }
          const d = demoOf(v);
          if (!d) return;
          try {
            await loadDemo(d);
            toast(`${d.name} loaded, with its video and the analysis the back end made of it.`);
          } catch (err) {
            console.error('loading the example failed', err);
            toast('That example could not be loaded. Its analysis files are missing from public/demos. Run the app from the repository folder, or choose another junction.', 'error');
          }
        }}
      >
        {!usingSample && !isDemoId(junction.id) && <option value="current">{junction.name}</option>}
        <option value="sample">{SAMPLE_JUNCTION.name}</option>
        <optgroup label="Example videos">
          {DEMOS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </optgroup>
      </select>
      <span className="badge" title={usingSample ? 'Built-in data. Nothing here came from your video.' : isDemoId(junction.id) ? 'An example video with the analysis the back end made of it.' : 'Built from the files you provided.'}>
        {usingSample ? 'Sample junction' : isDemoId(junction.id) ? 'Example video' : 'Your junction'}
      </span>
      <BackendBadge onClick={() => setBackendOpen(true)} />
      <IconButton icon="keyboard" label="Keyboard shortcuts" onClick={onShortcuts} className="hide-mobile" />
      <IconButton icon="theme" label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle} />
    </header>
    {/* outside the header: the topbar gives its buttons a light text colour that would be unreadable on the dialog */}
    <BackendDialog open={backendOpen} onClose={() => setBackendOpen(false)} />
    {confirmNode}
    </>
  );
}

function Nav() {
  return (
    <nav className="nav" aria-label="Main">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'is-active' : ''}`} title={n.label}>
          <Icon name={n.icon} />
          <span className="nav-text">{n.label}</span>
        </NavLink>
      ))}
      <div className="nav-gap" />
      {NAV2.map((n) => (
        <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'is-active' : ''}`} title={n.label}>
          <Icon name={n.icon} />
          <span className="nav-text">{n.label}</span>
        </NavLink>
      ))}
      <div className="nav-foot">
        <Link to="/terms">Terms of service</Link>
        <Link to="/privacy">Privacy policy</Link>
      </div>
    </nav>
  );
}

function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Main, mobile">
      {[{ to: '/', label: 'Home', icon: 'junction' as IconName }, ...NAV, ...NAV2].map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'is-active' : '')} aria-label={n.label} title={n.label}>
          <Icon name={n.icon} />
        </NavLink>
      ))}
    </nav>
  );
}

function ContextBar() {
  const junction = useApp((s) => s.junction);
  const usingSample = useApp((s) => s.usingSample);
  const scenarioId = useApp((s) => s.scenarioId);
  const seed = useApp((s) => s.seed);
  const status = useRunStatus((s) => s.text);
  return (
    <dl className="contextbar" aria-label="Current context">
      <div className="ctx-item">
        <dt>Junction</dt>
        <dd>{junction.name}</dd>
      </div>
      <div className="ctx-item">
        <dt>Data</dt>
        <dd>{usingSample ? 'Sample junction' : isDemoId(junction.id) ? 'Example video' : junction.source === 'video' ? 'Your video' : junction.source === 'counts' ? 'Your counts file' : 'Your junction'}</dd>
      </div>
      <div className="ctx-item">
        <dt>Scenario</dt>
        <dd>{SCENARIOS[scenarioId].name}</dd>
      </div>
      <div className="ctx-item">
        <dt>Seed</dt>
        <dd className="tnum">{seed}</dd>
      </div>
      <div className="ctx-item">
        <dt>Status</dt>
        <dd aria-live="polite">{status}</dd>
      </div>
    </dl>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="stack-sm">
        <strong style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem' }}>SignalTwin</strong>
        <small>Recommends signal plans from video. It does not operate any signal.</small>
        <small>Contact: [team contact to be added before launch]</small>
      </div>
      <div className="footer-links">
        <Link to="/terms">Terms of service</Link>
        <Link to="/privacy">Privacy policy</Link>
        <Link to="/method">Method</Link>
      </div>
    </footer>
  );
}

export function Layout() {
  const loc = useLocation();
  const nav = useNavigate();
  const [help, setHelp] = useState(false);
  const online = useOnline();
  const isTool = TOOL_ROUTES.some((r) => loc.pathname.startsWith(r));
  const gMode = useRef(0);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    startBackendMonitor();
    if (isDemoId(useApp.getState().junction.id)) void restoreDemo().catch(() => undefined); // the saved junction is an example: bring back its video and analysis
    // bring back the analysis result that was saved in IndexedDB before the page was reloaded
    const st = useApp.getState();
    if (!st.perception && st.serverVideo?.resultKey && st.perceptionOrigin === 'backend') {
      void getResult<PerceptionResult>(st.serverVideo.resultKey).then((r) => {
        if (r && !useApp.getState().perception) useApp.getState().setPerception(r, 'backend');
      });
    }
  }, []);

  useEffect(() => {
    document.title = `${titleFor(loc.pathname)} | SignalTwin`;
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [loc.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (typing && !(el as HTMLInputElement).type?.match(/range|checkbox/)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (gMode.current && Date.now() - gMode.current < 1500) {
        gMode.current = 0;
        if (GOTO[k]) {
          e.preventDefault();
          nav(GOTO[k]);
        }
        return;
      }
      if (k === 'g') {
        gMode.current = Date.now();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setHelp(true);
      } else if (e.key === ' ' && el.tagName !== 'BUTTON' && el.tagName !== 'A') {
        e.preventDefault();
        emit('toggle');
      } else if (e.key === '[') emit('speed', -1);
      else if (e.key === ']') emit('speed', 1);
      else if (k === 'r') emit('restart');
      else if (k === 'e') emit('emergency');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav]);

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <PatternDefs />
      <div className="app">
        <TopBar onShortcuts={() => setHelp(true)} />
        <Nav />
        <main id="main" className="main" tabIndex={-1} ref={mainRef} style={{ outline: 'none' }}>
          {!online && (
            <div className="contextbar" role="status">
              You are offline. The sample junction and every simulation keep working.
            </div>
          )}
          {isTool && <ContextBar />}
          <Outlet />
        </main>
      </div>
      <BottomNav />
      <ToastHost />
      <Dialog open={help} title="Keyboard shortcuts" onClose={() => setHelp(false)}>
        <table className="table">
          <tbody>
            {SHORTCUTS.map(([k, d]) => (
              <tr key={k}>
                <td style={{ width: 130 }}>
                  <kbd>{k}</kbd>
                </td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Dialog>
    </>
  );
}

function useOnline() {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true);
    const b = () => setOn(false);
    window.addEventListener('online', a);
    window.addEventListener('offline', b);
    return () => {
      window.removeEventListener('online', a);
      window.removeEventListener('offline', b);
    };
  }, []);
  return on;
}

function titleFor(path: string): string {
  const all = [{ to: '/', label: 'Home' }, ...NAV, ...NAV2, { to: '/terms', label: 'Terms of service' }, { to: '/privacy', label: 'Privacy policy' }];
  return all.find((n) => (n.to === '/' ? path === '/' : path.startsWith(n.to)))?.label ?? 'Page not found';
}

/* ------------------------------------------------------------ error page */
export function ErrorPage({ error }: { error: Error }) {
  const [copied, setCopied] = useState(false);
  const details = `${error.name}: ${error.message}\n${error.stack ?? ''}`;
  return (
    <div className="page" role="alert">
      <div className="stack" style={{ maxWidth: 640 }}>
        <h1>This page stopped working</h1>
        <p>
          Something failed while drawing this view: <strong>{error.message || 'unknown error'}</strong>. Your saved junction and runs are still stored in this browser.
        </p>
        <div className="row">
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(details);
                setCopied(true);
              } catch {
                toast('Copy failed. Select the details below instead.', 'error');
              }
            }}
          >
            {copied ? 'Details copied' : 'Copy details'}
          </Button>
          <Button variant="secondary" onClick={() => location.reload()}>
            Reload page
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              clearAllLocalData();
              location.href = '/';
            }}
          >
            Reset local data
          </Button>
        </div>
        <pre className="panel" style={{ overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          {details}
        </pre>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <ErrorPage error={this.state.error} /> : this.props.children;
  }
}

export function useStableCallback<T extends (...a: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback(((...a: never[]) => ref.current(...a)) as T, []);
}
export const memo = useMemo;

