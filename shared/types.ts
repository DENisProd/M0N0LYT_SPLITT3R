// Общие типы для сервера и клиента.

export interface SourceFile {
  path: string; // например "com/example/Main.java" или "Main.java"
  content: string;
}

/** Позиция в исходнике: смещения в символах + строки (1-based) для UI. */
export interface Range {
  file: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

// ---------- Структурная модель (классы / методы / вызовы) ----------

export type TypeKind = 'class' | 'interface' | 'enum' | 'record';

export interface FieldInfo {
  name: string;
  type: string;
  isStatic: boolean;
  range: Range;
}

export type MethodKind = 'method' | 'constructor' | 'lambda';

export interface MethodInfo {
  id: string; // "Main#processOrders(List<Order>)", лямбда: "Main#main(String[])/λ120:31"
  kind: MethodKind;
  className: string;
  /** Для лямбды — метод или лямбда, внутри которой она объявлена. */
  parentId?: string;
  /** Параметры типа обобщённого метода: "<T extends Comparable<T>>". */
  typeParameters?: string;
  name: string;
  signature: string;
  /** Параметры метода (у лямбды — пусто). */
  params: { name: string; type: string }[];
  /** Тип результата; у конструктора и лямбды нет. */
  returnType?: string;
  isStatic: boolean;
  isConstructor: boolean;
  lines: number;
  range: Range;
  bodyRange?: Range;
  /** Имена вызываемых методов (без точного разрешения перегрузок). */
  calls: string[];
  /** Получатели вызовов по имени метода: orderService.place(…) → place: ["orderService"]; "" — вызов без объекта или через this. */
  receivers?: Record<string, string[]>;
}

export interface TypeInfo {
  name: string;
  /** Имя для Class.forName: "ru.shop.Order$Line". */
  binaryName: string;
  kind: TypeKind;
  isAbstract: boolean;
  /** Параметры типа обобщённого класса: "<K, V>". */
  typeParameters?: string;
  /** Компоненты record: record Point(int x, int y). */
  components?: { name: string; type: string }[];
  /** Константы enum. */
  constants?: string[];
  file: string;
  outer?: string;
  extends?: string;
  implements: string[];
  fields: FieldInfo[];
  methods: MethodInfo[];
  range: Range;
}

export interface CallEdge {
  from: string; // method id
  to: string; // method id
  /** 'lambda' — метод объявляет лямбду, а не вызывает её. */
  kind?: 'call' | 'lambda';
}

// ---------- Блок-схема метода ----------

export type FlowNodeKind =
  | 'start'
  | 'end'
  | 'variable'
  | 'operation'
  | 'call'
  | 'condition'
  | 'loop'
  | 'switch'
  | 'try'
  | 'catch'
  | 'finally'
  | 'return'
  | 'throw'
  | 'break'
  | 'continue'
  | 'stream'
  | 'merge';

/** Стадия конвейера Stream API: filter(o -> o.amount > 0). */
export interface StreamStage {
  name: string;
  args: string;
  /** Лямбда в аргументах стадии — у неё своя блок-схема. */
  lambdaId?: string;
}

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  /** Диапазон, который заменяется при редактировании узла из графа. */
  range?: Range;
  /** Точный исходный текст диапазона range (подпись label может быть сокращена). */
  code?: string;
  /** Узел можно редактировать как текст (простые операторы). */
  editable: boolean;
  /** Весь оператор целиком — для удаления узла и вставки блока после него. */
  stmtRange?: Range;
  /** Лямбды внутри узла: переход к их блок-схемам. */
  lambdas?: { id: string; line: number }[];
  /** Источник и стадии, если узел — конвейер Stream API. */
  stream?: { source: string; stages: StreamStage[] };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind?: 'normal' | 'back' | 'exception';
}

