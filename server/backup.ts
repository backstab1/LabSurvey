// Резервные копии базы по расписанию: data/backups/surveylab-YYYY-MM-DD_HH-MM.db, хранятся последние N.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { backupTo } from './db.ts';

const NAME_RE = /^surveylab-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(-\d+)?\.db$/;

export interface BackupFile { name: string; size: number; createdAt: string }

export function listBackups(): BackupFile[] {
  if (!existsSync(config.backupDir)) return [];
  return readdirSync(config.backupDir)
    .filter((n) => NAME_RE.test(n))
    .map((name) => {
      const st = statSync(join(config.backupDir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Путь к копии по имени (только файлы копий, без выхода из папки) */
export function backupPath(name: string): string | null {
  return NAME_RE.test(name) && existsSync(join(config.backupDir, name)) ? join(config.backupDir, name) : null;
}

export function makeBackup(): BackupFile {
  mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  let name = `surveylab-${stamp}.db`;
  for (let i = 2; existsSync(join(config.backupDir, name)); i++) name = `surveylab-${stamp}-${i}.db`;
  backupTo(join(config.backupDir, name));
  // Старые копии сверх лимита удаляются
  for (const old of listBackups().slice(config.backupKeep)) rmSync(join(config.backupDir, old.name));
  return listBackups().find((b) => b.name === name)!;
}

/** Запускает копирование по расписанию; первая копия — если последней больше интервала */
export function scheduleBackups(): void {
  if (!(config.backupHours > 0)) return;
  const interval = config.backupHours * 3600_000;
  const tick = () => {
    try {
      const last = listBackups()[0];
      if (!last || Date.now() - Date.parse(last.createdAt) >= interval - 60_000) makeBackup();
    } catch (e) {
      console.error('Резервная копия не создана:', e);
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, Math.min(interval, 3600_000)).unref();
}
