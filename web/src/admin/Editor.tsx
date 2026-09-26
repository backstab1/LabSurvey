import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Builder } from './Builder.tsx';
import { JsonTab } from './JsonTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { LogicTab } from './LogicTab.tsx';
import { IssuesList, Menu, Modal, toast } from './common.tsx';
import { canEdit, navigate, useMe } from './AdminApp.tsx';
import { publishState } from './SurveyList.tsx';
import { NewProjectModal } from './ProjectPage.tsx';
import { validateSurvey } from '../../../shared/validate.ts';
import { analyzeFlow } from '../../../shared/flow.ts';
import { PROJECT_STATUS_LABELS, type ProjectStatus, type Survey } from '../../../shared/types.ts';

export interface SurveyInfo {
  id: string;
  title: string;
  draft: Survey;
  published: Survey | null;
  version: number;
  archived: boolean;
  testToken: string;
  /** Проекты, в которых запускается анкета */
  projects: { id: string; title: string; status: ProjectStatus }[];
}

type Tab = 'builder' | 'logic' | 'json' | 'settings';
type SaveState = 'saved' | 'pending' | 'saving' | 'error';

const SAVE_TEXT: Record<SaveState, string> = {
  saved: 'Черновик сохранён',
  pending: 'Изменения…',
  saving: 'Сохранение…',
  error: 'Не сохранено — повторите',
};

