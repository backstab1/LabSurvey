import { useState } from 'react';
import { QuestionView } from '../runner/QuestionView.tsx';
import { allOptions, allRows } from '../../../shared/logic.ts';
import type { Answer, Question, RespondentContext, Survey } from '../../../shared/types.ts';

/**
 * Вопрос в виде «как увидит респондент» для конструктора:
 * подстановки показываются как [Q1], перенесённые варианты — все возможные.
 */
export function previewQuestion(def: Survey, q: Question): Question {
  const pipeMark = (t?: string) => t?.replace(/\{\{\s*([\w.]+)\s*\}\}/g, '[$1]');
  const copy = { ...q, text: pipeMark(q.text) ?? '', hint: pipeMark(q.hint) } as Question;
  if ((copy.type === 'single' || copy.type === 'multi' || copy.type === 'dropdown') && copy.optionsFrom) {
    copy.options = allOptions(def, q);
    delete copy.optionsFrom;
  }
  if (copy.type === 'matrix' && copy.rowsFrom) {
    copy.rows = allRows(def, q as typeof copy);
    delete copy.rowsFrom;
  }
  return copy;
}

export function QuestionPreview({ def, q, interactive }: { def: Survey; q: Question; interactive?: boolean }) {
  const [answer, setAnswer] = useState<Answer | undefined>();
  const pq = previewQuestion(def, q);
  const ctx: RespondentContext = { survey: def, answers: answer ? { [q.id]: answer } : {}, params: {}, seed: 'preview' };
  if (q.type === 'hidden') {
    return (
      <div className="hidden-var">
        Скрытая переменная{q.fromParam ? <> ← параметр ссылки <code>?{q.fromParam}</code></> : ' (задаётся скриптом)'}
      </div>
    );
  }
  return (
    <div className={interactive ? 'q-preview' : 'q-preview static'} inert={!interactive || undefined}>
      <QuestionView q={pq} ctx={ctx} answer={answer} onChange={setAnswer} />
    </div>
  );
}
