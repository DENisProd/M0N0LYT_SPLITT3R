import type { AnalyzeResult, AppSettings, CompareResult, CompileResult, DecompositionResult, ProjectState, RunResult, SourceFile, TestCase, UnitCase } from '../../shared/types.ts';

async function post<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json();
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
};
