import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import type { FixEvent, ProjectState, SourceFile, TestCase } from '../../shared/types.ts';
import { analyzeProject } from './analyze.ts';
import { generateCases } from './cases.ts';
import { decompose } from './decompose.ts';
import { proposeFixes } from './fixes.ts';
import { applyPattern } from './patterns.ts';
import { planSplit, splitClass } from './split.ts';
import { createCommit, getCommitFiles, getHistory, setHead } from './history.ts';
import { initParser } from './parser.ts';
import { checkJava, compareBehavior, compileAndRun } from './runner.ts';
import { getProject, getSettings, listProjects, saveProject, saveSettings } from './store.ts';

const PORT = Number(process.env.PORT ?? 3001);

const isFiles = (v: unknown): v is SourceFile[] =>
  Array.isArray(v) && v.every((f) => typeof f?.path === 'string' && typeof f?.content === 'string');

await initParser();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // проект целиком, а не один файл

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, java: await checkJava() });
});

app.get('/api/example', async (_req, res) => {
  const file = fileURLToPath(new URL('../../examples/OrderApp.java', import.meta.url));
  res.json({ files: [{ path: 'OrderApp.java', content: await readFile(file, 'utf8') }] });
});

app.post('/api/analyze', (req, res) => {
  const { files } = req.body ?? {};
  if (!isFiles(files)) return void res.status(400).json({ error: 'files: SourceFile[] required' });
  res.json(analyzeProject(files));
});

app.post('/api/run', async (req, res) => {
  const { files, stdin = '', mainClass } = req.body ?? {};
  if (!isFiles(files)) return void res.status(400).json({ error: 'files: SourceFile[] required' });
  res.json(await compileAndRun(files, String(stdin), mainClass));
});

app.post('/api/compare', async (req, res) => {
  const { original, modified, tests, mainClass, unitCases } = req.body ?? {};
  if (!isFiles(original) || !isFiles(modified)) {
    return void res.status(400).json({ error: 'original, modified: SourceFile[] required' });
  }
  const cases: TestCase[] = Array.isArray(tests) && tests.length ? tests : [{ name: 'empty-stdin', stdin: '' }];
  res.json(await compareBehavior(original, modified, cases, mainClass, Array.isArray(unitCases) ? unitCases : []));
});

app.post('/api/cases', async (req, res) => {
  const { files, typeName, file, methodId, llm } = req.body ?? {};
  if (!isFiles(files) || typeof typeName !== 'string' || typeof file !== 'string') {
    return void res.status(400).json({ error: 'files, typeName, file required' });
  }
  res.json(await generateCases({ files, typeName, file, methodId: typeof methodId === 'string' ? methodId : undefined, llm: !!llm }));
});

app.post('/api/decompose', (req, res) => {
  const { files, appId } = req.body ?? {};
  if (!isFiles(files)) return void res.status(400).json({ error: 'files: SourceFile[] required' });
  res.json(decompose(files, analyzeProject(files), typeof appId === 'string' ? appId : null));
});

app.post('/api/fix', async (req, res) => {
  const { files, ids, llm, tests, unitCases } = req.body ?? {};
  if (!isFiles(files)) return void res.status(400).json({ error: 'files: SourceFile[] required' });
  const wanted = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : undefined;
  // Генерация идёт минутами: ход работы уходит клиенту построчно (NDJSON), закрытие соединения её отменяет.
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const controller = new AbortController();
  res.on('close', () => !res.writableFinished && controller.abort());
  const send = (e: FixEvent) => res.write(JSON.stringify(e) + '\n');
  try {
    const result = await proposeFixes(
      { files, ids: wanted, llm: !!llm, tests: Array.isArray(tests) ? tests : [], unitCases: Array.isArray(unitCases) ? unitCases : [] },
      { onProgress: (progress) => send({ type: 'progress', progress }), signal: controller.signal },
    );
    send({ type: 'result', result });
  } catch (e) {
    if (!controller.signal.aborted) send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
  }
  res.end();
});

