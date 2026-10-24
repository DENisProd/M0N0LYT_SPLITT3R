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

export type LinkKind = 'http' | 'messaging' | 'library';

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
  links: AppLink[];
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

// ---------- Распил на микросервисы ----------

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

/** Зависимость между предлагаемыми сервисами — после распила станет HTTP-вызовом или событием. */
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
  /** 0…100: связность и модулярность минус циклы, общие сущности и перекос размеров. */
  score: number;
  pros: string[];
  cons: string[];
  recommended: boolean;
}

export type BottleneckKind = 'god-class' | 'hub' | 'shared-data' | 'class-cycle' | 'cross-aggregate-tx' | 'hot-endpoint';

/** Узкое место монолита: мешает распилу или ограничивает приложение под нагрузкой. */
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
  /** Распиливаемое приложение; null — весь проект. */
  appId: string | null;
  appName: string;
  types: DecompositionType[];
  /** Взвешенные зависимости классов: поле, наследование, вызов, тип параметра. */
  edges: { source: string; target: string; weight: number }[];
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

/** Сохранённый выбор во вкладке распила. */
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
