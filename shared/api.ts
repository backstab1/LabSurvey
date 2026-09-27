// Контракт API: что сервер отдаёт браузеру. Сервер помечает этими типами свои ответы, админка и прохождение — читают их.
// Меняете поле — компилятор покажет обе стороны.
import type { Panel, ProjectSettings, ProjectStatus, Quota, Survey, Answers } from './types.ts';
import type { ResponseStatus } from './variables.ts';
import type { CrosstabSpec } from './crosstab.ts';

// ---------- Пользователи ----------

/**
 * admin — всё, включая пользователей и копии базы; editor — анкеты и данные; viewer — только просмотр и выгрузки;
 * client — заказчик: только свои проекты (сводка, отчёт, данные), без анкет и настроек
 */
export type Role = 'admin' | 'editor' | 'viewer' | 'client';

/** Вошедший пользователь (GET /api/admin/me) */
export interface SessionUser {
  login: string;
  role: Role;
  /** Главный администратор из .env (ADMIN_LOGIN / ADMIN_PASSWORD) */
  builtIn: boolean;
  /** Для заказчика: доступные проекты */
  projects?: string[];
}

export interface UserRow {
  login: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Для заказчика: проекты, которые он видит */
  projects: string[];
}

/** Подключённое ИИ-приложение */
export interface Connection { clientId: string; name: string; since: string; lastUsedAt: string | null }

