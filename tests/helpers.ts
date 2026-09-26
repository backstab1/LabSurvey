// Общие помощники API-тестов
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Call = (method: any, url: string, body?: unknown) => Promise<{ status: number; json: any }>;

/** Запускает опубликованную анкету в новом проекте со статусом «Сбор данных»; возвращает ID проекта (он в ссылке /s/ID) */
export async function launch(call: Call, surveyId: string, title?: string): Promise<string> {
  const p = await call('POST', '/api/admin/projects', { surveyId, title });
  if (p.status !== 200) throw new Error(`Проект не создан: ${JSON.stringify(p.json)}`);
  const st = await call('POST', `/api/admin/projects/${p.json.id}/status`, { status: 'collecting' });
  if (st.status !== 200) throw new Error(`Сбор не запущен: ${JSON.stringify(st.json)}`);
  return p.json.id;
}
