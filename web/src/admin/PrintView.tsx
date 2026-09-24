import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { describeCondition } from './ConditionEditor.tsx';
import { describeActions } from './ActionsEditor.tsx';
import { QUESTION_TYPE_LABELS, settingsOf, type Option, type Question, type Survey } from '../../../shared/types.ts';

/**
 * Печатная версия анкеты — для согласования с заказчиком и проверки глазами:
 * тексты, коды, логика и программистские пометки в привычном «бумажном» виде.
 */
export function PrintView({ id }: { id: string }) {
  const [def, setDef] = useState<Survey | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ draft: Survey }>('GET', `/api/admin/surveys/${id}`).then((r) => { setDef(r.draft); document.title = `${r.draft.title} — печатная версия`; })
      .catch((e) => setError((e as Error).message));
  }, [id]);
  if (error) return <div className="container error-box">{error}</div>;
  if (!def) return <div className="container muted">Загрузка…</div>;

  let n = 0;
  const total = def.blocks.reduce((k, b) => k + b.questions.filter((q) => q.type !== 'hidden').length, 0);
  return (
    <div className="print-doc">
      <div className="print-toolbar">
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>Печать / PDF</button>
        <span className="muted small">Черновик анкеты · вопросов: {total} · {new Date().toLocaleDateString('ru-RU')}</span>
      </div>
      <h1>{def.title}</h1>
      {def.description && <p className="muted">{def.description}</p>}
      <SettingsSummary def={def} />
      {def.blocks.map((b) => (
        <section key={b.id} className="print-block">
          <h2>{b.title || 'Блок'} <span className="print-id">{b.id}</span></h2>
          {b.questions.map((q) => (
            <PrintQuestion key={q.id} def={def} q={q} n={q.type === 'hidden' ? null : ++n} />
          ))}
        </section>
      ))}
    </div>
  );
}