app.post('/api/split/plan', (req, res) => {
  const { files, file, typeName, parts } = req.body ?? {};
  if (!isFiles(files) || typeof file !== 'string' || typeof typeName !== 'string') return void res.status(400).json({ error: 'files, file, typeName required' });
  res.json(planSplit(files, file, typeName, typeof parts === 'number' ? parts : undefined));
});

app.post('/api/split/apply', async (req, res) => {
  const { files, plan, tests, unitCases } = req.body ?? {};
  if (!isFiles(files) || !plan || !Array.isArray(plan.parts)) return void res.status(400).json({ error: 'files, plan required' });
  try {
    res.json(await splitClass({ files, plan, tests: Array.isArray(tests) ? tests : [], unitCases: Array.isArray(unitCases) ? unitCases : [] }));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/patterns/apply', async (req, res) => {
  const { files, findingId, tests, unitCases } = req.body ?? {};
  if (!isFiles(files) || typeof findingId !== 'string') return void res.status(400).json({ error: 'files, findingId required' });
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const controller = new AbortController();
  res.on('close', () => !res.writableFinished && controller.abort());
  const send = (e: FixEvent) => res.write(JSON.stringify(e) + '\n');
  try {
    const result = await applyPattern(
      { files, findingId, tests: Array.isArray(tests) ? tests : [], unitCases: Array.isArray(unitCases) ? unitCases : [] },
      { onProgress: (progress) => send({ type: 'progress', progress }), signal: controller.signal },
    );
    send({ type: 'result', result });
  } catch (e) {
    if (!controller.signal.aborted) send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
  }
  res.end();
});

app.get('/api/settings', async (_req, res) => {
  res.json(await getSettings());
});

app.put('/api/settings', async (req, res) => {
  res.json(await saveSettings(req.body ?? {}));
});

/** Модели, установленные в Ollama по сохранённому адресу, — для выбора в настройках. */
app.get('/api/ollama/models', async (_req, res) => {
  const { ollamaUrl } = await getSettings();
  try {
    const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { models?: { name: string }[] };
    res.json({ ok: true, models: (body.models ?? []).map((m) => m.name) });
  } catch (e) {
    console.warn(`Ollama недоступна по ${ollamaUrl}: ${e}`);
    res.json({ ok: false, models: [], error: `Ollama недоступна по ${ollamaUrl}: ${e instanceof Error ? e.message : e}` });
  }
});

app.get('/api/projects', async (_req, res) => {
  res.json(await listProjects());
});

app.get('/api/projects/:key', async (req, res) => {
  const state = await getProject(req.params.key);
  if (!state) return void res.status(404).json({ error: 'not found' });
  res.json(state);
});

app.put('/api/projects/:key', async (req, res) => {
  const body = (req.body ?? {}) as Partial<ProjectState>;
  if (!Array.isArray(body.tests) || !Array.isArray(body.unitCases)) return void res.status(400).json({ error: 'tests, unitCases required' });
  const updatedAt = await saveProject({
    key: req.params.key,
    name: typeof body.name === 'string' ? body.name : req.params.key,
    tests: body.tests,
    unitCases: body.unitCases,
    decomposition: body.decomposition ?? null,
  });
  res.json({ updatedAt });
});

app.get('/api/projects/:key/history', async (req, res) => {
  res.json(await getHistory(req.params.key));
});

app.get('/api/projects/:key/commits/:id', async (req, res) => {
  const files = await getCommitFiles(req.params.key, req.params.id);
  if (!files) return void res.status(404).json({ error: 'commit not found' });
  res.json({ files });
});

app.post('/api/projects/:key/commits', async (req, res) => {
  const { message, files, parentId } = req.body ?? {};
  if (!isFiles(files) || typeof message !== 'string' || !message.trim()) return void res.status(400).json({ error: 'message, files required' });
  const commit = await createCommit(req.params.key, message.trim(), files, typeof parentId === 'string' ? parentId : null);
  res.json({ commit, history: await getHistory(req.params.key) });
});

app.put('/api/projects/:key/head', async (req, res) => {
  const { id } = req.body ?? {};
  if (typeof id !== 'string' || !(await setHead(req.params.key, id))) return void res.status(404).json({ error: 'commit not found' });
  res.json(await getHistory(req.params.key));
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`Dark Secrets server: http://localhost:${PORT}`));
