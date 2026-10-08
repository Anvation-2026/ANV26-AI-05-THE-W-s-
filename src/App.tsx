import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { ErrorBoundary, ErrorPage, Layout } from './shell/Layout';
import { ThemeContext, Skel } from './components/ui';

const Home = lazy(() => import('./pages/Home'));
const Setup = lazy(() => import('./pages/Setup'));
const Perception = lazy(() => import('./pages/Perception'));
const Demand = lazy(() => import('./pages/Demand'));
const Twin = lazy(() => import('./pages/Twin'));
const Controller = lazy(() => import('./pages/Controller'));
const Console = lazy(() => import('./pages/Console'));
const Experiments = lazy(() => import('./pages/Experiments'));
const Report = lazy(() => import('./pages/Report'));
const Parameters = lazy(() => import('./pages/Parameters'));
const Method = lazy(() => import('./pages/Method'));
const Terms = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Terms })));
const Privacy = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Privacy })));
const NotFound = lazy(() => import('./pages/Legal').then((m) => ({ default: m.NotFound })));

function PageSkeleton() {
  return (
    <div className="page" role="status" aria-label="Loading page">
      <div className="stack">
        <Skel w="28%" h={34} />
        <Skel w="55%" h={16} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 8 }}>
          <Skel h={300} />
          <Skel h={300} />
          <Skel h={300} />
        </div>
      </div>
    </div>
  );
}

const wrap = (el: JSX.Element) => <Suspense fallback={<PageSkeleton />}>{el}</Suspense>;

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: wrap(<Home />) },
      { path: '/setup', element: wrap(<Setup />) },
      { path: '/perception', element: wrap(<Perception />) },
      { path: '/demand', element: wrap(<Demand />) },
      { path: '/twin', element: wrap(<Twin />) },
      { path: '/controller', element: wrap(<Controller />) },
      { path: '/console', element: wrap(<Console />) },
      { path: '/experiments', element: wrap(<Experiments />) },
      { path: '/report', element: wrap(<Report />) },
      { path: '/parameters', element: wrap(<Parameters />) },
      { path: '/method', element: wrap(<Method />) },
      { path: '/terms', element: wrap(<Terms />) },
      { path: '/privacy', element: wrap(<Privacy />) },
      { path: '*', element: wrap(<NotFound />) },
    ],
  },
]);

function RouteError() {
  return <ErrorPage error={new Error('This page could not be shown.')} />;
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'));
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => {
      try {
        if (!localStorage.getItem('signaltwin-theme')) setTheme(mq.matches ? 'dark' : 'light');
      } catch {
        /* ignore */
      }
    };
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const n = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('signaltwin-theme', n);
      } catch {
        /* ignore */
      }
      return n;
    });
  }, []);
  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return (
    <ThemeContext.Provider value={value}>
      <ErrorBoundary>
        <RouterProvider router={router} />
      </ErrorBoundary>
    </ThemeContext.Provider>
  );
}