export interface FlowGraph {
  methodId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// ---------- Диагностика ----------

export type Severity = 'high' | 'medium' | 'low';

export interface Diagnostic {
  id: string;
  rule: string;
  severity: Severity;
  title: string;
  message: string;
  recommendation: string;
  methodId?: string;
  range: Range;
  /** Оценка сложности фрагмента, если применимо: "O(n²)". */
  complexity?: string;
  /** Ожидаемая сложность после исправления. */
  improvedComplexity?: string;
}

export interface MethodMetrics {
  methodId: string;
  lines: number;
  cyclomatic: number;
  maxLoopDepth: number;
  complexity: string;
}

// ---------- Возможности вне рамок кейса ----------

export type ScopeCategory = 'concurrency' | 'reflection' | 'files' | 'network' | 'time' | 'random';

export interface ScopeFinding {
  category: ScopeCategory;
  /** Что именно найдено: "Thread.sleep()", "import java.time.LocalDate". */
  construct: string;
  range: Range;
}

// ---------- Архитектура: приложения и связи между ними ----------

/** service — запускаемое приложение (есть main), library — общий модуль без точки входа. */
export type AppKind = 'service' | 'library';

/** REST-эндпоинт приложения: GET /api/orders/{id} → OrderController#get(Long). */
export interface Endpoint {
  method: string; // GET, POST… или ANY
  path: string;
  methodId?: string;
  range: Range;
}

export interface AppInfo {
  /** Корень модуля ("services/order-service") или пакет main-класса. */
  id: string;
  name: string;
  kind: AppKind;
  files: string[];
  mainClass?: string;
  endpoints: Endpoint[];
  /** Топики и очереди, на которые подписаны слушатели приложения. */
  listens: string[];
}

export type LinkKind = 'http' | 'messaging' | 'library' | 'data';

/** Одно место в коде, из которого следует связь. */
export interface LinkCall {
  /** "GET /api/orders/{}", "Kafka: order-created", "import com.shop.common.Money". */
  detail: string;
  /** Место у отправителя: вызов клиента, метод Feign, send(), import. */
  range: Range;
  fromMethodId?: string;
  fromType?: string;
  /** Обработчик у получателя: метод контроллера или слушателя. */
  toMethodId?: string;
  toType?: string;
}

/** Связь приложений; from/to — id приложения или внешнего узла. */
export interface AppLink {
  id: string;
  from: string;
  to: string;
  kind: LinkKind;
  calls: LinkCall[];
}

/** Получатель или отправитель вне проекта: сторонний API, топик без подписчиков. */
export interface ExternalNode {
  id: string;
  kind: 'http' | 'messaging';
  label: string;
}

export interface Architecture {
  apps: AppInfo[];
  externals: ExternalNode[];
  /** Связи с хранилищами (kind 'data') идут от приложения к DataStore.id. */
  links: AppLink[];
  stores: DataStore[];
  /** Обращения к хранилищам из кода: по ним хранилища делятся между сервисами. */
  access: DataAccess[];
}

// ---------- Хранилища данных ----------

export type StoreKind = 'sql' | 'mongodb' | 'redis' | 'elasticsearch' | 'cassandra';

/**
 * Внешнее хранилище, в которое ходит код. Одинаковый адрес в конфигурации разных приложений — одно хранилище;
 * если адреса нет нигде, все обращения одного вида сводятся к одному хранилищу «адрес не найден».
 */
export interface DataStore {
  id: string;
  kind: StoreKind;
  /** PostgreSQL, MySQL, H2, MongoDB, Redis… */
  engine: string;
  /** Имя базы, keyspace или хост: "shop". */
  name: string;
  /** Адрес как он записан: jdbc:postgresql://db:5432/shop, ${DB_URL}. */
  url?: string;
  /** Где адрес задан: application.yml или вызов DriverManager.getConnection. */
  configRange?: Range;
  tables: DataTable[];
}

/** Таблица, коллекция или индекс. */
export interface DataTable {
  name: string;
  /** Сущность, отображённая на таблицу: Order (@Entity, @Document). */
  entity?: string;
  entityFile?: string;
}

export interface DataAccess {
  store: string;
  app: string;
  /** Таблица; нет — неизвестна (Redis, SQL без разбираемого текста). */
  table?: string;
  /** Все таблицы одного запроса: по ним видны JOIN через будущие границы сервисов. */
  tables?: string[];
  /** Класс, из которого идёт обращение (TypeInfo.name), и его файл. */
  type: string;
  file: string;
  methodId?: string;
  op: 'read' | 'write' | 'unknown';
  /** "OrderRepository.save", "JdbcTemplate.query: SELECT … FROM orders JOIN products". */
  detail: string;
  range: Range;
}

export interface AnalyzeResult {
  architecture: Architecture;
  types: TypeInfo[];
  callGraph: CallEdge[];
  flows: Record<string, FlowGraph>;
  diagnostics: Diagnostic[];
  metrics: MethodMetrics[];
  parseErrors: { file: string; line: number; message: string }[];
  /** Конструкции вне рамок кейса: граф строится, но поведение может быть недетерминированным. */
  scope: ScopeFinding[];
  /** Паттерны проектирования: найденные в коде и места, где они помогли бы. */
  patterns: PatternFinding[];
}

// ---------- Запуск и сравнение поведения ----------

export interface TestCase {
  name: string;
  stdin: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface CompileResult {
  ok: boolean;
  errors: string;
  durationMs: number;
}

export interface CompareCase {
  name: string;
  passed: boolean;
  original: RunResult;
  modified: RunResult;
  /** Что именно разошлось: stdout / stderr / exitCode. */
  mismatches: string[];
  /** Эталон дал разный вывод на двух одинаковых запусках — сравнение не доказательно. */
  flaky?: boolean;
}

// ---------- Тест-кейсы классов ----------

/** Ответ заглушки зависимости: field.method(любые аргументы) возвращает или бросает value (выражение Java). */
export interface StubSpec {
  field: string;
  method: string;
  kind: 'returns' | 'throws';
  value: string;
}

/** Вызов метода класса: аргументы — выражения Java, зависимости — заглушки Mockito. */
export interface UnitCase {
  id: string;
  name: string;
  methodId: string;
  /** Подпись для списка: "CategoryService.findById(Long)". */
  label: string;
  binaryName: string;
  file: string;
  method: string;
  params: { name: string; type: string }[];
  args: string[];
  stubs: StubSpec[];
  source: 'heuristic' | 'llm' | 'manual';
}

export interface UnitOutcome {
  /** return — значение, throw — исключение метода, error — кейс не выполнился (не компилируется, нет метода). */
  kind: 'return' | 'throw' | 'error';
  value: string;
  /** Вызовы зависимостей по порядку: "categoryRepository.findById(1)". */
  calls: string[];
  warnings: string[];
}

export interface UnitCaseResult {
  id: string;
  name: string;
  label: string;
  passed: boolean;
  /** Эталон дал разный результат на двух одинаковых запусках. */
  flaky?: boolean;
  /** Что разошлось: результат, вызовы зависимостей. */
  mismatches: string[];
  original: UnitOutcome;
  modified: UnitOutcome;
}

export interface CompareResult {
  originalCompile: CompileResult;
  modifiedCompile: CompileResult;
  cases: CompareCase[];
  passed: number;
  total: number;
  /** Найденные в эталоне источники недетерминизма (время, потоки, случайность, сеть). */
  nondeterministic: ScopeCategory[];
  flaky: number;
  /** Запуск по stdin не выполнялся (Spring Boot-сервис). */
  runSkipped?: string;
  /** Тест-кейсы классов; входят в passed/total. */
  units: UnitCaseResult[];
}

// ---------- Микросервисы ----------

/** Роль класса в Spring-приложении — по аннотациям и имени. */
export type TypeRole = 'entity' | 'repository' | 'controller' | 'listener' | 'service' | 'dto' | 'config' | 'other';

export type DecompositionStrategy = 'entities' | 'api' | 'cohesion' | 'cohesion-coarse' | 'packages';

export interface DecompositionType {
  /** typeKey: `${file}:${name}`. */
  key: string;
  name: string;
  file: string;
  role: TypeRole;
  lines: number;
}

/** Предлагаемый микросервис. */
export interface ProposedService {
  id: string;
  name: string;
  /** typeKey классов сервиса. */
  types: string[];
  entities: string[];
  /** "GET /api/orders/{id}". */
  endpoints: string[];
  lines: number;
}

/** Зависимость между предлагаемыми сервисами — после разделения станет HTTP-вызовом или событием. */
export interface ServiceDependency {
  from: string;
  to: string;
  weight: number;
  /** Вызовы методов через будущую границу: "OrderService#place(Order) → StockService#reserve(Long)". */
  calls: string[];
}

export interface DecompositionMetrics {
  services: number;
  /** Доля связей внутри сервисов, 0…1. */
  cohesion: number;
  /** Модулярность разбиения (Newman), обычно 0…0.8. */
  modularity: number;
  /** Суммарный вес связей через границы сервисов. */
  crossWeight: number;
  /** Циклы между сервисами: имена сервисов в цикле. */
  cycles: string[][];
  /** Сущности, к которым обращаются классы других сервисов: общая БД или API. */
  sharedEntities: { entity: string; owner: string; usedBy: string[] }[];
  /** Доля строк кода в самом крупном сервисе. */
  largestShare: number;
  /** Транзакции через агрегаты, которые этот разрез разносит по разным сервисам. */
  distributedTransactions: number;
  /** Таблицы, с которыми работают несколько сервисов. */
  sharedTables: number;
}

/** Хранилище сервиса после разделения: его собственные таблицы. */
export interface ServiceStore {
  /** Исходное хранилище монолита. */
  store: string;
  kind: StoreKind;
  engine: string;
  /** Имя новой базы: "order-db"; для общего хранилища (Redis) — его имя. */
  name: string;
  tables: string[];
  /** Хранилище без таблиц (кэш, очередь) — не делится, сервисы пользуются им вместе. */
  shared?: boolean;
}

/** Таблица, к которой после разделения обращается не только сервис-владелец. */
export interface SharedTable {
  store: string;
  table: string;
  owner: string;
  /** Почему владелец — он: сущность в его коде или больше всего записей. */
  ownerReason: string;
  users: { service: string; reads: number; writes: number; access: { detail: string; type: string; range: Range }[] }[];
}

/** Запрос, который соединяет таблицы разных сервисов: после разделения он невозможен одним SQL. */
export interface CrossJoin {
  detail: string;
  tables: string[];
  services: string[];
  type: string;
  range: Range;
}

export interface DataSplit {
  /** Хранилища каждого сервиса по id сервиса. */
  services: Record<string, ServiceStore[]>;
  shared: SharedTable[];
  joins: CrossJoin[];
}

export interface DecompositionVariant {
  id: DecompositionStrategy;
  title: string;
  description: string;
  services: ProposedService[];
  /** Классы общего модуля: DTO, исключения, перечисления, которыми пользуются несколько сервисов. */
  shared: string[];
  dependencies: ServiceDependency[];
  metrics: DecompositionMetrics;
  /** Как делятся хранилища: у каждого сервиса свои таблицы, общие таблицы и JOIN через границы. */
  data: DataSplit;
  /** 0…100: связность и модулярность минус циклы, общие сущности и перекос размеров. */
  score: number;
  pros: string[];
  cons: string[];
  recommended: boolean;
}

export type BottleneckKind = 'god-class' | 'hub' | 'shared-data' | 'class-cycle' | 'cross-aggregate-tx' | 'hot-endpoint';

/** Узкое место монолита: мешает разделению на сервисы или ограничивает приложение под нагрузкой. */
export interface BottleneckEvidence {
  text: string;
  range?: Range;
}

export interface Bottleneck {
  id: string;
  kind: BottleneckKind;
  severity: Severity;
  title: string;
  message: string;
  recommendation: string;
  /** Затронутые классы (ключи DecompositionType). */
  types: string[];
  /** Подробности: вызовы, методы, найденные дефекты на пути запроса — с местом в коде, если оно известно. */
  evidence: BottleneckEvidence[];
  /** Главное место в коде: вызов, замыкающий цикл, объявление класса или метода. */
  range?: Range;
  methodId?: string;
}

export interface DecompositionResult {
  /** Разделяемое приложение; null — весь проект. */
  appId: string | null;
  appName: string;
  types: DecompositionType[];
  /** Взвешенные зависимости классов: поле, наследование, вызов, тип параметра. */
  edges: { source: string; target: string; weight: number }[];
  /** Обращения к хранилищам из классов приложения: рёбра «класс → база сервиса». */
  access: DataAccess[];
  /** Конфигурация и точка входа: копируются в каждый сервис. */
  infra: string[];
  /** Классы без связей — их можно оставить в любом сервисе. */
  isolated: string[];
  variants: DecompositionVariant[];
  /** Узкие места монолита: god-классы, центральные зависимости, общие таблицы, транзакции через агрегаты, тяжёлые эндпоинты. */
  bottlenecks: Bottleneck[];
  /** Почему какой-то способ не предложен. */
  notes: string[];
}

// ---------- Настройки (хранятся в SQLite через Prisma) ----------

export interface AppSettings {
  ollamaUrl: string;
  ollamaModel: string;
  llmTimeoutMs: number;
  /** Галочка LLM при генерации тест-кейсов включена по умолчанию. */
  llmByDefault: boolean;
}

/** Сохранённый выбор во вкладке «Микросервисы». */
export interface DecompositionChoice {
  appId: string | null;
  variant: DecompositionStrategy | null;
}

export interface ProjectState {
  /** Отпечаток списка путей файлов. */
  key: string;
  name: string;
  tests: TestCase[];
  unitCases: UnitCase[];
  decomposition: DecompositionChoice | null;
  updatedAt: string;
}

// ---------- Автоисправление ----------

/** Чем исправляется правило: точечной заменой по AST или переписыванием метода в LLM. */
export type FixSource = 'rule' | 'llm';

/** Правила с детерминированным исправлением; если шаблон не подошёл, пробуется LLM. */
export const RULE_FIXES = new Set([
  'stream-sort-for-min',
  'stream-count-for-exists',
  'stream-find-is-present',
  'string-concat-in-loop',
  'regex-in-loop',
  'heavy-object-per-call',
  'empty-catch',
]);

/** Правила, которые исправляет только LLM (переписывает метод целиком). */
export const LLM_FIXES = new Set([
  'nested-loops',
  'linear-search-in-loop',
  'stream-foreach-add',
  'long-method',
  'high-cyclomatic',
  'db-call-in-loop',
  'find-all-in-memory',
  'lazy-collection-in-loop',
  'print-stack-trace',
]);

export function fixSourceOf(d: Diagnostic): FixSource | null {
  if (RULE_FIXES.has(d.rule)) return 'rule';
  return LLM_FIXES.has(d.rule) && d.methodId ? 'llm' : null;
}

export interface FixRequest {
  files: SourceFile[];
  /** Id диагностик из анализа этих же files; без них — все исправимые. */
  ids?: string[];
  llm: boolean;
  /** Тесты проекта: ответ LLM принимается, только если поведение на них не изменилось. */
  tests?: TestCase[];
  unitCases?: UnitCase[];
}

export interface AppliedFix {
  rule: string;
  title: string;
  source: FixSource;
  file: string;
  line: number;
  /** Чем исправление может отличаться по поведению: «меняет вывод в stderr». */
  note?: string;
}

export interface FixResult {
  /** Файлы со всеми исправлениями; принимать или отклонять их — по фрагментам на клиенте. */
  files: SourceFile[];
  applied: AppliedFix[];
  skipped: { title: string; file: string; line: number; reason: string }[];
}

// ---------- Версии (как коммиты git) ----------

export interface CommitInfo {
  /** Короткий хеш содержимого, родителя и времени. */
  id: string;
  parentId: string | null;
  message: string;
  createdAt: string;
  /** Изменённых файлов относительно родителя. */
  changed: number;
}

export interface History {
  commits: CommitInfo[];
  head: string | null;
}

/** Ход автоисправления: сервер шлёт события построчно (NDJSON), пока идёт генерация. */
export interface FixProgress {
  step: 'rules' | 'build' | 'generate' | 'compile' | 'behavior' | 'method-done';
  /** Метод, над которым работает LLM: сигнатура и id проблем в нём. */
  method?: string;
  ids?: string[];
  /** Номер метода и всего методов для LLM, с 1. */
  index?: number;
  total?: number;
  attempt?: number;
  maxAttempts?: number;
  /** Почему понадобилась ещё попытка или чем закончился метод. */
  detail?: string;
  ok?: boolean;
}

export type FixEvent = { type: 'progress'; progress: FixProgress } | { type: 'result'; result: FixResult } | { type: 'error'; error: string };

// ---------- Разделение класса ----------

/** Член класса для переноса: все перегрузки метода — один член, поле — одно объявление. */
export interface SplitMember {
  id: string;
  kind: 'method' | 'field';
  name: string;
  /** Сигнатуры перегрузок или тип поля. */
  label: string;
  lines: number;
  isStatic: boolean;
  /** Почему член остаётся в исходном классе; без причины — переносится. */
  pinned?: string;
}

export interface SplitPart {
  /** Имя класса; у части 0 — имя исходного класса. */
  name: string;
  members: string[];
  /** Что связывает члены части: общие поля, вызовы, слова в именах. */
  reason: string;
}

export interface SplitPlan {
  file: string;
  typeName: string;
  members: SplitMember[];
  /** parts[0] — исходный класс: в нём остаются закреплённые члены и всё, что не перенесено. */
  parts: SplitPart[];
  /** Сколько частей предлагается по размеру и связности класса. */
  suggested: number;
  totalLines: number;
  /** Почему класс нельзя разделить (интерфейс, enum…); тогда parts пусты. */
  error?: string;
}

export interface SplitRequest {
  files: SourceFile[];
  plan: SplitPlan;
  tests?: TestCase[];
  unitCases?: UnitCase[];
}

export interface SplitResult {
  files: SourceFile[];
  /** Новые файлы классов. */
  created: string[];
  /** Чем проверен результат: null — проверить не удалось (нет JDK или проект не собирается и без правок). */
  compiled: boolean | null;
  /** Прогнано тестов и все ли совпали; null — тестов нет. */
  tests: number;
  behaviorSame: boolean | null;
  errors?: string;
  notes: string[];
}

// ---------- Паттерны проектирования ----------

export type PatternId = 'singleton' | 'builder' | 'factory' | 'strategy' | 'observer' | 'decorator' | 'template-method' | 'command' | 'extract-class';

export interface PatternFinding {
  /** Стабилен для одних и тех же файлов: по нему сервер находит место при применении. */
  id: string;
  pattern: PatternId;
  /** found — паттерн уже есть в коде; opportunity — здесь он упростил бы код. */
  kind: 'found' | 'opportunity';
  title: string;
  message: string;
  /** Участники паттерна в этом коде: «Стратегия — PaymentMethod». */
  roles: { role: string; name: string }[];
  range: Range;
  typeName?: string;
  methodId?: string;
  /** Изъян реализации: «ленивая инициализация не потокобезопасна». */
  warning?: string;
  /** Чем помочь: переписать через LLM с проверкой или открыть разделение класса. */
  action?: 'llm' | 'split';
}

export interface PatternApplyRequest {
  files: SourceFile[];
  findingId: string;
  tests?: TestCase[];
  unitCases?: UnitCase[];
}
