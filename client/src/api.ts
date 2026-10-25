import type { AnalyzeResult, AppSettings, CommitInfo, CompareResult, CompileResult, DecompositionResult, FixEvent, FixProgress, FixRequest, FixResult, History, PatternApplyRequest, ProjectState, RunResult, SourceFile, SplitPlan, SplitRequest, SplitResult, TestCase, UnitCase } from '../../shared/types.ts';

async function post<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Ход работы приходит событиями по мере генерации; signal отменяет её на сервере. */
async function stream(url: string, body: unknown, onProgress: (p: FixProgress) => void, signal: AbortSignal): Promise<FixResult> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const e = JSON.parse(line) as FixEvent;
      if (e.type === 'progress') onProgress(e.progress);
      else if (e.type === 'result') return e.result;
      else throw new Error(e.error);
    }
  }
  throw new Error('сервер закрыл соединение без результата');
}

export const api = {
  health: (): Promise<{ ok: boolean; java: { ok: boolean; version: string } }> => fetch('/api/health').then((r) => r.json()),
  example: (): Promise<{ files: SourceFile[] }> => fetch('/api/example').then((r) => r.json()),
  analyze: (files: SourceFile[]) => post<AnalyzeResult>('/api/analyze', { files }),
  run: (files: SourceFile[], stdin: string) =>
    post<{ compile: CompileResult; run: RunResult | null; mainClass: string | null; skipped?: string }>('/api/run', { files, stdin }),
  compare: (original: SourceFile[], modified: SourceFile[], tests: TestCase[], unitCases: UnitCase[]) =>
    post<CompareResult>('/api/compare', { original, modified, tests, unitCases }),
  cases: (files: SourceFile[], typeName: string, file: string, methodId: string | undefined, llm: boolean) =>
    post<{ cases: UnitCase[]; warnings: string[] }>('/api/cases', { files, typeName, file, methodId, llm }),
  decompose: (files: SourceFile[], appId: string | null) => post<DecompositionResult>('/api/decompose', { files, appId }),
  settings: async (): Promise<AppSettings> => {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`/api/settings: ${res.status}`);
    return res.json();
  },
  saveSettings: (s: Partial<AppSettings>) => post<AppSettings>('/api/settings', s, 'PUT'),
  ollamaModels: (): Promise<{ ok: boolean; models: string[]; error?: string }> => fetch('/api/ollama/models').then((r) => r.json()),
  /** null — проект открыт впервые. */
  project: async (key: string): Promise<ProjectState | null> => {
    const res = await fetch(`/api/projects/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`/api/projects: ${res.status} ${await res.text()}`);
    return res.json();
  },
  saveProject: (state: Omit<ProjectState, 'updatedAt'>) => post<{ updatedAt: string }>(`/api/projects/${encodeURIComponent(state.key)}`, state, 'PUT'),
  /** Предложение исправлений: ничего не применяется, файлы возвращаются для ревью. */
  fix: (req: FixRequest, onProgress: (p: FixProgress) => void, signal: AbortSignal) => stream('/api/fix', req, onProgress, signal),
  splitPlan: (files: SourceFile[], file: string, typeName: string, parts?: number) => post<SplitPlan>('/api/split/plan', { files, file, typeName, parts }),
  splitApply: (req: SplitRequest) => post<SplitResult>('/api/split/apply', req),
  /** Применение паттерна через LLM: как и исправления — с проверкой и ревью. */
  applyPattern: (req: PatternApplyRequest, onProgress: (p: FixProgress) => void, signal: AbortSignal) => stream('/api/patterns/apply', req, onProgress, signal),
  history: async (key: string): Promise<History> => {
    const res = await fetch(`/api/projects/${encodeURIComponent(key)}/history`);
    if (!res.ok) throw new Error(`/api/history: ${res.status} ${await res.text()}`);
    return res.json();
  },
  commitFiles: async (key: string, id: string): Promise<SourceFile[]> => {
    const res = await fetch(`/api/projects/${encodeURIComponent(key)}/commits/${id}`);
    if (!res.ok) throw new Error(`/api/commits: ${res.status} ${await res.text()}`);
    return (await res.json()).files;
  },
  commit: (key: string, message: string, files: SourceFile[], parentId: string | null) =>
    post<{ commit: CommitInfo; history: History }>(`/api/projects/${encodeURIComponent(key)}/commits`, { message, files, parentId }),
  checkout: (key: string, id: string) => post<History>(`/api/projects/${encodeURIComponent(key)}/head`, { id }, 'PUT'),
};
