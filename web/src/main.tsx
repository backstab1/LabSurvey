import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Runner } from './runner/Runner.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import './styles.css';

// Админка и дашборд грузятся отдельными файлами — респонденты скачивают только код опроса
const AdminApp = lazy(() => import('./admin/AdminApp.tsx').then((m) => ({ default: m.AdminApp })));
const Dashboard = lazy(() => import('./dashboard/Dashboard.tsx').then((m) => ({ default: m.Dashboard })));

const path = window.location.pathname;
const survey = path.match(/^\/s\/([\w-]+)/);
const dash = path.match(/^\/d\/([\w-]+)/);

if (!survey && !dash && !path.startsWith('/admin')) window.history.replaceState(null, '', '/admin');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {survey
      ? <ErrorBoundary title="Не удалось показать опрос"><Runner surveyId={survey[1]} /></ErrorBoundary>
      : dash
        ? <ErrorBoundary title="Не удалось показать дашборд"><Suspense fallback={null}><Dashboard token={dash[1]} /></Suspense></ErrorBoundary>
        : <ErrorBoundary><Suspense fallback={null}><AdminApp /></Suspense></ErrorBoundary>}
  </StrictMode>,
);