export interface AuditEntry {
  id: number;
  at: string;
  login: string | null;
  /** ui — интерфейс, ai — ИИ-коннектор (details.app — приложение) */
  via: 'ui' | 'ai';
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetTitle: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

export interface BackupFile { name: string; size: number; createdAt: string }

export interface BackupsInfo { list: BackupFile[]; everyHours: number; keep: number; database: 'sqlite' | 'postgres' }

// ---------- Анкеты ----------

export interface SurveyListItem {
  id: string;
  title: string;
  version: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Сколько проектов запускают эту анкету */
  projects: number;
  /** Черновик отличается от опубликованной версии */
  unpublished: boolean;
}

export interface SurveyVersion {
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  questions: number;
}

/** Анкета для конструктора (GET /api/admin/surveys/:id) */
export interface SurveyInfo {
  id: string;
  title: string;
  draft: Survey;
  published: Survey | null;
  version: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  testToken: string;
  /** Проекты, в которых запускается анкета */
  projects: { id: string; title: string; status: ProjectStatus }[];
}

// ---------- Проекты ----------

export interface SheetsConfig {
  spreadsheetId: string;
  sheetName: string;
  auto: boolean;
  /** Какие статусы выгружать */
  statuses: ResponseStatus[];
  values: 'labels' | 'codes';
  lastSyncAt?: string;
  lastError?: string | null;
}

/** Уведомления о ходе сбора: вебхук и/или Telegram */
export interface NotifyConfig {
  webhookUrl?: string;
  telegramChatId?: string;
  /** Сообщать о каждой N-й завершённой анкете (1 — о каждой); 0 или пусто — нет */
  everyN?: number;
  quotaFull?: boolean;
  limitReached?: boolean;
  lastError?: string | null;
  lastSentAt?: string;
}

/** Набор таблиц: строки, шапка, фильтры — сохраняется в проекте */
export interface TableSet { name: string; spec: CrosstabSpec }

/** Счётчики одного источника: panel = null — прямая ссылка без панели */
export interface PanelCounts {
  panel: string | null;
  statuses: Record<string, number>;
  rejected: number;
  /** Медиана длительности завершённых анкет, сек */
  medianSec: number | null;
}

/** Счётчики анкет проекта; бракованные в статусы не входят */
export interface ResponseCounts { real: Record<string, number>; test: number; rejected: number; suspect: number }

export interface DayStat {
  /** YYYY-MM-DD */
  day: string;
  started: number;
  completed: number;
  screenedOut: number;
  overquota: number;
}

/** Строка списка проектов */
export interface ProjectListItem {
  id: string;
  title: string;
  status: ProjectStatus;
  surveyId: string;
  surveyTitle: string;
  /** Настоящие анкеты по статусам */
  counts: Record<string, number>;
  panels: number;
  maxResponses: number | null;
  openFrom: string | null;
  closeAt: string | null;
  quotas: number;
  quotasFull: number;
  createdAt: string;
  updatedAt: string;
}

/** Всё о проекте (GET /api/admin/projects/:id); заказчику — без служебного */
export interface ProjectInfo {
  id: string;
  title: string;
  status: ProjectStatus;
  settings: ProjectSettings;
  quotaDefs: Quota[];
  panels: Panel[];
  /** Сохранённые наборы таблиц */
  tableSets: TableSet[];
  /** Счётчики настоящих анкет по панелям; panel = null — прямая ссылка */
  panelCounts: PanelCounts[];
  /** Прогресс квот по опубликованной версии */
  quotas: { id: string; title?: string; limit: number; count: number }[];
  survey: { id: string; title: string; version: number; published: boolean; unpublished: boolean };
  /** Анкета с настройками проекта */
  draft: Survey;
  published: Survey | null;
  sheets: SheetsConfig | null;
  notify: NotifyConfig | null;
  counts: ResponseCounts;
  sheetsAccount: { configured: boolean; email: string | null };
  testToken: string;
  telegramConfigured: boolean;
  /** Динамика по дням (последние 60 дней с первой анкеты) */
  daily: DayStat[];
  /** Сколько человек в списке персональных ссылок */
  invitees: number;
  createdAt: string;
  updatedAt: string;
}

/** Строка списка последних ответов */
export interface ResponseListItem {
  id: string;
  status: ResponseStatus;
  isTest: boolean;
  rejected: boolean;
  startedAt: string;
  completedAt: string | null;
  durationSec: number | null;
  answered: number;
  params: Record<string, string>;
  flags: string[];
}

// ---------- Персональные ссылки и рассылки ----------

export interface Invitee {
  id: number;
  projectId: string;
  token: string;
  /** ID из списка (табельный номер, ID клиента) */
  extId: string | null;
  /** Остальные столбцы списка: имя, e-mail, отдел… — становятся параметрами ответа */
  fields: Record<string, string>;
  responseId: string | null;
  openedAt: string | null;
  createdAt: string;
  /** Статус анкеты по ссылке (из ответа) */
  status: ResponseStatus | null;
  rejected: boolean;
  completedAt: string | null;
  /** Письмо ждёт отправки (в очереди рассылки) */
  mailPending: boolean;
  mailSentAt: string | null;
  mailCount: number;
  mailError: string | null;
}

/** Кому: ещё не получали письмо / не завершили (напоминание) / все / выбранные */
export type MailAudience = 'not_sent' | 'not_completed' | 'all' | 'ids';

export interface Mailing {
  id: number;
  projectId: string;
  audience: MailAudience;
  subject: string;
  body: string;
  /** Столбец списка с адресом */
  emailField: string;
  /** Адрес сервиса для ссылок в письмах */
  baseUrl: string;
  createdBy: string | null;
  createdAt: string;
  total: number;
  sent: number;
  failed: number;
  /** Сколько ещё в очереди */
  pending: number;
  finishedAt: string | null;
  cancelled: boolean;
}

/** Почта проекта: настроена ли, ошибка сервера, последние рассылки */
export interface MailStatus {
  configured: boolean;
  from: string | null;
  perMinute: number;
  serverError: { message: string; at: string } | null;
  list: Mailing[];
}

// ---------- Прохождение опроса ----------

/** Состояние анкеты респондента */
export interface RunnerState {
  rid: string;
  status: ResponseStatus;
  preview: boolean;
  survey: Survey;
  params: Record<string, string>;
  answers: Answers;
  page: string | null;
  canBack: boolean;
  progress: number;
  /** Порядковый номер вопроса у респондента (для «Вопрос N») */
  step: number;
  message?: string;
  /** Куда перенаправить после завершения */
  redirect?: string;
  /** До какого момента нужно закончить (ограничение времени), ISO */
  deadline?: string;
}

/** Опрос закрыт (не начался, закончился, ссылка недействительна…) */
export interface ClosedState { closed: true; title: string; message: string }

/** Нужен пароль */
export interface PasswordState { needPassword: true; title: string; error?: string }

/** Ответ на старт опроса */
export type StartResult = RunnerState | ClosedState | PasswordState;
