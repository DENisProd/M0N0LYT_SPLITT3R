import type { Node } from 'web-tree-sitter';
import type { ScopeCategory, ScopeFinding, SourceFile } from '../../shared/types.ts';
import { descendants, parseJava, rangeOf, shortLabel } from './parser.ts';

// Возможности вне рамок кейса. Инструмент их не моделирует, но обязан
// честно сказать о них: блок-схема строится, а сравнение поведения может
// быть недостоверным (время, потоки, случайность меняют вывод между запусками).

const IMPORTS: [RegExp, ScopeCategory][] = [
  [/^java\.util\.concurrent\b/, 'concurrency'],
  [/^java\.lang\.reflect\b/, 'reflection'],
  [/^java\.lang\.invoke\b/, 'reflection'],
  [/^java\.nio\.file\b/, 'files'],
  [/^java\.nio\.channels\b/, 'files'],
  [/^java\.io\.(File|FileReader|FileWriter|FileInputStream|FileOutputStream|RandomAccessFile)\b/, 'files'],
  [/^java\.net\b/, 'network'],
  [/^java\.time\b/, 'time'],
  [/^java\.util\.(Date|Calendar|GregorianCalendar|Timer|TimerTask|TimeZone)\b/, 'time'],
];

const TYPES: Record<string, ScopeCategory> = {
  Thread: 'concurrency', ExecutorService: 'concurrency', Executors: 'concurrency', CompletableFuture: 'concurrency',
  Future: 'concurrency', ConcurrentHashMap: 'concurrency', AtomicInteger: 'concurrency', AtomicLong: 'concurrency',
  CountDownLatch: 'concurrency', ReentrantLock: 'concurrency', Semaphore: 'concurrency', ForkJoinPool: 'concurrency',
  Method: 'reflection', Field: 'reflection', Constructor: 'reflection', Proxy: 'reflection', MethodHandle: 'reflection',
  File: 'files', Files: 'files', Path: 'files', Paths: 'files', FileReader: 'files', FileWriter: 'files',
  FileInputStream: 'files', FileOutputStream: 'files', RandomAccessFile: 'files',
  Socket: 'network', ServerSocket: 'network', URL: 'network', URI: 'network', HttpClient: 'network',
  HttpURLConnection: 'network', InetAddress: 'network', DatagramSocket: 'network',
  LocalDate: 'time', LocalDateTime: 'time', LocalTime: 'time', Instant: 'time', Duration: 'time', Clock: 'time',
  ZonedDateTime: 'time', OffsetDateTime: 'time', DateTimeFormatter: 'time', Date: 'time', Calendar: 'time', Timer: 'time',
};

const REFLECTION_CALLS = new Set([
  'forName', 'getMethod', 'getMethods', 'getDeclaredMethod', 'getDeclaredMethods', 'getField', 'getFields',
  'getDeclaredField', 'getDeclaredFields', 'getConstructor', 'getDeclaredConstructor', 'getDeclaredConstructors',
  'setAccessible', 'newInstance',
]);

/** Вызовы через объект/класс: "System.nanoTime" → категория. */
const QUALIFIED_CALLS: Record<string, ScopeCategory> = {
  'System.currentTimeMillis': 'time',
  'System.nanoTime': 'time',
  'Thread.sleep': 'concurrency',
  'Math.random': 'random',
  'UUID.randomUUID': 'random',
  'System.identityHashCode': 'random',
  'ThreadLocalRandom.current': 'random',
};

const CONCURRENT_STREAM = new Set(['parallelStream', 'parallel']);

export const SCOPE_TITLE: Record<ScopeCategory, string> = {
  concurrency: 'Многопоточность',
  reflection: 'Рефлексия',
  files: 'Файловые операции',
  network: 'Сетевое взаимодействие',
  time: 'Работа со временем',
  random: 'Случайность',
};

/** Категории, из-за которых вывод программы может меняться от запуска к запуску. */
export const NONDETERMINISTIC: ReadonlySet<ScopeCategory> = new Set(['concurrency', 'time', 'random', 'network']);

/** ownTypes — типы, объявленные в проекте: свой класс Date или Path не повод для тревоги. */
export function scopeFindings(root: Node, file: string, ownTypes: ReadonlySet<string> = new Set()): ScopeFinding[] {
  const found = new Map<string, ScopeFinding>();
  const add = (category: ScopeCategory, n: Node, construct: string) => {
    const key = `${category}:${n.startPosition.row}:${construct}`;
    if (!found.has(key)) found.set(key, { category, construct: shortLabel(construct, 60), range: rangeOf(n, file) });
  };

  for (const imp of descendants(root, 'import_declaration')) {
    const name = imp.text.replace(/^import\s+(static\s+)?/, '').replace(/[;\s]/g, '');
    const hit = IMPORTS.find(([re]) => re.test(name));
    if (hit) add(hit[1], imp, `import ${name}`);
  }

  for (const t of descendants(root, ['type_identifier'])) {
    const cat = TYPES[t.text];
    if (cat && !ownTypes.has(t.text) && t.parent?.type !== 'scoped_type_identifier') add(cat, t, t.text);
  }

  for (const inv of descendants(root, 'method_invocation')) {
    const name = inv.childForFieldName('name')?.text ?? '';
    const obj = inv.childForFieldName('object')?.text;
    const qualified = obj ? `${obj}.${name}` : name;
    const objType = obj && /^[A-Z]\w*$/.test(obj) && !ownTypes.has(obj) ? TYPES[obj] : undefined;
    if (QUALIFIED_CALLS[qualified]) add(QUALIFIED_CALLS[qualified], inv, `${qualified}()`);
    else if (objType) add(objType, inv, `${qualified}(…)`); // Files.readAllLines, LocalDate.now, Executors.new…
    else if (REFLECTION_CALLS.has(name) && (obj === 'Class' || /getClass\(\)|\.class$/.test(obj ?? '') || name === 'setAccessible')) add('reflection', inv, `${qualified}(…)`);
    else if (CONCURRENT_STREAM.has(name)) add('concurrency', inv, `${name}()`);
  }

  for (const creation of descendants(root, 'object_creation_expression')) {
    const type = creation.childForFieldName('type')?.text.replace(/<.*$/, '');
    const args = creation.childForFieldName('arguments');
    // new Random() без seed — недетерминированная последовательность; new Random(42) — детерминированная.
    if (type === 'Random' && args && args.namedChildCount === 0) add('random', creation, 'new Random()');
  }

  for (const s of descendants(root, 'synchronized_statement')) add('concurrency', s, 'synchronized (…)');
  for (const m of descendants(root, 'modifiers')) {
    if (/\bvolatile\b/.test(m.text)) add('concurrency', m, 'volatile');
    if (/\bsynchronized\b/.test(m.text)) add('concurrency', m, 'synchronized');
  }

  return [...found.values()].sort((a, b) => a.range.start - b.range.start);
}

/** Для проверки поведения: есть ли в программе источники недетерминизма. */
export function nondeterministicIn(files: SourceFile[]): ScopeCategory[] {
  const cats = new Set<ScopeCategory>();
  for (const f of files) {
    const tree = parseJava(f.content);
    const own = new Set(descendants(tree.rootNode, ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'])
      .map((d) => d.childForFieldName('name')?.text ?? ''));
    for (const s of scopeFindings(tree.rootNode, f.path, own)) if (NONDETERMINISTIC.has(s.category)) cats.add(s.category);
    tree.delete();
  }
  return [...cats];
}
