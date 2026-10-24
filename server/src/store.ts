import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import type { AppSettings, ProjectState } from '../../shared/types.ts';
import { PrismaClient, type Prisma } from './generated/prisma/client.ts';

// Настройки и состояние проектов в SQLite через Prisma. Путь к БД — как в prisma.config.ts.
const DEFAULT_DB = fileURLToPath(new URL('../data/jbp.db', import.meta.url));
mkdirSync(fileURLToPath(new URL('../data/', import.meta.url)), { recursive: true });
const url = process.env.DATABASE_URL?.replace(/^file:/, '') ?? DEFAULT_DB;

export const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

/** Значения по умолчанию — из переменных окружения, сохранённые в БД их перекрывают. */
export const DEFAULT_SETTINGS: AppSettings = {
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen2.5:14b-instruct',
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 300_000),
  llmByDefault: true,
};

const SETTINGS_KEY = 'app';
let cached: AppSettings | null = null;

export async function getSettings(): Promise<AppSettings> {
  if (cached) return cached;
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  cached = { ...DEFAULT_SETTINGS, ...(row?.value as Partial<AppSettings> | undefined) };
  return cached;
}

/** Сохраняет только известные поля с правильными типами; остальное игнорируется. */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = { ...current };
  if (typeof patch.ollamaUrl === 'string' && patch.ollamaUrl.trim()) next.ollamaUrl = patch.ollamaUrl.trim().replace(/\/+$/, '');
  if (typeof patch.ollamaModel === 'string' && patch.ollamaModel.trim()) next.ollamaModel = patch.ollamaModel.trim();
  if (typeof patch.llmTimeoutMs === 'number' && patch.llmTimeoutMs >= 10_000) next.llmTimeoutMs = Math.round(patch.llmTimeoutMs);
  if (typeof patch.llmByDefault === 'boolean') next.llmByDefault = patch.llmByDefault;
  const value = next as unknown as Prisma.InputJsonObject;
  await prisma.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value }, update: { value } });
  cached = next;
  return next;
}

export async function getProject(key: string): Promise<ProjectState | null> {
  const row = await prisma.project.findUnique({ where: { key } });
  if (!row) return null;
  return {
    key: row.key,
    name: row.name,
    tests: row.tests as unknown as ProjectState['tests'],
    unitCases: row.unitCases as unknown as ProjectState['unitCases'],
    decomposition: (row.decomposition ?? null) as ProjectState['decomposition'],
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function saveProject(state: Omit<ProjectState, 'updatedAt'>): Promise<string> {
  const data = {
    name: state.name,
    tests: state.tests as unknown as Prisma.InputJsonArray,
    unitCases: state.unitCases as unknown as Prisma.InputJsonArray,
    decomposition: (state.decomposition ?? undefined) as Prisma.InputJsonObject | undefined,
  };
  const row = await prisma.project.upsert({ where: { key: state.key }, create: { key: state.key, ...data }, update: data });
  return row.updatedAt.toISOString();
}

export async function listProjects(): Promise<{ key: string; name: string; updatedAt: string }[]> {
  const rows = await prisma.project.findMany({ select: { key: true, name: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 50 });
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}
