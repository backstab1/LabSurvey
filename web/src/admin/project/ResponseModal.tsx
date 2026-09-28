// Один ответ: все ответы респондента по анкете, брак, удаление
import { api, useApi } from '../../api.ts';
import { Modal, toast } from '../common.tsx';
import { rich } from '../../runner/rich.tsx';
import { allQuestions, answerText, pipe } from '../../../../shared/logic.ts';
import { expandAllLoops } from '../../../../shared/loops.ts';
import type { Answers, Survey } from '../../../../shared/types.ts';
import { STATUS_LABELS, flagLabel } from '../../../../shared/variables.ts';
import { SUSPECT_SCORE, flagWeight, qualityScore } from '../../../../shared/quality.ts';
import type { ResponseListItem } from '../../../../shared/api.ts';
import { fmtDate } from './format.ts';

/** Просмотр одного ответа: вопросы, которые видел респондент, и его ответы */
export function ResponseModal({ editable, surveyId, rid, onClose, onDeleted, onChanged }: {
  editable: boolean; surveyId: string; rid: string; onClose: () => void; onDeleted: () => void; onChanged: () => void;
}) {
  const { data, reload: load } = useApi<{ response: ResponseListItem & {
    answers: Answers; history: string[]; timings?: Record<string, number>; postback?: { status: string; at: string; ok: boolean; error?: string } | null;
  }; survey: Survey }>(
    `/api/admin/projects/${surveyId}/responses/${rid}`,
  );
  if (!data) return <Modal onClose={onClose} title="Ответ">Загрузка…</Modal>;
  const { response: r, survey } = data;
  const ctx = { survey: expandAllLoops(survey), answers: r.answers, params: r.params, seed: r.id };
  const qs = allQuestions(expandAllLoops(survey)).filter((q) => q.type !== 'info' && r.answers[q.id] !== undefined);
  return (
    <Modal onClose={onClose} title={<>Ответ <span className="mono muted" style={{ fontWeight: 400, fontSize: 14 }}>{r.id}</span></>}
      actions={<>
        {editable && <><button className="btn btn-secondary btn-sm" title="Бракованная анкета не считается в квотах, лимите, отчёте и выгрузке (выгрузить можно отдельно)"
          onClick={async () => {
            await api('POST', `/api/admin/projects/${surveyId}/responses/${rid}/reject`, { rejected: !r.rejected });
            await load();
            onChanged();
            toast(r.rejected ? 'Брак снят' : 'Анкета помечена как брак');
          }}>{r.rejected ? 'Снять брак' : 'Забраковать'}</button>
        <button className="btn btn-danger btn-sm" onClick={async () => {
          if (!window.confirm('Удалить этот ответ? Это нельзя отменить.')) return;
          await api('DELETE', `/api/admin/projects/${surveyId}/responses/${rid}`);
          onDeleted();
        }}>Удалить</button></>}
        <button className="btn btn-primary btn-sm" onClick={onClose}>Закрыть</button>
      </>}>
      <div className="stack">
        <div className="row small muted">
          <span>{STATUS_LABELS[r.status]}{r.isTest ? ' · тест' : ''}</span>
          <span>Начало: {fmtDate(r.startedAt, '–')}</span>
          <span>Окончание: {fmtDate(r.completedAt, '–')}</span>
          {r.durationSec !== null && <span>Время: {Math.floor(r.durationSec / 60)} мин {r.durationSec % 60} с</span>}
          {Object.entries(r.params).map(([k, v]) => <span key={k} className="mono">{k}={v}</span>)}
        </div>
        {!!r.flags?.length && (
          <div className={`${qualityScore(r.flags) >= SUSPECT_SCORE ? 'warn-box' : 'info-box'} small`}>
            {qualityScore(r.flags) >= SUSPECT_SCORE ? 'Подозрительная анкета' : 'Пометки качества'}, балл риска {qualityScore(r.flags)}:{' '}
            {r.flags.map((f) => `${flagLabel(f)} (+${flagWeight(f)})`).join('; ')}
          </div>
        )}
        {r.postback && (
          <div className={`${r.postback.ok ? 'muted' : 'field-error'} small`}>
            Постбэк панели «{r.postback.status}» {r.postback.ok ? 'доставлен' : `не доставлен: ${r.postback.error ?? 'ошибка'}`} · {fmtDate(r.postback.at, '')}
          </div>
        )}
        {qs.length === 0 ? <p className="muted">Ответов нет</p> : (
          <table className="table answers-table">
            <tbody>
              {qs.map((q) => (
                <tr key={q.id}>
                  <td className="mono" style={{ width: 70, verticalAlign: 'top' }}>{q.id}</td>
                  <td style={{ verticalAlign: 'top' }}>
                    <div className="muted small">{rich(pipe(q.text, ctx))}</div>
                    <div>{answerText(ctx, q) || '–'}</div>
                    {q.type === 'file' && typeof r.answers[q.id]?.v === 'string' && (
                      <div className="report-files">
                        {String(r.answers[q.id].v).split(',').map((id) => {
                          const url = `/api/admin/projects/${surveyId}/files/${r.id}/${id}`;
                          return /\.(jpg|png|gif|webp)$/.test(id)
                            ? <a key={id} href={url} target="_blank" rel="noreferrer"><img src={url} alt={r.answers[q.id].o?.[id] ?? id} /></a>
                            : <a key={id} href={url} className="report-file">📄 {r.answers[q.id].o?.[id] ?? id}</a>;
                        })}
                      </div>
                    )}
                  </td>
                  <td className="muted small" style={{ width: 60, textAlign: 'right', verticalAlign: 'top' }} title="Время на вопросе">
                    {r.timings?.[q.id] !== undefined ? `${r.timings[q.id]} с` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