function SettingsSummary({ def }: { def: Survey }) {
  const st = settingsOf(def);
  const date = (s?: string) => (s ? new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const items = [
    st.openFrom && `начало сбора: ${date(st.openFrom)}`,
    st.closeAt && `окончание: ${date(st.closeAt)}`,
    st.maxResponses && `лимит: ${st.maxResponses} анкет`,
    st.password && 'вход по паролю',
    !st.allowBack && 'без кнопки «Назад»',
    st.allowEarlyFinish && 'можно завершить досрочно',
    st.redirectComplete && `после завершения → ${st.redirectComplete}`,
    st.redirectScreenout && `после отсева → ${st.redirectScreenout}`,
  ].filter(Boolean);
  return items.length ? <p className="print-note">Настройки: {items.join(' · ')}</p> : null;
}

const flagText = (o: Option, multi: boolean) => [
  o.other && 'укажите',
  multi && o.exclusive && 'исключающий',
  o.fixed && 'не перемешивать',
  o.hidden && 'СКРЫТ',
].filter(Boolean).join(', ');

function OptionList({ list, multi = false }: { list: Option[]; multi?: boolean }) {
  return (
    <table className="print-options">
      <tbody>
        {list.map((o) => {
          const f = flagText(o, multi);
          return (
            <tr key={o.code} className={o.hidden ? 'is-hidden' : ''}>
              <td className="print-code">{o.code}</td>
              <td>{o.text}{f && <span className="print-flag"> [{f}]</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PrintQuestion({ def, q, n }: { def: Survey; q: Question; n: number | null }) {
  const notes: ReactNode[] = [];
  const note = (text: ReactNode) => notes.push(<div key={notes.length} className="print-note">{text}</div>);
  if (q.showIf) note(<>ПОКАЗЫВАТЬ, ЕСЛИ {describeCondition(def, q.showIf)}</>);
  const before = describeActions(def, q, q.actions?.before);
  if (before) note(<>ПЕРЕД ПОКАЗОМ: {before}</>);

  const a = q as any;
  const from = a.optionsFrom ?? a.rowsFrom;
  if (from) note(<>{q.type === 'matrix' ? 'СТРОКИ' : 'ВАРИАНТЫ'} ИЗ {from.question} ({from.filter === 'selected' ? 'выбранные' : from.filter === 'notSelected' ? 'невыбранные' : 'все'})</>);
  const order = a.order ?? a.rowOrder ?? (a.randomize || a.randomizeRows ? 'random' : undefined);
  if (order) note(order === 'random' ? 'СЛУЧАЙНЫЙ ПОРЯДОК' : 'РОТАЦИЯ');

  const specs: string[] = [];
  if (q.type === 'multi' && (q.minSelected || q.maxSelected)) specs.push(`выбрать ${q.minSelected ?? 1}–${q.maxSelected ?? 'все'}`);
  if (q.type === 'ranking') specs.push(`мест: ${q.rankCount ?? 'все'}`);
  if (q.type === 'number') specs.push([q.min !== undefined && `от ${q.min}`, q.max !== undefined && `до ${q.max}`, q.decimals && `${q.decimals} зн. после запятой`, q.suffix].filter(Boolean).join(' '));
  if (q.type === 'text') specs.push([q.inputType === 'email' && 'e-mail', q.inputType === 'time' && 'время', q.minLength && `от ${q.minLength} симв.`, q.maxLength && `до ${q.maxLength} симв.`, q.pattern && `формат: ${q.pattern}`].filter(Boolean).join(', '));
  if (q.type === 'date') specs.push([q.min && `не раньше ${q.min}`, q.max && `не позже ${q.max}`].filter(Boolean).join(', '));
  if (q.type === 'phone') specs.push(q.format === 'international' ? 'международный формат' : '+7');
  if (q.type === 'matrix') specs.push(`${q.mode === 'single' ? 'один ответ' : 'несколько ответов'} в строке${q.requiredRows === 'none' ? ', строки необязательны' : typeof q.requiredRows === 'number' ? `, минимум ${q.requiredRows} строк` : ''}`);
  if (q.type === 'hidden') specs.push(q.fromParam ? `из параметра ссылки ?${q.fromParam}` : 'задаётся действием или скриптом');

  const after = describeActions(def, q, q.actions?.after);
  const answerable = q.type !== 'info' && q.type !== 'hidden';

  return (
    <div className="print-q">
      <div className="print-q-head">
        {n !== null && <span className="print-n">{n}.</span>}
        <span className="print-id">{q.id}</span>
        <span className="print-type">{QUESTION_TYPE_LABELS[q.type]}{specs.filter(Boolean).length ? ` · ${specs.filter(Boolean).join('; ')}` : ''}</span>
        {answerable && q.required === false && <span className="print-type">· необязательный</span>}
      </div>
      {notes}
      {q.text && <div className="print-text">{q.text}</div>}
      {q.hint && <div className="print-hint">{q.hint}</div>}
      {(q.type === 'single' || q.type === 'multi' || q.type === 'dropdown' || q.type === 'ranking') && q.options.length > 0 && (
        <OptionList list={q.options} multi={q.type === 'multi'} />
      )}
      {q.type === 'scale' && (
        <div className="print-scale">
          Шкала {q.from}–{q.to}
          {Object.entries(q.labels ?? {}).map(([k, v]) => <span key={k}> · {k} — {v}</span>)}
          {q.extraOptions?.length ? <OptionList list={q.extraOptions} /> : null}
        </div>
      )}
      {q.type === 'matrix' && (
        <div className="print-matrix">
          <div><div className="print-sub">Строки</div><OptionList list={q.rows} /></div>
          <div><div className="print-sub">Столбцы</div><OptionList list={q.columns} /></div>
        </div>
      )}
      {after && <div className="print-note">ПОСЛЕ ОТВЕТА: {after}</div>}
      {q.scripts && <div className="print-note">JS-скрипт: {Object.keys(q.scripts).join(', ')}</div>}
      {q.note && <div className="print-comment">Комментарий: {q.note}</div>}
    </div>
  );
}
