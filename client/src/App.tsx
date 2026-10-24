import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  Download,
  FileCode,
  Boxes,
  FlaskConical,
  FolderOpen,
  Library,
  Network,
  Server,
  Lambda,
  LayoutGrid,
  LoaderCircle,
  Pin,
  Play,
  Scissors,
  Settings,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import type {
  AnalyzeResult,
  AppSettings,
  DecompositionChoice,
  CompareResult,
  Diagnostic,
  FlowNode,
  MethodInfo,
  Range,
  ScopeCategory,
  ScopeFinding,
  Severity,
  SourceFile,
  TestCase,
  TypeInfo,
  UnitCase,
} from '../../shared/types.ts';
import { api } from './api.ts';
import { projectKey, readJavaFiles } from './project.ts';
import { BLOCKS, deleteRange, insertAfter, insertAtBodyStart, replaceRange } from './edits.ts';
import { KIND } from './theme.ts';
import { AnalysisPanel } from './components/AnalysisPanel.tsx';
import { AppsView } from './components/AppsView.tsx';
import { BoundaryView, typeKey } from './components/BoundaryView.tsx';
import { BottomPanel, type BottomTab, type LogLine } from './components/BottomPanel.tsx';
import { ClassView } from './components/ClassView.tsx';
import { CasesPanel, type CasesTarget } from './components/CasesPanel.tsx';
import { CodeEditor } from './components/CodeEditor.tsx';
import { DecomposeView } from './components/DecomposeView.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { FlowView } from './components/FlowView.tsx';

const ANALYZE_DELAY_MS = 400;
const SAVE_DELAY_MS = 800;

const DEFAULT_TESTS: TestCase[] = [
  { name: 'empty', stdin: '' },
  { name: 'single', stdin: '1\n1;Анна;50\n' },
  { name: 'duplicates', stdin: '4\n1;Анна;50\n2;Борис;700\n1;Анна;25.5\n3;Вера;1500\n' },
  { name: 'invalid', stdin: '3\n1;Анна;abc\nбез разделителей\n2;Борис;-5\n' },
  { name: 'not-a-number', stdin: 'abc\n' },
];

type JavaStatus = { state: 'checking' } | { state: 'ok'; version: string } | { state: 'missing' } | { state: 'offline' };

const now = () => new Date().toLocaleTimeString('ru-RU');
const contains = (r: Range | undefined, file: string, offset: number) => !!r && r.file === file && r.start <= offset && offset <= r.end;
const size = (r: Range) => r.end - r.start;

function download(file: SourceFile) {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/x-java' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: file.path.split('/').pop() });
  a.click();
  URL.revokeObjectURL(url);
}

const TYPE_KIND: Record<TypeInfo['kind'], string> = { class: 'class', interface: 'interface', enum: 'enum', record: 'record' };

/** Строка-подпись под типом: компоненты record или константы enum. */
function typeDetails(t: TypeInfo): string | null {
  if (t.components) return `(${t.components.map((c) => `${c.type} ${c.name}`).join(', ')})`;
  if (t.constants?.length) return t.constants.join(', ');
  return null;
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="2.5" width="7" height="5" rx="1.5" />
      <rect x="14.5" y="9.5" width="7" height="5" rx="1.5" />
      <rect x="2.5" y="16.5" width="7" height="5" rx="1.5" />
      <path d="M6 7.5v9M9.5 5H12a2 2 0 0 1 2 2v2.5M6 12h8.5" />
    </svg>
  );
}

