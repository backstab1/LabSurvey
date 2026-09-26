import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import { QuestionView } from './QuestionView.tsx';
import { runScript, type ScriptEnv } from './scripts.ts';
import { rich } from './rich.tsx';
import { actionError, allQuestions, answerText, blockOf, findPage, findQuestion, isQuestionVisible, nextPage, pipe, resolveOptions } from '../../../shared/logic.ts';
import { validateAnswer } from '../../../shared/answers.ts';
import { expandLoops, withLoops } from '../../../shared/loops.ts';
import {
  DEFAULT_SETTINGS, END, settingsOf, type Answer, type AnswerValue, type Answers, type Page, type RespondentContext, type Survey,
} from '../../../shared/types.ts';

interface RunnerState {
  rid: string;
  status: string;
  preview: boolean;
  survey: Survey;
  params: Record<string, string>;
  answers: Answers;
  page: string | null;
  canBack: boolean;
  progress: number;
  step: number;
  message?: string;
  redirect?: string;
  deadline?: string;
}

type Loaded =
  | { kind: 'state'; state: RunnerState }
  | { kind: 'closed'; title: string; message: string }
  | { kind: 'password'; title: string; error?: string }
  | { kind: 'error'; message: string };

/** Опрос открыт внутри iframe на чужом сайте */
const embedded = (() => { try { return window.self !== window.top; } catch { return true; } })();

/** Сообщает сайту-родителю высоту страницы — чтобы iframe подстраивался без прокрутки */
function useEmbedHeight() {
  useEffect(() => {
    if (!embedded) return;
    document.documentElement.classList.add('embedded');
    // Высота содержимого, а не окна — иначе iframe сможет только расти
    const send = () => window.parent.postMessage({ type: 'surveylab:height', height: Math.ceil(document.body.getBoundingClientRect().height) }, '*');
    const ro = new ResizeObserver(send);
    ro.observe(document.body);
    send();
    return () => ro.disconnect();
  }, []);
}