export function Editor({ id }: { id: string }) {
  const [info, setInfo] = useState<SurveyInfo | null>(null);
  const [def, setDef] = useState<Survey | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab;
    return ['builder', 'logic', 'json', 'settings'].includes(t) ? t : 'builder';
  });
  const [save, setSave] = useState<SaveState>('saved');
  const [showIssues, setShowIssues] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [newProject, setNewProject] = useState(false);
  // Наблюдатель видит всё, но ничего не меняет
  const readOnly = !canEdit(useMe());
  const [focus, setFocus] = useState<{ where: string; n: number }>();
  const latest = useRef<Survey | null>(null);
  // История для отмены: правки, сделанные подряд быстрее чем за 0,7 с, объединяются в один шаг
  const hist = useRef<{ past: Survey[]; future: Survey[]; last: number }>({ past: [], future: [], last: 0 });
  const [, setHistTick] = useState(0);

  const reload = useCallback(async () => {
    const r = await api<SurveyInfo>('GET', `/api/admin/surveys/${id}`);
    setInfo(r);
    return r;
  }, [id]);
  useEffect(() => { reload().then((r) => { setDef(r.draft); latest.current = r.draft; }); }, [reload]);

  // Автосохранение черновика через секунду после последней правки
  const flush = useCallback(async () => {
    const d = latest.current;
    if (!d) return true;
    setSave('saving');
    try {
      await api('PUT', `/api/admin/surveys/${id}`, { definition: d });
      if (latest.current === d) setSave('saved');
      else setSave('pending');
      return true;
    } catch (e) {
      setSave('error');
      toast(e instanceof ApiError ? e.message : 'Ошибка сохранения');
      return false;
    }
  }, [id]);
  useEffect(() => {
    if (save !== 'pending') return;
    const t = setTimeout(flush, 800);
    return () => clearTimeout(t);
  }, [save, def, flush]);
  useEffect(() => {
    if (save === 'saved') return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [save]);

  const validation = useMemo(() => {
    if (!def) return null;
    const v = validateSurvey(def);
    // Проблемы маршрутов (недостижимые вопросы и т. п.) — как предупреждения
    if (v.ok) {
      try {
        for (const i of analyzeFlow(def).issues) v.warnings.push({ where: i.id ?? 'маршрут', message: i.message });
      } catch { /* анализ не критичен */ }
    }
    return v;
  }, [def]);

  const apply = (next: Survey) => { setDef(next); latest.current = next; setSave('pending'); };
  const update = (next: Survey) => {
    if (readOnly) { toast('У вас доступ только на просмотр'); return; }
    const h = hist.current;
    const cur = latest.current;
    if (cur && Date.now() - h.last > 700) {
      h.past.push(cur);
      if (h.past.length > 200) h.past.shift();
    }
    h.last = Date.now();
    h.future = [];
    apply(next);
    setHistTick((n) => n + 1);
  };
  const undo = () => {
    const h = hist.current;
    const prev = h.past.pop();
    if (!prev || !latest.current) return;
    h.future.push(latest.current);
    h.last = 0;
    apply(prev);
    setHistTick((n) => n + 1);
  };
  const redo = () => {
    const h = hist.current;
    const next = h.future.pop();
    if (!next || !latest.current) return;
    h.past.push(latest.current);
    h.last = 0;
    apply(next);
    setHistTick((n) => n + 1);
  };

  // Горячие клавиши: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — отмена и повтор (в полях ввода работает родная отмена), Ctrl+S — сохранить
  const keysRef = useRef({ undo, redo, flush });
  keysRef.current = { undo, redo, flush };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const el = e.target as HTMLElement;
      const inField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
      if (k === 's' || k === 'ы') { e.preventDefault(); keysRef.current.flush(); return; }
      if (inField) return;
      if ((k === 'z' || k === 'я') && !e.shiftKey) { e.preventDefault(); keysRef.current.undo(); }
      else if (((k === 'z' || k === 'я') && e.shiftKey) || k === 'y' || k === 'н') { e.preventDefault(); keysRef.current.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!info || !def || !validation) return <div className="container muted">Загрузка…</div>;

  const saveNow = async () => (save === 'saved' ? true : flush());

  const publish = async () => {
    if (!(await saveNow())) return;
    const live = info.projects.filter((p) => p.status === 'collecting');
    if (live.length && !window.confirm(`Анкета сейчас собирает ответы в проектах: ${live.map((p) => `«${p.title}»`).join(', ')}. Опубликовать новую версию? Респонденты сразу увидят её, незавершённые продолжат по новой версии.`)) return;
    try {
      const r = await api('POST', `/api/admin/surveys/${id}/publish`);
      await reload();
      toast(`Опубликовано (версия ${r.version})`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const preview = async (startAt?: string) => {
    // Окно открываем сразу (иначе браузер заблокирует всплывающее окно), адрес — после сохранения
    const w = window.open('about:blank', '_blank');
    if (!(await saveNow())) { w?.close(); return; }
    const url = `/s/${id}?preview=1&survey=1&new=1${startAt ? `&start=${encodeURIComponent(startAt)}` : ''}`;
    if (w) w.location.href = url; else window.open(url, '_blank');
  };

  const unpublished = !info.published || JSON.stringify(info.published) !== JSON.stringify(def);
  const ps = publishState({ version: info.version, unpublished });
  const changeTab = (t: Tab) => {
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u);
  };
  const errs = validation.errors.length;
  const warns = validation.warnings.length;

  return (
    <div className="container editor">
      <div className="editor-head">
        <button className="icon-btn back" title="Все анкеты" onClick={() => navigate('/admin/surveys')}>←</button>
        <input className="title-input" value={def.title} placeholder="Название анкеты" aria-label="Название анкеты"
          onChange={(e) => update({ ...def, title: e.target.value })} />
        {info.archived ? <span className="badge">В архиве</span> : <span className={`badge ${ps.cls}`}>{ps.text}</span>}
        <span className={`save-state ${save}`} onClick={save === 'error' ? () => flush() : undefined}>{SAVE_TEXT[save]}</span>
        <span className="grow" />
        <span className="undo-group">
          <button className="icon-btn" title="Отменить (Ctrl+Z)" disabled={!hist.current.past.length} onClick={undo}>↶</button>
          <button className="icon-btn" title="Повторить (Ctrl+Shift+Z)" disabled={!hist.current.future.length} onClick={redo}>↷</button>
        </span>
        <button className="btn btn-secondary" onClick={() => preview()}>Предпросмотр</button>
        {!readOnly && <button className={`btn ${unpublished ? 'btn-primary' : 'btn-secondary published-btn'}`} disabled={!validation.ok || !unpublished} onClick={publish}
          title={!validation.ok ? 'Сначала исправьте ошибки' : !unpublished ? 'Опубликованная версия совпадает с черновиком' : ''}>
          {!info.published ? 'Опубликовать' : unpublished ? 'Опубликовать изменения' : '✓ Опубликовано'}
        </button>}
        <Menu className="btn btn-secondary menu-trigger" items={[
          !readOnly && { label: 'Запустить в новом проекте', onClick: () => setNewProject(true) },
          { label: 'Печатная версия анкеты', onClick: async () => { await saveNow(); window.open(`/admin/s/${id}/print`, '_blank'); } },
          { label: 'История версий', onClick: () => setShowVersions(true), disabled: !info.published },
          !readOnly && { label: 'Дублировать анкету', onClick: async () => { const r = await api('POST', `/api/admin/surveys/${id}/duplicate`); navigate(`/admin/s/${r.id}`); } },
          { label: 'Скачать JSON', onClick: () => { window.location.href = `/api/admin/surveys/${id}/export.json`; } },
          !readOnly && {
            label: info.archived ? 'Вернуть из архива' : 'Перенести в архив',
            onClick: async () => { await api('POST', `/api/admin/surveys/${id}/archive`, { archived: !info.archived }); await reload(); },
          },
          !readOnly && {
            label: 'Удалить анкету', danger: true, onClick: async () => {
              if (info.projects.length) return toast('Анкета используется в проектах — сначала удалите их или выберите в них другую анкету');
              if (!window.confirm('Удалить анкету? Это нельзя отменить.')) return;
              await api('DELETE', `/api/admin/surveys/${id}`);
              navigate('/admin/surveys');
            },
          },
        ]} />
      </div>

      {readOnly && <div className="warn-box readonly-note">Режим просмотра: изменения не сохраняются. Предпросмотр доступен.</div>}
      <div className="tabs-row">
        <div className="tabs">
          {([['builder', 'Конструктор'], ['logic', 'Логика'], ['json', 'JSON'], ['settings', 'Настройки анкеты']] as [Tab, string][]).map(([t, label]) => (
            <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => changeTab(t)}>{label}</button>
          ))}
        </div>
        {info.projects.map((p) => (
          <button key={p.id} className="link-chip" title="Открыть проект: сбор, квоты, данные и отчёт" onClick={() => navigate(`/admin/p/${p.id}`)}>
            Проект «{p.title}» · {PROJECT_STATUS_LABELS[p.status].toLowerCase()} →
          </button>
        ))}
        {!info.projects.length && !readOnly && (
          <button className="link-chip" title="Проект — запуск анкеты: сбор, квоты, данные и отчёт" onClick={() => setNewProject(true)}>+ Запустить в проекте</button>
        )}
        {(errs > 0 || warns > 0) && (
          <button className={`issues-chip${errs ? ' err' : ''}`} onClick={() => setShowIssues(!showIssues)}>
            {errs > 0 ? `Ошибок: ${errs}` : ''}{errs && warns ? ' · ' : ''}{warns > 0 ? `Предупреждений: ${warns}` : ''}
          </button>
        )}
      </div>
      {showIssues && (errs > 0 || warns > 0) && (
        <div className="issues-panel">
          {errs > 0 && <IssuesList issues={validation.errors} onPick={(where) => { changeTab('builder'); setFocus({ where, n: Date.now() }); }} />}
          {warns > 0 && <div className="warn-list"><IssuesList issues={validation.warnings} onPick={(where) => { changeTab('builder'); setFocus({ where, n: Date.now() }); }} /></div>}
        </div>
      )}

      {tab === 'builder' && <Builder def={def} onChange={update} issues={validation} focus={focus} onPreview={preview} />}
      {tab === 'logic' && <LogicTab def={def} onOpen={(qid) => { changeTab('builder'); setFocus({ where: qid, n: Date.now() }); }} />}
      {tab === 'json' && <JsonTab def={def} onChange={update} />}
      {tab === 'settings' && <SettingsTab def={def} onChange={update} />}
      {newProject && <NewProjectModal surveyId={id} onClose={() => setNewProject(false)} />}
      {showVersions && (
        <VersionsModal id={id} current={info.version} onClose={() => setShowVersions(false)}
          onRestore={(v, restored) => { update(restored); setShowVersions(false); changeTab('builder'); toast(`Черновик заменён версией ${v}. Отменить — Ctrl+Z`); }} />
      )}
    </div>
  );
}

interface VersionRow { version: number; publishedAt: string; publishedBy: string | null; questions: number }

/** Опубликованные версии: скачать или вернуть в черновик (возврат можно отменить через Ctrl+Z) */
function VersionsModal({ id, current, onClose, onRestore }: {
  id: string; current: number; onClose: () => void; onRestore: (v: number, def: Survey) => void;
}) {
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  useEffect(() => { api<VersionRow[]>('GET', `/api/admin/surveys/${id}/versions`).then(setRows); }, [id]);
  return (
    <Modal onClose={onClose} title="История версий">
      {!rows ? <p className="muted">Загрузка…</p> : rows.length === 0 ? <p className="muted">Опубликованных версий пока нет.</p> : (
        <table className="table versions">
          <tbody>
            {rows.map((r) => (
              <tr key={r.version}>
                <td><strong>Версия {r.version}</strong>{r.version === current && <span className="badge active" style={{ marginLeft: 8 }}>сейчас в опросе</span>}</td>
                <td className="muted">{new Date(r.publishedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}{r.publishedBy ? ` · ${r.publishedBy}` : ''}</td>
                <td className="muted">вопросов: {r.questions}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <a className="btn-link" href={`/api/admin/surveys/${id}/versions/${r.version}`} download={`version-${r.version}.json`}>JSON</a>
                  <button className="btn btn-secondary btn-sm" onClick={async () => {
                    if (!window.confirm(`Заменить черновик версией ${r.version}? Текущий черновик можно будет вернуть через Ctrl+Z.`)) return;
                    onRestore(r.version, await api<Survey>('GET', `/api/admin/surveys/${id}/versions/${r.version}`));
                  }}>В черновик</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
