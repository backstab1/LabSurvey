import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Runner } from './runner/Runner.tsx';
import { AdminApp } from './admin/AdminApp.tsx';
import './styles.css';

const path = window.location.pathname;
const survey = path.match(/^\/s\/([\w-]+)/);

if (!survey && !path.startsWith('/admin')) window.history.replaceState(null, '', '/admin');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{survey ? <Runner surveyId={survey[1]} /> : <AdminApp />}</StrictMode>,
);
