import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { QuestionView } from './QuestionView.tsx';
import { runScript, type ScriptEnv } from './scripts.ts';
import { rich } from './rich.tsx';
import { actionError, blockOf, findPage, findQuestion, isQuestionVisible, nextPage, pipe, resolveOptions } from '../../../shared/logic.ts';
import { validateAnswer } from '../../../shared/answers.ts';
import {
  DEFAULT_SETTINGS, END, type Answer, type AnswerValue, type Answers, type Page, type RespondentContext, type Survey,
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
  message?: string;
}

type Loaded =
  | { kind: 'state'; state: RunnerState }
  | { kind: 'closed'; title: string; message: string }
  | { kind: 'error'; message: string };

export function Runner({ surveyId }: { surveyId: string }) {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const preview = query.get('preview') === '1';
  const storageKey = `sl:${surveyId}:${preview ? 'preview' : 'live'}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const applyState = (state: RunnerState) => {
    try { localStorage.setItem(storageKey, state.rid); } catch { /* приватный режим */ }
    setLoaded({ kind: 'state', state });
    document.title = state.survey.title;
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    let rid: string | null = null;
    try { rid = query.get('new') === '1' ? null : localStorage.getItem(storageKey); } catch { /* */ }
    const params: Record<string, string> = {};
    query.forEach((v, k) => { params[k] = v; });
    const startAt = preview ? query.get('start') ?? undefined : undefined;
    api('POST', `/api/s/${surveyId}/start`, { rid, params, preview, startAt })
      .then((res) => (res.closed ? setLoaded({ kind: 'closed', title: res.title, message: res.message }) : applyState(res)))
      .catch((e) => setLoaded({ kind: 'error', message: e instanceof ApiError && e.status === 404 ? 'Опрос не найден' : e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!loaded) return <div className="runner"><div className="runner-card muted">Загрузка…</div></div>;
  if (loaded.kind === 'error') return <Final title="SurveyLAB" message={loaded.message} />;
  if (loaded.kind === 'closed') return <Final title={loaded.title} message={loaded.message} />;

  const { state } = loaded;
  const page = state.page ? findPage(state.survey, state.page) : null;
  return (
    <>
      {state.survey.css && <style>{state.survey.css}</style>}
      {page
        ? <PageView key={`${state.rid}:${page.id}:${state.progress}`} state={state} page={page} surveyId={surveyId} onState={applyState} />
        : <Final title={state.survey.title} message={state.message ?? DEFAULT_SETTINGS.completeMessage} preview={state.preview} />}
    </>
  );
}

function PageView({ state, page, surveyId, onState }: {
  state: RunnerState; page: Page; surveyId: string; onState: (s: RunnerState) => void;
}) {
  const { survey } = state;
  const settings = { ...DEFAULT_SETTINGS, ...survey.settings };

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
  const ctx: RespondentContext = { survey, answers, params: state.params, seed: state.rid };

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
  useEffect(() => {
    runScript(survey.scripts?.init, 'init (анкета)', envRef.current());
    runScript(page.scripts?.onShow, `onShow (${page.id})`, envRef.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const visibleKey = visible.map((q) => q.id).join(',');
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
    if (q && 'autoNext' in q && q.autoNext && typeof a?.v === 'number'
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
  const blockTitle = blockOf(survey, page.id)?.title;
  const hideBack = visible.some((q) => q.hideBack);
  const hideFinish = visible.some((q) => q.hideFinish);

  const payload = (): Answers => {
    const out: Answers = {};
    for (const q of visible) if (local[q.id]) out[q.id] = local[q.id];
    // Скрытые переменные любой страницы, выставленные скриптами
    for (const [id, a] of Object.entries(local)) {
      const q = findQuestion(survey, id);
      if (q?.type === 'hidden') out[id] = a;
    }
    return out;
  };

  const showErrors = (errs: Record<string, string>) => {
    setErrors(errs);
    const first = visible.find((q) => errs[q.id]);
    if (first) document.getElementById(`q-${first.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  return (
    <div className={`runner page-${page.id}`}>
      {state.preview && <div className="preview-banner">Предпросмотр: ответы помечаются как тестовые</div>}
      {settings.showProgress && (
        <div className="progress" role="progressbar" aria-valuenow={state.progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-fill" style={{ width: `${state.progress}%` }} />
        </div>
      )}
      <div className="runner-card" onKeyDown={(e) => {
        // Enter в однострочном поле — «Далее»
        const t = e.target as HTMLElement;
        if (e.key === 'Enter' && t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox' && (t as HTMLInputElement).type !== 'radio') {
          e.preventDefault();
          send('submit');
        }
      }}>
        {blockTitle && <div className="page-title">{rich(pipe(blockTitle, ctx))}</div>}
        {visible.map((q) => (
          <QuestionView key={q.id} q={q} ctx={ctx} answer={local[q.id]} error={errors[q.id]} onChange={(a) => setAnswer(q.id, a)} />
        ))}
        {pageError && <div className="q-error page-error" role="alert">{pageError}</div>}
        <div className="nav">
          {state.canBack && !hideBack && <button className="btn btn-secondary" disabled={busy} onClick={() => send('back')}>Назад</button>}
          <button className="btn btn-primary" disabled={busy} onClick={() => send('submit')}>{isLast ? 'Отправить' : 'Далее'}</button>
        </div>
        {settings.allowEarlyFinish && !hideFinish && (
          <div className="early-finish">
            <button className="btn-link" disabled={busy} onClick={() => send('finish')}>Завершить опрос досрочно</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Final({ title, message, preview }: { title: string; message: string; preview?: boolean }) {
  useEffect(() => { document.title = title; }, [title]);
  return (
    <div className="runner">
      <div className="runner-card final">
        <h1>{title}</h1>
        <p style={{ whiteSpace: 'pre-line' }}>{rich(message)}</p>
        {preview && (
          <button className="btn btn-secondary" onClick={() => {
            const u = new URL(window.location.href);
            u.searchParams.set('new', '1');
            window.location.href = u.toString();
          }}>Пройти ещё раз</button>
        )}
      </div>
    </div>
  );
}
