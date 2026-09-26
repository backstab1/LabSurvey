import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Modal, toast } from './common.tsx';

interface Connection { clientId: string; name: string; since: string; lastUsedAt: string | null }

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Подключение Claude / ChatGPT к SurveyLAB (MCP-коннектор) и отзыв доступа */
export function ConnectorDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Connection[] | null>(null);
  const url = `${window.location.origin}/mcp`;
  const local = /^(localhost|127\.|\[::1\])/.test(window.location.hostname) || window.location.protocol !== 'https:';
  const load = () => api<Connection[]>('GET', '/api/admin/me/connections').then(setList).catch((e) => toast((e as Error).message));
  useEffect(() => { load(); }, []);

  return (
    <Modal onClose={onClose} title="ИИ-коннектор" actions={<button className="btn btn-primary" onClick={onClose}>Готово</button>}>
      <div className="stack">
        <p style={{ margin: 0 }}>
          Подключите SurveyLAB к Claude или ChatGPT — и создавайте анкеты прямо в чате: опишите задачу, ИИ соберёт анкету, проверит её
          и сохранит черновиком. Публикуете и запускаете вы сами.
        </p>
        <div className="field">
          <span>Адрес коннектора</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono grow" readOnly value={url} onFocus={(e) => e.target.select()} />
            <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(url); toast('Адрес скопирован'); }}>Копировать</button>
          </div>
          {local && (
            <span className="field-help" style={{ color: 'var(--warn, #9a6700)' }}>
              Claude и ChatGPT подключаются из интернета: нужен внешний https-адрес SurveyLAB (сервер с доменом или туннель). Адрес на этом
              компьютере им недоступен.
            </span>
          )}
        </div>
        <div className="grid2">
          <div>
            <strong>Claude</strong>
            <ol className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>Настройки → Коннекторы → «Добавить свой коннектор».</li>
              <li>Название — SurveyLAB, адрес — из поля выше.</li>
              <li>«Подключить» → войдите в SurveyLAB → «Разрешить».</li>
            </ol>
          </div>
          <div>
            <strong>ChatGPT</strong>
            <ol className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>Настройки → Приложения и коннекторы → включите режим разработчика → «Создать».</li>
              <li>Адрес — из поля выше, аутентификация — OAuth.</li>
              <li>Войдите в SurveyLAB → «Разрешить».</li>
            </ol>
          </div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Названия пунктов меню в Claude и ChatGPT со временем меняются, а свои коннекторы доступны не на всех тарифах. ИИ работает от вашего
          имени и с вашей ролью: видит анкеты, создаёт и меняет черновики; публиковать, запускать сбор и видеть ответы не может.
        </p>
        <div>
          <strong>Подключённые приложения</strong>
          {!list ? <p className="muted small">Загрузка…</p> : list.length === 0 ? <p className="muted small" style={{ margin: '6px 0 0' }}>Пока ничего не подключено.</p> : (
            <table className="table" style={{ marginTop: 6 }}>
              <thead><tr><th>Приложение</th><th>Подключено</th><th>Последний раз</th><th /></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.clientId}>
                    <td>{c.name}</td>
                    <td className="muted">{fmt(c.since)}</td>
                    <td className="muted">{fmt(c.lastUsedAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn-link" style={{ color: 'var(--danger)' }} onClick={async () => {
                        if (!window.confirm(`Отозвать доступ приложения «${c.name}»? Чтобы пользоваться им снова, коннектор придётся подключить заново.`)) return;
                        await api('DELETE', `/api/admin/me/connections/${encodeURIComponent(c.clientId)}`);
                        toast('Доступ отозван');
                        load();
                      }}>отозвать</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Modal>
  );
}