export function App() {
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<{ files: SourceFile[]; at: string } | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [analyzedFiles, setAnalyzedFiles] = useState<SourceFile[] | null>(null);
  // Уровни: приложения → классы в границах приложений → методы → блок-схема метода.
  const [view, setView] = useState<'apps' | 'boundaries' | 'classes' | 'flow' | 'decompose'>('classes');
  const [decomposition, setDecomposition] = useState<DecompositionChoice>({ appId: null, variant: null });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Открытый проект; задаётся после восстановления сохранённого состояния — до этого автосохранение молчит. */
  const [project, setProject] = useState<{ key: string; name: string } | null>(null);
  /** Приложение, методы которого показаны в обзоре; null — весь проект. */
  const [appFilter, setAppFilter] = useState<string | null>(null);
  const [focusType, setFocusType] = useState<string | null>(null);
  const [focusApp, setFocusApp] = useState<string | null>(null);
  // Первый анализ после загрузки выбирает стартовый уровень: у микросервисов — карта приложений.
  const freshLoad = useRef(false);
  const [methodId, setMethodId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedDiagnosticId, setSelectedDiagnosticId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Range | null>(null);
  const [tests, setTests] = useState<TestCase[]>(DEFAULT_TESTS);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [compare, setCompare] = useState<CompareResult | null>(null);
  const [unitCases, setUnitCases] = useState<UnitCase[]>([]);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState<'run' | 'verify' | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('console');
  const [java, setJava] = useState<JavaStatus>({ state: 'checking' });
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const log = useCallback((text: string, kind?: LogLine['kind']) => setLogs((l) => [...l.slice(-300), { time: now(), text, kind }]), []);

  // Граф строится из последнего проанализированного кода; пока анализ
  // не догнал правки, диапазоны устарели и редактировать из графа нельзя.
  const stale = analyzedFiles !== files;
  // Код изменён относительно эталона, а проверка ещё не запускалась.
  const dirty = !!baseline && baseline.files !== files;

  useEffect(() => {
    let cancelled = false; // StrictMode вызывает эффект дважды — пишем в консоль один раз
    api.health()
      .then((h) => {
        if (cancelled) return;
        setJava(h.java.ok ? { state: 'ok', version: h.java.version.replace(/^javac\s*/, '') } : { state: 'missing' });
        if (!h.java.ok) log('JDK не найден. Укажите JAVA_HOME для сервера, чтобы запускать и сравнивать программы.', 'error');
      })
      .catch(() => {
        if (cancelled) return;
        setJava({ state: 'offline' });
        log('Сервер анализа недоступен. Запустите npm run dev в корне проекта.', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [log]);

  useEffect(() => {
    api.settings().then(setSettings).catch((e) => log(`Настройки не загружены: ${e}`, 'error'));
  }, [log]);

  // Тесты, тест-кейсы и выбор распила сохраняются в БД с небольшой задержкой после правки.
  useEffect(() => {
    if (!project) return;
    const timer = setTimeout(() => {
      api.saveProject({ key: project.key, name: project.name, tests, unitCases, decomposition })
        .catch((e) => log(`Состояние проекта не сохранено: ${e}`, 'error'));
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [project, tests, unitCases, decomposition, log]);

  useEffect(() => {
    if (!files.length) return;
    const snapshot = files;
    const timer = setTimeout(() => {
      api.analyze(snapshot)
        .then((r) => {
          setAnalysis(r);
          setAnalyzedFiles(snapshot);
          if (freshLoad.current) {
            freshLoad.current = false;
            const apps = r.architecture.apps.length;
            if (apps > 1) {
              setView('apps');
              log(`Найдено приложений: ${apps}, связей между ними: ${r.architecture.links.length}.`, 'ok');
            }
          }
        })
        .catch((e) => log(`Анализ не выполнен: ${e}`, 'error'));
    }, ANALYZE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [files, log]);

  const restoreProject = async (loaded: SourceFile[], name: string) => {
    const key = await projectKey(loaded);
    try {
      const saved = await api.project(key);
      if (saved) {
        setTests(saved.tests);
        setUnitCases(saved.unitCases);
        if (saved.decomposition) setDecomposition(saved.decomposition);
        log(`Восстановлено состояние проекта «${saved.name}» от ${new Date(saved.updatedAt).toLocaleString('ru-RU')}: тестов ${saved.tests.length}, тест-кейсов ${saved.unitCases.length}.`, 'ok');
      }
    } catch (e) {
      log(`Сохранённое состояние проекта не загружено: ${e}`, 'error');
    }
    setProject({ key, name });
  };

  const loadFiles = (loaded: SourceFile[], name: string) => {
    if (!loaded.length) return log('В выбранных файлах нет .java', 'error');
    setProject(null);
    setDecomposition({ appId: null, variant: null });
    void restoreProject(loaded, name);
    setFiles(loaded);
    setActivePath(loaded[0].path);
    setBaseline({ files: loaded, at: now() }); // загруженная версия — эталон поведения
    setCompare(null);
    setUnitCases([]); // кейсы ссылаются на классы прежнего проекта
    setView('classes');
    setAppFilter(null);
    setFocusType(null);
    setFocusApp(null);
    freshLoad.current = true;
    setMethodId(null);
    setSelectedNodeId(null);
    setSelectedDiagnosticId(null);
    log(`Загружено файлов: ${loaded.length}. Исходная версия зафиксирована как эталон.`, 'ok');
  };

  const importFiles = async (input: HTMLInputElement) => {
    const list = input.files;
    if (!list?.length) return;
    const { files: loaded, name, skipped } = await readJavaFiles(list);
    input.value = ''; // повторный выбор той же папки снова вызовет onChange
    if (skipped.build) log(`Пропущено файлов из служебных каталогов (target, build, .git…): ${skipped.build}`);
    if (skipped.test) log(`Пропущено тестов из src/test (JUnit недоступен для запуска): ${skipped.test}`);
    loadFiles(loaded, name);
  };

  const openExample = () => api.example().then((r) => loadFiles(r.files, 'Пример')).catch(() => log('Не удалось загрузить пример: сервер недоступен', 'error'));

  const methods = useMemo(() => analysis?.types.flatMap((t) => t.methods) ?? [], [analysis]);
  const method: MethodInfo | undefined = methods.find((m) => m.id === methodId);
  const flow = methodId ? analysis?.flows[methodId] : undefined;
  const selectedNode = flow?.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const activeFile = files.find((f) => f.path === activePath);
  const metrics = analysis?.metrics.find((m) => m.methodId === methodId);

  const lambdasByParent = useMemo(() => {
    const map = new Map<string, MethodInfo[]>();
    for (const m of methods) if (m.parentId) map.set(m.parentId, [...(map.get(m.parentId) ?? []), m]);
    return map;
  }, [methods]);
  const parentMethod = method?.parentId ? methods.find((m) => m.id === method.parentId) : undefined;
  const rootMethod = useMemo(() => {
    let m = method;
    while (m?.parentId) m = methods.find((x) => x.id === m!.parentId);
    return m;
  }, [method, methods]);

  const issuesByMethod = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of analysis?.diagnostics ?? []) if (d.methodId) map.set(d.methodId, (map.get(d.methodId) ?? 0) + 1);
    return map;
  }, [analysis]);

  const nodeSeverity = useMemo(() => {
    const map = new Map<string, Severity>();
    if (!flow || !analysis) return map;
    const rank = { high: 3, medium: 2, low: 1 };
    // Проблемы уровня метода (длина, CC) видны в панели, на узлы не вешаем.
    // Привязка по диапазону, а не по methodId: так дефект внутри лямбды виден и на её схеме.
    const owner = method?.range;
    const inOwner = (d: Diagnostic) => !!owner && d.range.file === owner.file && d.range.start >= owner.start && d.range.start <= owner.end;
    for (const d of analysis.diagnostics.filter((x) => inOwner(x) && x.rule !== 'long-method' && x.rule !== 'high-cyclomatic')) {
      // Помечаем самый внешний узел, начинающийся внутри диапазона проблемы.
      const target = flow.nodes
        .filter((n) => n.stmtRange && contains(d.range, n.stmtRange.file, n.stmtRange.start))
        .sort((a, b) => size(b.stmtRange!) - size(a.stmtRange!))[0]
        // проблема внутри выражения (например, в условии) — ближайший охватывающий узел
        ?? flow.nodes
          .filter((n) => n.stmtRange && contains(n.stmtRange, d.range.file, d.range.start))
          .sort((a, b) => size(a.stmtRange!) - size(b.stmtRange!))[0];
      if (target && (!map.has(target.id) || rank[d.severity] > rank[map.get(target.id)!])) map.set(target.id, d.severity);
    }
    return map;
  }, [flow, analysis, method]);

  // Узлы с конструкциями вне рамок кейса — самый узкий узел, содержащий находку.
  const nodeScope = useMemo(() => {
    const map = new Map<string, ScopeCategory>();
    if (!flow || !analysis) return map;
    for (const f of analysis.scope) {
      const target = flow.nodes
        .filter((n) => n.stmtRange && contains(n.stmtRange, f.range.file, f.range.start))
        .sort((a, b) => size(a.stmtRange!) - size(b.stmtRange!))[0];
      if (target && !map.has(target.id)) map.set(target.id, f.category);
    }
    return map;
  }, [flow, analysis]);

  const openMethod = (id: string) => {
    const m = methods.find((x) => x.id === id);
    setMethodId(id);
    setView('flow');
    setSelectedNodeId(null);
    setSelectedDiagnosticId(null);
    if (m) {
      setActivePath(m.range.file);
      setHighlight(m.range);
    }
  };

  const apps = useMemo(() => analysis?.architecture.apps ?? [], [analysis]);
  const multiApp = apps.length > 1;
  const appOfFile = useMemo(() => new Map(apps.flatMap((a) => a.files.map((f) => [f, a] as const))), [apps]);
  const filteredApp = apps.find((a) => a.id === appFilter);
  const methodApp = method ? appOfFile.get(method.range.file) : undefined;

  const openBoundaries = (appId: string | null) => {
    setFocusApp(appId);
    setView('boundaries');
  };
  const openAppMethods = (appId: string | null, type: string | null = null) => {
    setAppFilter(appId);
    setFocusType(type);
    setView('classes');
  };
  const openTypeMethods = (key: string) => {
    const t = analysis?.types.find((x) => typeKey(x) === key);
    openAppMethods(t ? appOfFile.get(t.file)?.id ?? null : null, key);
  };
  const pickRange = (r: Range) => {
    setActivePath(r.file);
    setHighlight(r);
  };

  const openMethodRef = useRef(openMethod);
  openMethodRef.current = openMethod;
  // Стабильная ссылка: FlowView передаёт её в данные узлов, пересоздание сбросило бы узлы.
  const openMethodCb = useCallback((id: string) => openMethodRef.current(id), []);

  const selectNode = (n: FlowNode | null) => {
    setSelectedNodeId(n?.id ?? null);
    setHighlight(n?.stmtRange ?? n?.range ?? method?.range ?? null);
  };

  // Код → граф: клик в редакторе выбирает метод и ближайший узел.
  const onCursor = (offset: number) => {
    if (!activePath || stale) return;
    const m = methods.filter((x) => contains(x.range, activePath, offset)).sort((a, b) => size(a.range) - size(b.range))[0];
    if (!m) return;
    const f = analysis?.flows[m.id];
    const node = f?.nodes
      .filter((n) => contains(n.stmtRange ?? n.range, activePath, offset))
      .sort((a, b) => size(a.stmtRange ?? a.range!) - size(b.stmtRange ?? b.range!))[0];
    setMethodId(m.id);
    setView('flow');
    setSelectedNodeId(node?.id ?? null);
  };

  const pickScope = (f: ScopeFinding) => {
    const m = methods.filter((x) => contains(x.range, f.range.file, f.range.start)).sort((a, b) => size(a.range) - size(b.range))[0];
    if (m) {
      setMethodId(m.id);
      setView('flow');
    }
    setActivePath(f.range.file);
    setHighlight(f.range);
    setSelectedNodeId(null);
    setSelectedDiagnosticId(null);
  };

  const pickDiagnostic = (d: Diagnostic) => {
    if (d.methodId) {
      setMethodId(d.methodId);
      setView('flow');
    }
    setSelectedDiagnosticId(d.id);
    setActivePath(d.range.file);
    setHighlight(d.range);
    setSelectedNodeId(null);
  };

  // Граф → код.
  const editNode = useCallback(
    (n: FlowNode, text: string) => {
      if (stale || !n.range) return;
      setFiles((fs) => replaceRange(fs, n.range!, text));
      log(`Изменён блок в строке ${n.range.startLine}: ${text}`);
    },
    [stale, log],
  );

  const insertBlock = (snippet: string, title: string) => {
    if (stale || !method) return;
    if (selectedNode?.stmtRange) setFiles((fs) => insertAfter(fs, selectedNode.stmtRange!, snippet));
    else if (method.bodyRange) setFiles((fs) => insertAtBodyStart(fs, method.bodyRange!, snippet));
    else return;
    log(`Добавлен блок «${title}»`);
  };

  const deleteSelected = () => {
    if (stale || !selectedNode?.stmtRange) return;
    setFiles((fs) => deleteRange(fs, selectedNode.stmtRange!));
    setSelectedNodeId(null);
    log(`Удалён блок в строке ${selectedNode.stmtRange.startLine}`);
  };

  const run = async () => {
    setBusy('run');
    setBottomTab('console');
    log('Компиляция…');
    try {
      const r = await api.run(files, tests[0]?.stdin ?? '');
      if (!r.compile.ok) return log(`Ошибка компиляции\n${r.compile.errors}`, 'error');
      if (r.skipped) return log(`Компиляция успешна за ${Math.round(r.compile.durationMs)} мс. Запуск не выполнялся: ${r.skipped}.`, 'ok');
      log(`Компиляция успешна за ${Math.round(r.compile.durationMs)} мс. Запуск ${r.mainClass} на тесте «${tests[0]?.name ?? 'пустой ввод'}»`, 'ok');
      if (r.run) {
        if (r.run.stdout) log(r.run.stdout);
        if (r.run.stderr) log(r.run.stderr, 'error');
        log(`Код выхода ${r.run.exitCode}${r.run.timedOut ? ', превышен таймаут' : ''} · ${Math.round(r.run.durationMs)} мс`);
      }
    } catch (e) {
      log(`Запуск не выполнен: ${e}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    if (!baseline) return;
    setBusy('verify');
    log('Сравнение поведения: эталон и текущая версия на всех тестах…');
    try {
      const r = await api.compare(baseline.files, files, tests, unitCases);
      setCompare(r);
      setBottomTab('results');
      const compiles = r.originalCompile.ok && r.modifiedCompile.ok;
      if (compiles && r.runSkipped && r.total === 0) log(`Обе версии компилируются. Поведение не сравнивалось: ${r.runSkipped}.`);
      else if (compiles && r.passed === r.total) log(`Поведение сохранено: ${r.passed} из ${r.total}`, 'ok');
      else log(compiles ? `Поведение изменилось: совпало ${r.passed} из ${r.total}` : 'Одна из версий не компилируется', 'error');
    } catch (e) {
      log(`Проверка не выполнена: ${e}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  // Цель генерации: открытый метод (для лямбды — её метод) или класс, выбранный в границах приложений.
  const casesTarget = useMemo((): CasesTarget | null => {
    const types = analysis?.types ?? [];
    if (rootMethod && view === 'flow') {
      const type = types.find((t) => t.methods.some((m) => m.id === rootMethod.id));
      if (type) return { type, method: rootMethod };
    }
    const type = focusType ? types.find((t) => typeKey(t) === focusType) : undefined;
    return type ? { type } : null;
  }, [analysis, rootMethod, view, focusType]);

  const fieldsOf = useCallback((c: UnitCase) => {
    const t = analysis?.types.find((x) => x.binaryName === c.binaryName && x.file === c.file);
    const plain = /^(int|long|short|byte|double|float|boolean|char|String|Integer|Long|Short|Byte|Double|Float|Boolean|Character)$/;
    return t?.fields.filter((f) => !f.isStatic && !plain.test(f.type)).map((f) => f.name) ?? [];
  }, [analysis]);

  const unitResults = useMemo(() => new Map((compare?.units ?? []).map((u) => [u.id, u])), [compare]);

  const generateUnitCases = async (scope: 'method' | 'class', llm: boolean) => {
    if (!casesTarget) return;
    const { type } = casesTarget;
    const methodId = scope === 'method' ? casesTarget.method?.id : undefined;
    const title = `${type.name}${methodId ? `.${casesTarget.method!.signature}` : ''}`;
    setGenerating(true);
    setBottomTab('cases');
    log(`Генерация тест-кейсов для ${title}${llm ? ' (эвристики + LLM)' : ' (эвристики)'}…`);
    try {
      const r = await api.cases(files, type.name, type.file, methodId, llm);
      // Повторная генерация заменяет прежние сгенерированные кейсы той же цели; ручные остаются.
      const replaced = (c: UnitCase) => c.source !== 'manual' && c.file === type.file && c.binaryName === type.binaryName && (!methodId || c.methodId === methodId);
      setUnitCases((cs) => [...cs.filter((c) => !replaced(c)), ...r.cases]);
      for (const w of r.warnings) log(w, 'error');
      log(`Тест-кейсов для ${title}: ${r.cases.length}`, r.cases.length ? 'ok' : 'error');
    } catch (e) {
      log(`Генерация тест-кейсов не выполнена: ${e}`, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const pinBaseline = () => {
    setBaseline({ files, at: now() });
    setCompare(null);
    log('Текущая версия зафиксирована как эталон', 'ok');
  };

  const updateActiveFile = (content: string) => {
    if (!activePath) return;
    setFiles((fs) => fs.map((f) => (f.path === activePath ? { ...f, content } : f)));
  };

  const compiled = !!compare && compare.originalCompile.ok && compare.modifiedCompile.ok;
  const verdict = compare && (
    compiled && compare.runSkipped && compare.total === 0 ? 'warn'
      : compiled && compare.passed === compare.total ? 'ok'
      : compiled && compare.flaky > 0 && compare.cases.every((c) => c.passed || c.flaky) ? 'warn'
        : 'bad'
  );
  const javaReady = java.state === 'ok';

  // Метод и его лямбды; лямбды раскрываются, когда открыт метод или одна из его лямбд.
  function renderMethod(m: MethodInfo, depth: number): ReactElement {
    const lambdas = lambdasByParent.get(m.id) ?? [];
    const expanded = rootMethod?.id === m.id.split('/')[0]; // id лямбды начинается с id её метода
    const active = m.id === methodId && view === 'flow';
    return (
      <div key={m.id}>
        <button
          className={`side-item tree-method${active ? ' is-active' : ''}${m.kind === 'lambda' ? ' is-lambda' : ''}`}
          style={{ paddingLeft: 18 + depth * 14 }}
          onClick={() => openMethod(m.id)}
          title={m.typeParameters ? `${m.typeParameters} ${m.signature}` : m.signature}
        >
          {m.kind === 'lambda' && <Lambda size={12} strokeWidth={2.5} />}
          <span className="ellipsis mono">
            {m.typeParameters && <span className="type-params">{m.typeParameters} </span>}
            {m.kind === 'lambda' ? m.signature.replace(/^λ\s*/, '') : m.signature}
          </span>
          {issuesByMethod.get(m.id) ? <span className="issue-count">{issuesByMethod.get(m.id)}</span> : null}
          {m.kind !== 'lambda' && lambdas.length > 0 && !expanded && <span className="lambda-count" title="Лямбд в методе">λ{lambdas.length}</span>}
        </button>
        {expanded && lambdas.map((l) => renderMethod(l, depth + 1))}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <Logo />
          <span>Java Blueprints</span>
        </div>
        <input ref={fileInput} type="file" accept=".java" multiple hidden onChange={(e) => importFiles(e.currentTarget)} />
        {/* webkitdirectory нет в типах React — атрибут ставится через ref */}
        <input
          ref={(el) => {
            folderInput.current = el;
            el?.setAttribute('webkitdirectory', '');
          }} type="file" hidden onChange={(e) => importFiles(e.currentTarget)}
        />
        <div className="btn-group">
          <button className="btn ghost" onClick={() => fileInput.current?.click()}>
            <Upload size={15} /> Импорт
          </button>
          <button className="btn ghost" onClick={() => folderInput.current?.click()} title="Папка проекта целиком: пути пакетов сохраняются">
            <FolderOpen size={15} /> Проект
          </button>
          <button className="btn ghost" onClick={openExample}>
            <FileCode size={15} /> Пример
          </button>
          <button className="btn ghost" disabled={!files.length} onClick={() => files.forEach(download)}>
            <Download size={15} /> Экспорт
          </button>
        </div>

        <div className="status-strip">
          <span className={`status ${javaReady ? 'is-ok' : java.state === 'checking' ? '' : 'is-bad'}`} title={javaReady ? java.version : undefined}>
            <span className="dot" />
            {java.state === 'checking' ? 'Проверка JDK' : javaReady ? java.version : java.state === 'offline' ? 'Сервер недоступен' : 'JDK не найден'}
          </span>
          {baseline && (
            <span className={`status ${dirty ? 'is-warn' : ''}`}>
              <span className="dot" />
              {dirty ? 'Код изменён после эталона' : `Эталон от ${baseline.at}`}
            </span>
          )}
          {verdict && (
            <span className={`status is-${verdict}`}>
              {verdict === 'ok' ? <CircleCheck size={13} /> : verdict === 'warn' ? <TriangleAlert size={13} /> : <CircleX size={13} />}
              {compare.runSkipped && compiled && compare.total === 0 ? 'Только компиляция' : `${compare.passed}/${compare.total} тестов`}
            </span>
          )}
        </div>

        <div className="btn-group">
          <button className="icon-btn neutral" onClick={() => setShowSettings(true)} disabled={!settings} aria-label="Настройки" title="Настройки">
            <Settings size={16} />
          </button>
          <button className="btn ghost" disabled={!files.length} onClick={pinBaseline} title="Сделать текущую версию эталоном для сравнения">
            <Pin size={15} /> Зафиксировать эталон
          </button>
          <button className="btn" disabled={!files.length || !!busy || !javaReady} onClick={run} title={javaReady ? undefined : 'Нужен JDK'}>
            {busy === 'run' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />} Запуск
          </button>
          <button className="btn primary" disabled={!baseline || !!busy || !javaReady} onClick={verify} title={javaReady ? undefined : 'Нужен JDK'}>
            {busy === 'verify' ? <LoaderCircle size={15} className="spin" /> : <FlaskConical size={15} />} Проверить поведение
          </button>
        </div>
      </header>

      <aside className="sidebar" aria-label="Проект">
        <div className="side-section">
          <h2 className="side-title">Файлы</h2>
          {files.length === 0 && <p className="side-empty">Нет загруженных файлов</p>}
          {files.map((f) => (
            <button key={f.path} className={`side-item${f.path === activePath ? ' is-active' : ''}`} onClick={() => setActivePath(f.path)}>
              <FileCode size={14} /> <span className="ellipsis">{f.path}</span>
            </button>
          ))}
        </div>

        <div className="side-section grow">
          <h2 className="side-title">Структура</h2>
          {analysis && (
            <button className={`side-item${view === 'classes' ? ' is-active' : ''}`} onClick={() => setView('classes')}>
              <LayoutGrid size={14} /> Обзор классов
            </button>
          )}
          <div className="method-tree">
            {(multiApp ? apps : [null]).map((a) => (
              <div key={a?.id ?? '*'}>
                {a && (
                  <button className="tree-app" onClick={() => openBoundaries(a.id)} title="Показать в границах приложений">
                    {a.kind === 'service' ? <Server size={13} /> : <Library size={13} />} <span className="ellipsis">{a.name}</span>
                  </button>
                )}
            {analysis?.types.filter((t) => !a || appOfFile.get(t.file) === a).map((t) => {
              const details = typeDetails(t);
              return (
                <div key={typeKey(t)} className="tree-group">
                  <div className="tree-class" title={t.name}>
                    <span className="ellipsis">
                      <span className="tree-kind">{TYPE_KIND[t.kind]}</span> {t.name}
                      {t.typeParameters && <span className="type-params">{t.typeParameters}</span>}
                    </span>
                    {details && <span className="tree-details mono ellipsis" title={details}>{details}</span>}
                  </div>
                  {t.methods.filter((m) => m.kind !== 'lambda').map((m) => renderMethod(m, 0))}
                </div>
              );
            })}
              </div>
            ))}
          </div>
        </div>

        <div className="side-section">
          <h2 className="side-title">Блоки</h2>
          <p className="side-hint">
            {view === 'flow' && method
              ? selectedNode?.stmtRange ? 'Вставка после выбранного блока' : 'Вставка в начало метода'
              : 'Откройте метод, чтобы добавлять блоки'}
          </p>
          <div className="palette">
            {BLOCKS.map((b) => {
              const meta = KIND[b.kind as keyof typeof KIND];
              return (
                <button
                  key={b.title}
                  className="palette-item"
                  disabled={!method || view !== 'flow' || stale}
                  style={{ '--kind': meta.color } as CSSProperties}
                  onClick={() => insertBlock(b.snippet, b.title)}
                >
                  <span className="palette-icon"><meta.Icon size={13} strokeWidth={2.25} /></span>
                  {b.title}
                </button>
              );
            })}
          </div>
          <button className="btn ghost danger full" disabled={!selectedNode?.stmtRange || stale || view !== 'flow'} onClick={deleteSelected}>
            <Trash2 size={14} /> Удалить выбранный блок
          </button>
        </div>
      </aside>

      <main className="canvas">
        {analysis && (
          <div className="canvas-bar">
            <div className="tabs" role="tablist" aria-label="Уровень детализации">
              {multiApp && <button role="tab" aria-selected={view === 'apps'} onClick={() => setView('apps')}><Network size={14} /> Приложения</button>}
              {multiApp && <button role="tab" aria-selected={view === 'boundaries'} onClick={() => openBoundaries(null)}><Boxes size={14} /> Границы</button>}
              <button role="tab" aria-selected={view === 'classes' || view === 'flow'} onClick={() => setView('classes')}><LayoutGrid size={14} /> Методы</button>
              <button role="tab" aria-selected={view === 'decompose'} onClick={() => setView('decompose')} title="Варианты распила на микросервисы"><Scissors size={14} /> Распил</button>
            </div>
            {multiApp && view === 'classes' && (
              <select className="app-select" value={appFilter ?? ''} onChange={(e) => openAppMethods(e.target.value || null)} aria-label="Приложение">
                <option value="">Все приложения</option>
                {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            <nav className="crumbs" aria-label="Навигация по графу">
              {!multiApp && view !== 'decompose' && <button className={view === 'classes' ? 'is-current' : ''} onClick={() => setView('classes')}>Обзор классов</button>}
              {view === 'flow' && method && (
                <>
                  {multiApp && methodApp && <button onClick={() => openAppMethods(methodApp.id)}>{methodApp.name}</button>}
                  {!(multiApp && !methodApp) && <ChevronRight size={14} className="muted" />}
                  <span className="muted">{method.className}</span>
                  {parentMethod && (
                    <>
                      <ChevronRight size={14} className="muted" />
                      <button className="mono" onClick={() => openMethod(parentMethod.id)}>{parentMethod.kind === 'lambda' ? 'λ' : parentMethod.signature}</button>
                    </>
                  )}
                  <ChevronRight size={14} className="muted" />
                  <span className="is-current mono">{method.signature}</span>
                </>
              )}
            </nav>
            {view === 'flow' && metrics && (
              <div className="canvas-metrics">
                <span>{metrics.lines} стр.</span>
                <span>CC {metrics.cyclomatic}</span>
                <span className={metrics.maxLoopDepth >= 2 ? 'is-bad' : ''}>{metrics.complexity}</span>
              </div>
            )}
            <span className="canvas-hint">
              {stale ? (
                <><LoaderCircle size={13} className="spin" /> Анализ</>
              ) : view === 'flow' ? 'Двойной клик по блоку — изменить код'
                : view === 'apps' ? 'Клик — подробности, двойной клик — классы приложения'
                : view === 'boundaries' ? 'Клик по классу — его методы'
                : view === 'decompose' ? 'Клик по рамке — детали сервиса, по классу — его методы'
                : 'Клик по методу — открыть блок-схему'}
            </span>
          </div>
        )}
        <div className="canvas-body">
          {!files.length && (
            <div className="welcome">
              <Logo />
              <h1>Загрузите Java-монолит</h1>
              <p>Программа превратится в граф классов и блок-схемы методов. Правьте код или схему: изменения синхронизируются, а проверка сравнит поведение с исходной версией.</p>
              <div className="welcome-actions">
                <button className="btn primary" onClick={openExample}><FileCode size={15} /> Открыть пример</button>
                <button className="btn" onClick={() => folderInput.current?.click()}><FolderOpen size={15} /> Импорт проекта</button>
                <button className="btn" onClick={() => fileInput.current?.click()}><Upload size={15} /> Импорт .java</button>
              </div>
            </div>
          )}
          {files.length > 0 && !analysis && <div className="canvas-loading"><LoaderCircle size={18} className="spin" /> Разбор кода</div>}
          {analysis && view === 'apps' && (
            <AppsView analysis={analysis} onOpenBoundaries={openBoundaries} onOpenMethods={(id) => openAppMethods(id)} onPickRange={pickRange} />
          )}
          {analysis && view === 'boundaries' && (
            <BoundaryView analysis={analysis} focusApp={focusApp} onOpenType={(appId, key) => openAppMethods(appId, key)} />
          )}
          {analysis && view === 'classes' && (
            <ClassView analysis={analysis} files={multiApp ? filteredApp?.files ?? null : null} focusType={focusType} onOpenMethod={openMethod} />
          )}
          {analysis && view === 'decompose' && (
            <DecomposeView files={analyzedFiles ?? files} apps={apps} choice={decomposition} onChoiceChange={setDecomposition} onOpenType={openTypeMethods} onPickRange={pickRange} />
          )}
          {analysis && view === 'flow' && flow && (
            <FlowView flow={flow} nodeSeverity={nodeSeverity} nodeScope={nodeScope} selectedNodeId={selectedNodeId} onSelect={selectNode} onEdit={editNode} onOpenLambda={openMethodCb} />
          )}
        </div>
      </main>

      <AnalysisPanel
        analysis={analysis}
        selectedMethodId={view === 'flow' ? methodId : null}
        selectedDiagnosticId={selectedDiagnosticId}
        onPick={pickDiagnostic}
        onPickScope={pickScope}
      />

      <section className="code" aria-label="Код Java">
        {activeFile ? (
          <>
            <div className="code-bar mono">
              <FileCode size={13} /> {activeFile.path}
              {dirty && <span className="code-dirty">изменён</span>}
            </div>
            <div className="code-body">
              <CodeEditor
                path={activeFile.path}
                value={activeFile.content}
                diagnostics={analysis?.diagnostics ?? []}
                highlight={highlight}
                onChange={updateActiveFile}
                onCursor={onCursor}
              />
            </div>
          </>
        ) : (
          <p className="panel-empty">Код загруженной программы появится здесь. Клик по строке выделит соответствующий блок на схеме.</p>
        )}
      </section>

      {showSettings && settings && (
        <SettingsDialog
          settings={settings}
          onSaved={(s) => {
            setSettings(s);
            log('Настройки сохранены', 'ok');
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      <BottomPanel
        tab={bottomTab}
        onTabChange={setBottomTab}
        logs={logs}
        tests={tests}
        onTestsChange={setTests}
        compare={compare}
        hasBaseline={!!baseline}
        casesCount={unitCases.length}
        casesPanel={
          <CasesPanel
            cases={unitCases}
            onChange={setUnitCases}
            target={casesTarget}
            fieldsOf={fieldsOf}
            generating={generating}
            onGenerate={generateUnitCases}
            results={unitResults}
            llmDefault={settings?.llmByDefault ?? true}
          />
        }
      />
    </div>
  );
}
