import type { AnalyzeResult, FlowGraph, SourceFile } from '../../shared/types.ts';
import { analyze } from './analyzer.ts';
import { buildFlow } from './cfg.ts';
import { buildCallGraph, extractModel, type ExtractedModel, type MethodNode } from './model.ts';
import { collectErrors, parseJava } from './parser.ts';
import { perfDiagnostics } from './perf.ts';
import { scopeFindings } from './scope.ts';
import { buildArchitecture, callScope } from './services.ts';

export function analyzeProject(all: SourceFile[]): AnalyzeResult {
  const files = all.filter((f) => f.path.endsWith('.java')); // pom.xml нужен только сборке
  const result: AnalyzeResult = {
    architecture: { apps: [], externals: [], links: [] },
    types: [], callGraph: [], flows: {}, diagnostics: [], metrics: [], parseErrors: [], scope: [],
  };
  const methods: MethodNode[] = [];
  const trees = files.map((f) => parseJava(f.content));
  trees.forEach((tree, i) => {
    for (const e of collectErrors(tree.rootNode)) result.parseErrors.push({ file: files[i].path, ...e });
  });

  // Одноимённые классы в разных файлах (DTO в нескольких сервисах) получают
  // уточнение в id методов, иначе их блок-схемы и метрики перетёрли бы друг друга.
  let models: ExtractedModel[] = trees.map((t, i) => extractModel(t.rootNode, files[i].path));
  const filesByType = new Map<string, Set<string>>();
  models.forEach((m, i) => m.types.forEach((t) => filesByType.set(t.name, (filesByType.get(t.name) ?? new Set()).add(files[i].path))));
  models = models.map((m, i) =>
    m.types.some((t) => filesByType.get(t.name)!.size > 1) ? extractModel(trees[i].rootNode, files[i].path, files[i].path.replace(/\//g, '.')) : m,
  );
  for (const m of models) {
    result.types.push(...m.types);
    methods.push(...m.methods);
  }

  const sources = new Map(files.map((f) => [f.path, f.content]));
  for (const m of methods) {
    const file = m.info.range.file;
    const flow: FlowGraph = buildFlow(m.info.id, m.info.signature, m.body, file, sources.get(file) ?? '', m.rootId);
    result.flows[m.info.id] = flow;
  }
  result.architecture = buildArchitecture(files, trees, result.types);
  result.callGraph = buildCallGraph(result.types, callScope(result.architecture));
  const ownTypes = new Set(result.types.map((t) => t.name.split('.').pop()!));
  trees.forEach((t, i) => result.scope.push(...scopeFindings(t.rootNode, files[i].path, ownTypes)));
  Object.assign(result, analyze(methods, result.types));
  result.diagnostics.push(...perfDiagnostics(methods, result.types, sources).map((d, i) => ({ id: `p${i}`, ...d })));

  for (const t of trees) t.delete(); // wasm-память освобождаем вручную
  return result;
}
