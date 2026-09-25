import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Runner } from './runner/Runner.tsx';
import './styles.css';

// Админка грузится отдельным файлом — респонденты скачивают только код опроса
const AdminApp = lazy(() => import('./admin/AdminApp.tsx').then((m) => ({ default: m.AdminApp })));

const path = window.location.pathname;
const survey = path.match(/^\/s\/([\w-]+)/);

if (!survey && !path.startsWith('/admin')) window.history.replaceState(null, '', '/admin');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {survey ? <Runner surveyId={survey[1]} /> : <Suspense fallback={null}><AdminApp /></Suspense>}
  </StrictMode>,
);