export function Runner({ surveyId }: { surveyId: string }) {
  useEmbedHeight();
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const test = query.get('test') ?? undefined;
  const preview = query.get('preview') === '1' || !!test;
  const storageKey = `sl:${surveyId}:${preview ? 'preview' : 'live'}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [checking, setChecking] = useState(false);

  const applyState = (state: RunnerState) => {
    try { localStorage.setItem(storageKey, state.rid); } catch { /* приватный режим */ }
    setLoaded({ kind: 'state', state });
    document.title = state.survey.title;
    window.scrollTo(0, 0);
  };

  const start = (password?: string) => {
    let rid: string | null = null;
    // В предпросмотре new=1 — всегда новая сессия; в опросе — просьба пройти ещё раз (сервер решает, можно ли)
    const fresh = query.get('new') === '1';
    try { rid = fresh && preview ? null : localStorage.getItem(storageKey); } catch { /* */ }
    const params: Record<string, string> = {};
    query.forEach((v, k) => { params[k] = v; });
    const startAt = preview ? query.get('start') ?? undefined : undefined;
    setChecking(true);
    api('POST', `/api/s/${surveyId}/start`, { rid, params, preview: preview && !test, test, startAt, restart: fresh && !preview, password })
      .then((res) => {
        if (res.closed) setLoaded({ kind: 'closed', title: res.title, message: res.message });
        else if (res.needPassword) setLoaded({ kind: 'password', title: res.title, error: res.error });
        else applyState(res);
      })
      .catch((e) => setLoaded({ kind: 'error', message: e instanceof ApiError && e.status === 404 ? 'Опрос не найден' : e.message }))
      .finally(() => setChecking(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { start(); }, []);

  if (!loaded) return <div className="runner"><div className="runner-card muted">Загрузка…</div></div>;
  if (loaded.kind === 'error') return <Final title="SurveyLAB" message={loaded.message} />;
  if (loaded.kind === 'closed') return <Final title={loaded.title} message={loaded.message} />;
  if (loaded.kind === 'password') return <PasswordGate title={loaded.title} error={loaded.error} busy={checking} onSubmit={start} />;

  const { state } = loaded;
  // Циклы разворачиваются по ответам — экран повтора (Q6_3) есть только в развёрнутой анкете
  const page = state.page ? findPage(expandLoops(state.survey, state.answers, state.params, state.rid), state.page) : null;
  return (
    <>
      {state.survey.css && <style>{state.survey.css}</style>}
      {page
        ? <PageView key={`${state.rid}:${page.id}:${state.progress}`} state={state} page={page} surveyId={surveyId} onState={applyState} onExpire={() => start()} />
        : <Final survey={state.survey} title={state.survey.title} message={state.message ?? DEFAULT_SETTINGS.completeMessage}
            preview={state.preview} redirect={state.redirect} />}
    </>
  );
}

/** Предпросмотр: что сейчас известно движку — для проверки логики, подстановок и формул */
function DebugPanel({ ctx, pageId }: { ctx: RespondentContext; pageId: string }) {
  const rows = allQuestions(ctx.survey).filter((q) => ctx.answers[q.id] !== undefined);
  const params = Object.entries(ctx.params);
  return (
    <details className="debug-panel">
      <summary>Отладка: вопрос {pageId} · ответов {rows.length}</summary>
      <table>
        <tbody>
          {rows.map((q) => (
            <tr key={q.id}>
              <td className="mono">{q.id}</td>
              <td>{q.type === 'hidden' ? <em>переменная</em> : null} {answerText(ctx, q) || JSON.stringify(ctx.answers[q.id].v)}</td>
            </tr>
          ))}
          {params.map(([k, v]) => <tr key={k}><td className="mono">?{k}</td><td>{v}</td></tr>)}
        </tbody>
      </table>
      {!rows.length && !params.length && <p>Ответов пока нет.</p>}
    </details>
  );
}

/** Оставшееся время; по истечении сервер завершает анкету — перезапрашиваем состояние */
function Countdown({ deadline, onExpire }: { deadline: string; onExpire: () => void }) {
  const end = Date.parse(deadline);
  const [left, setLeft] = useState(() => Math.max(0, Math.round((end - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) { clearInterval(t); setTimeout(onExpire, 6000); }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [end]);
  return (
    <div className={`countdown${left < 60 ? ' urgent' : ''}`} role="timer" aria-live={left < 60 ? 'polite' : 'off'}>
      Осталось {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </div>
  );
}

/** Оформление из настроек: цвет, логотип, подвал */
function Shell({ survey, className, children }: { survey?: Survey; className?: string; children: ReactNode }) {
  const st = survey ? settingsOf(survey) : DEFAULT_SETTINGS;
  const style = st.accentColor
    ? { '--accent': st.accentColor, '--accent-soft': `color-mix(in srgb, ${st.accentColor} 12%, white)` } as CSSProperties
    : undefined;
  return (
    <div className={`runner${className ? ` ${className}` : ''}`} style={style}>
      {st.logoUrl && <div className="runner-logo"><img src={st.logoUrl} alt="" /></div>}
      {children}
      {st.footerText && <div className="runner-footer">{rich(st.footerText)}</div>}
    </div>
  );
}

function PasswordGate({ title, error, busy, onSubmit }: { title: string; error?: string; busy: boolean; onSubmit: (p: string) => void }) {
  const [value, setValue] = useState('');
  useEffect(() => { document.title = title; }, [title]);
  return (
    <div className="runner">
      <form className="runner-card final" onSubmit={(e) => { e.preventDefault(); if (value) onSubmit(value); }}>
        <h1>{title}</h1>
        <p className="muted">Опрос защищён паролем</p>
        <input className="input password-input" type="password" autoFocus autoComplete="off" placeholder="Пароль"
          value={value} onChange={(e) => setValue(e.target.value)} aria-label="Пароль" />
        {error && <div className="q-error" role="alert">{error}</div>}
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy || !value}>Начать</button>
      </form>
    </div>
  );
}

function PageView({ state, page, surveyId, onState, onExpire }: {
  state: RunnerState; page: Page; surveyId: string; onState: (s: RunnerState) => void; onExpire: () => void;
}) {
  const { survey } = state;
  const settings = settingsOf(survey);

  // Ответы текущей страницы + значения, выставленные скриптами
  const [local, setLocal] = useState<Answers>(() => {
    const init: Answers = {};
    for (const q of page.questions) if (state.answers[q.id]) init[q.id] = state.answers[q.id];
    return init;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pageError, setPageError] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);

  const answers: Answers = { ...state.answers, ...local };
  // Стёртые на этой странице ответы не должны подтягиваться из сохранённых
  for (const q of page.questions) if (q.type !== 'hidden' && !local[q.id]) delete answers[q.id];
  const ctx: RespondentContext = withLoops({ survey, answers, params: state.params, seed: state.rid });

  const visible = page.questions.filter((q) => q.type !== 'hidden' && isQuestionVisible(ctx, q));
  const isLast = nextPage(ctx, page.id) === END;

  const setValue = (id: string, v: AnswerValue | undefined) => {
    setLocal((prev) => {
      const next = { ...prev };
      if (v === undefined) delete next[id];
      else next[id] = { ...prev[id], v };
      return next;
    });
  };
  const env = (c: RespondentContext = ctx): ScriptEnv => ({ ctx: c, pageId: page.id, preview: state.preview, setValue });

  // Скрипты показа: init и onShow страницы — один раз; onShow вопроса — когда он появился
  const shown = useRef(new Set<string>());
  const envRef = useRef(env);
  envRef.current = env;
  // init и beforeShow — до отрисовки (layout effect), чтобы значения из sl.set успели попасть на экран
  const prepared = useRef(new Set<string>());
  const visibleKey = visible.map((q) => q.id).join(',');
  const initDone = useRef(false);
  useLayoutEffect(() => {
    if (!initDone.current) {
      initDone.current = true;
      runScript(survey.scripts?.init, 'init (анкета)', envRef.current());
    }
    for (const q of visible) {
      if (prepared.current.has(q.id)) continue;
      prepared.current.add(q.id);
      runScript(q.scripts?.beforeShow, `beforeShow (${q.id})`, envRef.current(), { question: q.id, value: answers[q.id]?.v });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);
  useEffect(() => {
    runScript(page.scripts?.onShow, `onShow (${page.id})`, envRef.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    for (const q of visible) {
      if (shown.current.has(q.id)) continue;
      shown.current.add(q.id);
      runScript(q.scripts?.onShow, `onShow (${q.id})`, envRef.current(), { question: q.id, value: answers[q.id]?.v });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  const setAnswer = (id: string, a: Answer | undefined) => {
    setLocal((prev) => {
      const next = { ...prev };
      if (a === undefined) delete next[id];
      else next[id] = a;
      return next;
    });
    if (errors[id]) setErrors((e) => ({ ...e, [id]: '' }));
    const q = page.questions.find((x) => x.id === id);
    // Автопереход: единственный вопрос на странице, выбран обычный вариант (не «Другое»)
    if (q && (q.type === 'single' || q.type === 'dropdown' || q.type === 'scale') && (q.autoNext ?? settings.autoNext) && typeof a?.v === 'number'
      && visible.filter((x) => x.type !== 'info').length === 1
      && !resolveOptions(ctx, q, 0, false).find((o) => o.code === a.v)?.other) {
      setAutoSubmit(true);
    }
    if (q?.scripts?.onChange) {
      const nextAnswers = { ...answers };
      if (a === undefined) delete nextAnswers[id]; else nextAnswers[id] = a;
      runScript(q.scripts.onChange, `onChange (${id})`, env({ ...ctx, answers: nextAnswers }), { question: id, value: a?.v });
    }
  };

  // Небольшая пауза, чтобы респондент увидел свой выбор; вызываем актуальную версию send
  const sendRef = useRef<(a: 'submit') => void>(() => {});
  useEffect(() => {
    if (!autoSubmit) return;
    const t = setTimeout(() => { setAutoSubmit(false); sendRef.current('submit'); }, 300);
    return () => clearTimeout(t);
  }, [autoSubmit]);

  // Заголовок блока показывается над его вопросами
  const blockTitle = blockOf(ctx.survey, page.id)?.title;
  const hideBack = visible.some((q) => q.hideBack);
  const hideFinish = visible.some((q) => q.hideFinish);

  const payload = (): Answers => {
    const out: Answers = {};
    for (const q of visible) if (local[q.id]) out[q.id] = local[q.id];
    // Скрытые переменные любой страницы, выставленные скриптами
    for (const [id, a] of Object.entries(local)) {
      const q = findQuestion(ctx.survey, id);
      if (q?.type === 'hidden') out[id] = a;
    }
    return out;
  };

  const showErrors = (errs: Record<string, string>) => {
    setErrors(errs);
    const first = visible.find((q) => errs[q.id]);
    if (first) document.getElementById(`q-${first.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const send = async (action: 'submit' | 'back' | 'finish') => {
    if (busy) return;
    setPageError('');
    if (action === 'submit') {
      const errs: Record<string, string> = {};
      for (const q of visible) {
        const e = validateAnswer(ctx, q, local[q.id])
          ?? actionError(ctx, q)
          ?? (runScript(q.scripts?.validate, `validate (${q.id})`, env(), { question: q.id, value: local[q.id]?.v }) as string | undefined);
        if (typeof e === 'string' && e) errs[q.id] = e;
      }
      if (Object.keys(errs).length) return showErrors(errs);
      const pe = runScript(page.scripts?.onSubmit, `onSubmit (${page.id})`, env());
      if (typeof pe === 'string' && pe) return setPageError(pe);
    }
    if (action === 'finish' && !window.confirm('Завершить опрос? Вернуться к нему будет нельзя.')) return;
    setBusy(true);
    try {
      onState(await api('POST', `/api/s/${surveyId}/${action}`, { rid: state.rid, page: page.id, answers: payload() }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && e.data?.errors) showErrors(e.data.errors);
      else setPageError(e instanceof Error ? e.message : 'Ошибка сети. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  sendRef.current = send;

  const numbered = settings.showQuestionNumbers && visible.some((q) => q.type !== 'info');

  return (
    <Shell survey={survey} className={`page-${page.id}`}>
      {state.preview && <div className="preview-banner">Предпросмотр: ответы помечаются как тестовые</div>}
      {state.deadline && <Countdown deadline={state.deadline} onExpire={onExpire} />}
      {settings.showProgress && (
        <div className="progress" role="progressbar" aria-valuenow={state.progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-fill" style={{ width: `${state.progress}%` }} />
        </div>
      )}
      <div className="runner-card" onKeyDown={(e) => {
        // Enter в однострочном поле — «Далее»
        const t = e.target as HTMLElement;
        if (e.key === 'Enter' && settings.enterSubmits && t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox' && (t as HTMLInputElement).type !== 'radio') {
          e.preventDefault();
          send('submit');
        }
      }}>
        {blockTitle && <div className="page-title">{rich(pipe(blockTitle, ctx))}</div>}
        {numbered && <div className="q-number">Вопрос {state.step}</div>}
        {visible.map((q) => (
          <QuestionView key={q.id} q={q} ctx={ctx} answer={local[q.id]} error={errors[q.id]} onChange={(a) => setAnswer(q.id, a)} />
        ))}
        {pageError && <div className="q-error page-error" role="alert">{pageError}</div>}
        <div className="nav">
          {state.canBack && !hideBack && <button className="btn btn-secondary" disabled={busy} onClick={() => send('back')}>{settings.backLabel}</button>}
          <button className="btn btn-primary" disabled={busy} onClick={() => send('submit')}>{isLast ? settings.submitLabel : settings.nextLabel}</button>
        </div>
        {state.preview && <DebugPanel ctx={ctx} pageId={page.id} />}
        {settings.allowEarlyFinish && !hideFinish && (
          <div className="early-finish">
            <button className="btn-link" disabled={busy} onClick={() => send('finish')}>{settings.earlyFinishLabel}</button>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Final({ survey, title, message, preview, redirect }: {
  survey?: Survey; title: string; message: string; preview?: boolean; redirect?: string;
}) {
  useEffect(() => { document.title = title; }, [title]);
  // Редирект (панель и т. п.) — сразу, без показа сообщения. В предпросмотре только показываем адрес
  const go = !!redirect && !preview;
  useEffect(() => { if (go) window.location.replace(redirect!); }, [go, redirect]);
  const retake = preview || (survey && settingsOf(survey).allowRetake);
  return (
    <Shell survey={survey}>
      <div className="runner-card final">
        <h1>{title}</h1>
        {go ? <p className="muted">Переходим дальше…</p> : <p style={{ whiteSpace: 'pre-line' }}>{rich(message)}</p>}
        {preview && redirect && (
          <p className="preview-banner redirect-note">В опросе здесь будет переход на <a href={redirect} target="_blank" rel="noopener noreferrer">{redirect}</a></p>
        )}
        {retake && !go && (
          <button className="btn btn-secondary" onClick={() => {
            const u = new URL(window.location.href);
            u.searchParams.set('new', '1');
            window.location.href = u.toString();
          }}>Пройти ещё раз</button>
        )}
      </div>
    </Shell>
  );
}
