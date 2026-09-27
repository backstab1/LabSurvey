// Квоты проекта: условия и лимиты завершённых анкет
import { useProjectDraft } from './useProjectDraft.ts';
import { ConditionField } from '../survey/ConditionEditor.tsx';
import { compact, toast } from '../common.tsx';
import { nextId } from '../../../../shared/refactor.ts';
import { allQuestions } from '../../../../shared/logic.ts';
import type { Quota } from '../../../../shared/types.ts';
import type { ProjectInfo } from '../../../../shared/api.ts';

export function QuotasTab({ info, readOnly, reload }: { info: ProjectInfo; readOnly: boolean; reload: () => Promise<unknown> }) {
  const { value: quotas, setValue: setQuotas, dirty, busy, save } = useProjectDraft<Quota[]>(info.id, 'quotas', info.quotaDefs, reload, { message: 'Квоты сохранены' });
  const def = info.published ?? info.draft;
  const setAt = (i: number, patch: Partial<Quota>) => setQuotas(quotas.map((q, k) => (k === i ? compact({ ...q, ...patch }) : q)));
  const add = () => {
    const first = allQuestions(def).find((q) => q.type !== 'info');
    if (!first) return toast('В анкете пока нет вопросов');
    setQuotas([...quotas, { id: nextId(quotas.map((q) => q.id), 'QT'), if: { q: first.id, op: 'answered' }, limit: 100 }]);
  };

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Квоты</h2>
          {!readOnly && <button className="btn btn-secondary btn-sm" onClick={add}>+ Квота</button>}
          {!readOnly && <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Счётчик считает завершённые анкеты, подходящие под условие. Когда набрано нужное число, следующие подходящие респонденты
          заканчивают опрос со статусом «Сверх квоты» (сообщение и переход задаются в анкете → Настройки → Завершение). Проверка — после
          каждого ответа, поэтому квотные вопросы ставьте в начало анкеты. Условие может использовать и параметр ссылки: <code>param.src = "vk"</code>.
        </p>
        {quotas.length === 0 && <p className="muted" style={{ margin: 0 }}>Квот нет — принимаются все, кто прошёл анкету.</p>}
        {quotas.map((q, i) => {
          const p = info.quotas.find((x) => x.id === q.id);
          const pct = p && q.limit ? Math.min(100, Math.round((p.count / q.limit) * 100)) : 0;
          return (
            <div key={i} className="quota">
              <div className="row" style={{ gap: 8 }}>
                <input className="input mono" style={{ width: 90 }} value={q.id} title="ID квоты" readOnly={readOnly}
                  onChange={(e) => setAt(i, { id: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} />
                <input className="input grow" placeholder="Название, например «Мужчины 18–34»" value={q.title ?? ''} readOnly={readOnly}
                  onChange={(e) => setAt(i, { title: e.target.value || undefined })} />
                <label className="row" style={{ gap: 6 }}><span className="muted small">нужно</span>
                  <input className="input mini" type="number" min={0} value={q.limit} readOnly={readOnly}
                    onChange={(e) => setAt(i, { limit: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                </label>
                {!readOnly && <button className="icon-btn" title="Удалить квоту" onClick={() => setQuotas(quotas.filter((_, k) => k !== i))}>✕</button>}
              </div>
              <ConditionField def={def} value={q.if} placeholder="условие, например S1 = 1 and S2 in (1, 2)"
                onChange={(c) => c && setAt(i, { if: c })} />
              {p && (
                <div className="quota-progress" title="По опубликованной версии анкеты">
                  <div className="quota-bar"><div style={{ width: `${pct}%` }} className={p.count >= q.limit ? 'full' : ''} /></div>
                  <span className="small">{p.count} из {q.limit}{p.count >= q.limit ? ' — набрана' : ''}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
