import type { Node } from 'web-tree-sitter';
import {
  LLM_FIXES,
  RULE_FIXES,
  type AppliedFix,
  type Diagnostic,
  type FixProgress,
  type FixRequest,
  type FixResult,
  type MethodInfo,
  type TestCase,
  type UnitCase,
  type CompareResult,
  type SourceFile,
} from '../../shared/types.ts';
import { analyzeProject } from './analyze.ts';
import { chatJson } from './llm.ts';
import { collectErrors, descendants, parseJava } from './parser.ts';
import { diffText } from '../../shared/diff.ts';
import { checkJava, compareBehavior, Workspace } from './runner.ts';
import { counterLines, onlyCounters, type CounterLine } from './counters.ts';
import { paramTypes } from './model.ts';
import { pipelineOf } from './streams.ts';

/*
 * Автоисправление дефектов в два этапа.
 *   1. Правила: точечные замены по AST там, где переписывание однозначно и не меняет результат
 *      (sorted…findFirst → min, count() > 0 → anyMatch, += строк → StringBuilder, Pattern в static final…).
 *   2. LLM: метод с оставшимися дефектами переписывается целиком. Ответ принимается, только если
 *      файл разбирается, проект компилируется и тесты проекта дают тот же результат, что до правки.
 *      Ошибки разбора, javac и расхождения поведения возвращаются модели — до MAX_ATTEMPTS попыток.
 * Результат не применяется: клиент показывает diff, и пользователь принимает или отклоняет каждый фрагмент.
 */

/** Сколько методов за один запуск отдаётся LLM: каждый — отдельный и небыстрый запрос. */
const MAX_LLM_METHODS = 8;
/** Попыток на метод: первая и исправления по ошибкам разбора или компиляции. */
export const MAX_ATTEMPTS = 3;
/** Сколько текста ошибок javac отдаётся модели: начало вывода, остальное обычно следствия. */
export const MAX_ERRORS_TEXT = 3000;

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface RuleFix {
  edits: Edit[];
  note?: string;
}

/** static final поле, которое исправление добавляет в класс; одинаковые инициализаторы делят одно поле. */
interface NewField {
  type: string;
  init: string;
  name: string;
}

interface Ctx {
  src: string;
  /** Поля по телу класса (startIndex узла class_body). */
  fields: Map<number, { body: Node; list: NewField[] }>;
}

type Fixer = (n: Node, ctx: Ctx) => RuleFix | null;

const objectOf = (n: Node) => n.childForFieldName('object');
const nameOf = (n: Node) => n.childForFieldName('name')?.text ?? '';

/** Узел с точно таким диапазоном и одним из типов. */
function nodeAt(root: Node, start: number, end: number, types: string[]): Node | null {
  for (let n: Node | null = root.descendantForIndex(start, Math.max(start, end - 1)); n; n = n.parent) {
    if (n.startIndex < start || n.endIndex > end) return null;
    if (n.startIndex === start && n.endIndex === end && types.includes(n.type)) return n;
  }
  return null;
}

export function lineIndent(src: string, offset: number): string {
  const start = src.lastIndexOf('\n', offset - 1) + 1;
  return src.slice(start).match(/^[ \t]*/)![0];
}

function ancestor(n: Node, types: string[]): Node | null {
  for (let p = n.parent; p; p = p.parent) if (types.includes(p.type)) return p;
  return null;
}

/**
 * Регистрирует private static final поле в классе, где лежит узел. Анонимные классы, интерфейсы
 * и enum не поддерживаются: там поле либо запрещено, либо должно стоять после констант.
 */
function addField(ctx: Ctx, at: Node, type: string, init: string, base: string): string | null {
  const body = ancestor(at, ['class_body', 'interface_body', 'enum_body']);
  if (body?.type !== 'class_body' || !['class_declaration', 'record_declaration'].includes(body.parent?.type ?? '')) return null;
  const entry = ctx.fields.get(body.startIndex) ?? { body, list: [] };
  ctx.fields.set(body.startIndex, entry);
  const same = entry.list.find((f) => f.type === type && f.init === init);
  if (same) return same.name;
  const taken = (name: string) => new RegExp(`\\b${name}\\b`).test(body.text) || entry.list.some((f) => f.name === name);
  let name = base;
  for (let i = 2; taken(name); i++) name = `${base}_${i}`;
  entry.list.push({ type, init, name });
  return name;
}

function fieldInsertions(ctx: Ctx): Edit[] {
  return [...ctx.fields.values()].map(({ body, list }) => {
    const first = body.namedChildren.find((c) => c && c.type !== 'line_comment' && c.type !== 'block_comment');
    const indent = first ? lineIndent(ctx.src, first.startIndex) : lineIndent(ctx.src, body.startIndex) + '    ';
    const decls = list.map((f) => `${indent}private static final ${f.type} ${f.name} = ${f.init};`).join('\n');
    return { start: body.startIndex + 1, end: body.startIndex + 1, text: `\n${decls}\n` };
  });
}

// ---------- Правила ----------

/** Последняя смена типа потока до sorted: IntStream.range, mapToInt… или обратно mapToObj/boxed. */
const STREAM_KIND = /^(IntStream|LongStream|DoubleStream)\.|\.(mapToInt|mapToLong|mapToDouble|chars|codePoints|mapToObj|boxed)\(/g;
const isPrimitive = (head: string) => {
  const last = [...head.matchAll(STREAM_KIND)].pop();
  return !!last && !/mapToObj|boxed/.test(last[0]);
};

/** sorted(cmp)…findFirst() → min(cmp): Stream.min при равенстве оставляет первый элемент, как стабильная сортировка. */
const sortForMin: Fixer = (n, ctx) => {
  const p = pipelineOf(n);
  const names = p.stages.map((s) => s.name);
  const sortedAt = names.indexOf('sorted');
  const firstAt = names.findIndex((x, i) => i > sortedAt && x === 'findFirst');
  if (sortedAt === -1 || firstAt === -1) return null;
  const between = names.slice(sortedAt + 1, firstAt);
  const sorted = p.stages[sortedAt];
  // Звенья цепочки начинаются с одного индекса — текст до sorted берём по концу его объекта.
  const primitive = isPrimitive(ctx.src.slice(n.startIndex, objectOf(sorted.node)!.endIndex));
  // У OptionalInt нет map, а у Optional map — та же операция над единственным элементом.
  if (!between.every((x) => x === 'map') || (primitive && between.length)) return null;
  const args = sorted.args!;
  const empty = args.namedChildCount === 0;
  const edits: Edit[] = [{ start: sorted.node.childForFieldName('name')!.startIndex, end: sorted.node.childForFieldName('name')!.endIndex, text: 'min' }];
  if (empty && !primitive) edits.push({ start: args.startIndex, end: args.endIndex, text: '(java.util.Comparator.naturalOrder())' });
  const before = p.stages[firstAt - 1].node;
  edits.push({ start: before.endIndex, end: p.stages[firstAt].node.endIndex, text: '' });
  return { edits };
};

/** filter(p).count() > 0 → anyMatch(p), == 0 → noneMatch(p). */
const countForExists: Fixer = (n, ctx) => {
  const left = n.children[0];
  const op = n.children[1]?.text;
  const other = n.children[2]?.text;
  if (left?.type !== 'method_invocation') return null;
  const exists = (op === '>' && other === '0') || (op === '!=' && other === '0') || (op === '>=' && other === '1');
  const none = op === '==' && other === '0';
  const p = pipelineOf(left);
  const names = p.stages.map((s) => s.name);
  const filter = p.stages[names.length - 2];
  if ((!exists && !none) || names[names.length - 1] !== 'count' || filter?.name !== 'filter' || names.includes('peek')) return null;
  const text = ctx.src.slice(n.startIndex, objectOf(filter.node)!.endIndex) + `.${exists ? 'anyMatch' : 'noneMatch'}${filter.args!.text}`;
  return { edits: [{ start: n.startIndex, end: n.endIndex, text }] };
};

/** filter(p).findFirst().isPresent() → anyMatch(p). */
const findIsPresent: Fixer = (n, ctx) => {
  const p = pipelineOf(n);
  const k = p.stages.length;
  const filter = p.stages[k - 3];
  const last = p.stages[k - 1]?.name;
  if (filter?.name !== 'filter' || !['isPresent', 'isEmpty'].includes(last)) return null;
  const text = ctx.src.slice(n.startIndex, objectOf(filter.node)!.endIndex) + `.${last === 'isPresent' ? 'anyMatch' : 'noneMatch'}${filter.args!.text}`;
  return { edits: [{ start: n.startIndex, end: n.endIndex, text }] };
};

const DECLARES = ['variable_declarator', 'formal_parameter', 'catch_formal_parameter', 'enhanced_for_statement', 'inferred_parameters', 'lambda_expression'];

/**
 * Локальная String-переменная, которую наращивают в цикле, становится StringBuilder:
 * s += x → s.append(x), s = s + a + b → s.append(a).append(b), чтение s → s.toString().
 * Поля и параметры не трогаем: их видят другие методы и вызывающий код.
 */
const concatInLoop: Fixer = (n, ctx) => {
  const name = n.childForFieldName('left')?.text;
  const method = ancestor(n, ['method_declaration', 'constructor_declaration']);
  if (!name || !method) return null;
  const sameName = (x: Node | null | undefined) => x?.type === 'identifier' && x.text === name;
  // Ровно одно объявление с этим именем в методе — иначе области видимости пришлось бы разбирать.
  const decls = descendants(method, DECLARES).filter((d) =>
    d.type === 'lambda_expression' ? sameName(d.childForFieldName('parameters')) : d.type === 'inferred_parameters' ? d.namedChildren.some(sameName) : sameName(d.childForFieldName('name')),
  );
  const declarator = decls[0];
  if (decls.length !== 1 || declarator.type !== 'variable_declarator') return null;
  const declaration = declarator.parent!;
  if (declaration.type !== 'local_variable_declaration' || declaration.childForFieldName('type')?.text !== 'String') return null;
  if (declaration.namedChildren.filter((c) => c?.type === 'variable_declarator').length !== 1) return null;
  const value = declarator.childForFieldName('value');
  if (value?.text === 'null') return null;

  const typeNode = declaration.childForFieldName('type')!;
  const edits: Edit[] = [
    { start: typeNode.startIndex, end: typeNode.endIndex, text: 'StringBuilder' },
    value
      ? { start: value.startIndex, end: value.endIndex, text: `new StringBuilder(${value.text})` }
      : { start: declarator.endIndex, end: declarator.endIndex, text: ' = new StringBuilder()' },
  ];
  const mentions = (x: Node) => sameName(x) || descendants(x, 'identifier').some(sameName);
  const handled = new Set<number>();
  for (const a of descendants(method, 'assignment_expression')) {
    if (!sameName(a.childForFieldName('left'))) continue;
    if (a.parent?.type !== 'expression_statement') return null; // присваивание внутри выражения
    const op = a.childForFieldName('operator')?.text ?? a.children[1]?.text;
    const right = a.childForFieldName('right')!;
    let text: string;
    if (op === '+=') {
      if (mentions(right)) return null;
      text = `${name}.append(${right.text})`;
    } else if (op === '=') {
      const parts: Node[] = [];
      let cur: Node = right;
      while (cur.type === 'binary_expression' && cur.children[1]?.text === '+') {
        parts.unshift(cur.children[2]!);
        cur = cur.children[0]!;
      }
      if (sameName(cur) && parts.length && !parts.some(mentions)) text = name + parts.map((x) => `.append(${x.text})`).join('');
      else if (!mentions(right) && right.text !== 'null') text = `${name} = new StringBuilder(${right.text})`;
      else return null;
    } else return null;
    edits.push({ start: a.startIndex, end: a.endIndex, text });
    handled.add(a.childForFieldName('left')!.id);
  }
  for (const id of descendants(method, 'identifier')) {
    if (!sameName(id) || handled.has(id.id) || id.startIndex <= declarator.startIndex) continue;
    const parent = id.parent;
    if (parent?.type === 'field_access' && parent.childForFieldName('field')?.id === id.id) continue;
    if (parent?.type === 'method_invocation' && parent.childForFieldName('name')?.id === id.id) continue;
    if (edits.some((e) => e.start <= id.startIndex && id.endIndex <= e.end)) continue;
    edits.push({ start: id.startIndex, end: id.endIndex, text: `${name}.toString()` });
  }
  return { edits };
};

const FLAG = /^(java\.util\.regex\.)?Pattern\.[A-Z_]+(\s*\|\s*(java\.util\.regex\.)?Pattern\.[A-Z_]+)*$/;

/** Шаблон с литералом компилируется один раз в static final поле. */
const regexInLoop: Fixer = (n, ctx) => {
  let first = n;
  while (objectOf(first)?.type === 'method_invocation') first = objectOf(first)!;
  const obj = objectOf(first);
  const name = nameOf(first);
  const args = first.childForFieldName('arguments')?.namedChildren.filter((a): a is Node => !!a) ?? [];
  if (!obj || args[0]?.type !== 'string_literal') return null;
  const PATTERN = 'java.util.regex.Pattern';
  if (obj.text === 'Pattern' && name === 'compile') {
    if (!args.slice(1).every((a) => FLAG.test(a.text))) return null;
    const field = addField(ctx, n, PATTERN, `${PATTERN}.compile(${args.map((a) => a.text).join(', ')})`, 'PATTERN');
    return field ? { edits: [{ start: first.startIndex, end: first.endIndex, text: field }] } : null;
  }
  if (!['matches', 'replaceAll', 'replaceFirst'].includes(name)) return null;
  const field = addField(ctx, n, PATTERN, `${PATTERN}.compile(${args[0].text})`, 'PATTERN');
  if (!field) return null;
  const rest = args.slice(1).map((a) => a.text).join(', ');
  return { edits: [{ start: first.startIndex, end: first.endIndex, text: `${field}.matcher(${obj.text}).${name}(${rest})` }] };
};

/** Вызовы, после которых общий static-экземпляр стал бы другим для всех. */
const MUTATES = /^(configure|register|set|enable|disable|add|find|activate|deactivate|clear|install)/;
const FIELD_NAME: Record<string, string> = { ObjectMapper: 'OBJECT_MAPPER', Gson: 'GSON', XmlMapper: 'XML_MAPPER' };

/** new ObjectMapper() без настройки → static final поле: после создания он потокобезопасен. */
const heavyObject: Fixer = (n, ctx) => {
  const typeText = n.childForFieldName('type')?.text ?? '';
  const base = typeText.split('.').pop()!;
  if (!FIELD_NAME[base] || n.childForFieldName('arguments')?.namedChildCount || descendants(n, 'class_body').length) return null;
  const immutable = base === 'Gson';
  const parent = n.parent;
  if (!immutable) {
    if (parent?.type === 'method_invocation' && objectOf(parent)?.id === n.id) {
      if (MUTATES.test(nameOf(parent))) return null;
    } else if (parent?.type === 'variable_declarator' && parent.parent?.type === 'local_variable_declaration') {
      // Локальная переменная: допустимы только вызовы методов, которые не меняют настройку.
      const v = parent.childForFieldName('name')!.text;
      const method = ancestor(n, ['method_declaration', 'constructor_declaration', 'lambda_expression']);
      if (!method) return null;
      for (const id of descendants(method, 'identifier')) {
        if (id.text !== v || id.id === parent.childForFieldName('name')!.id) continue;
        const use = id.parent;
        if (use?.type !== 'method_invocation' || objectOf(use)?.id !== id.id || MUTATES.test(nameOf(use))) return null;
      }
    } else return null;
  }
  const field = addField(ctx, n, typeText, `new ${typeText}()`, FIELD_NAME[base]);
  return field ? { edits: [{ start: n.startIndex, end: n.endIndex, text: field }] } : null;
};

/** Пустой catch печатает исключение в stderr, как советует рекомендация. */
const emptyCatch: Fixer = (n, ctx) => {
  const param = n.namedChildren.find((c) => c?.type === 'catch_formal_parameter');
  const name = param?.childForFieldName('name')?.text;
  const body = n.childForFieldName('body');
  if (!name || name === '_' || !body) return null;
  const outer = lineIndent(ctx.src, n.startIndex);
  const inner = outer + (outer.includes('\t') ? '\t' : '    ');
  const oneLine = !body.text.includes('\n');
  const text = `\n${inner}System.err.println(${name});${oneLine ? `\n${outer}` : ''}`;
  return { edits: [{ start: body.startIndex + 1, end: body.startIndex + 1, text }], note: 'Добавляет вывод в stderr: проверка поведения покажет расхождение там, где исключение возникает.' };
};

const FIXERS: Record<string, { types: string[]; fix: Fixer }> = {
  'stream-sort-for-min': { types: ['method_invocation'], fix: sortForMin },
  'stream-count-for-exists': { types: ['binary_expression'], fix: countForExists },
  'stream-find-is-present': { types: ['method_invocation'], fix: findIsPresent },
  'string-concat-in-loop': { types: ['assignment_expression'], fix: concatInLoop },
  'regex-in-loop': { types: ['method_invocation'], fix: regexInLoop },
  'heavy-object-per-call': { types: ['object_creation_expression'], fix: heavyObject },
  'empty-catch': { types: ['catch_clause'], fix: emptyCatch },
};

function applyEdits(src: string, edits: Edit[]): string {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const overlaps = (a: Edit, b: Edit) => a.start < b.end && b.start < a.end || (a.start === b.start && a.end === b.end);
const sameEdits = (a: Edit[], b: Edit[]) => a.length === b.length && a.every((e, i) => e.start === b[i].start && e.end === b[i].end && e.text === b[i].text);
function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

const parseErrorCount = (src: string) => {
  const tree = parseJava(src);
  const count = collectErrors(tree.rootNode).length;
  tree.delete();
  return count;
};

// ---------- LLM ----------

const LLM_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['code', 'summary'],
};

export interface Attempt {
  code: string;
  errors: string;
}

async function llmRewrite(method: MethodInfo, src: string, problems: Diagnostic[], classHeader: string, siblings: MethodInfo[], previous: Attempt | null, signal?: AbortSignal): Promise<string> {
  const code = src.slice(method.range.start, method.range.end);
  const prompt = [
    `Исправь дефекты в методе ${method.signature} класса ${method.className}.`,
    '',
    'Дефекты:',
    ...problems.map((d) => `- ${d.title} (строка ${d.range.startLine}): ${d.message} Рекомендация: ${d.recommendation}`),
    '',
    'Требования:',
    '- Поведение не меняется: тот же результат, тот же вывод в stdout/stderr в том же порядке, те же исключения для тех же входов.',
    '- Сигнатура, модификаторы и аннотации метода остаются прежними.',
    '- Можно добавить private-методы (static, если исходный метод static): верни их в code после исправленного метода.',
    '  Остальные методы класса уже есть — вызывай их, но не объявляй заново и не возвращай в code; новым методам дай имена, которых нет в списке.',
    '- Новый метод видит только свои параметры и поля класса. Каждую локальную переменную исходного метода, которая ему нужна, передай параметром;',
    '  если новый метод меняет такую переменную (счётчик, флаг), верни новое значение результатом и присвой его в исходном методе.',
    '- Классы JDK пиши коротким именем (Set, HashSet, Collectors): недостающие import добавятся сами. Сам import в code не пиши.',
    '- Порядок действий с побочным эффектом не меняется: вызовы генератора случайных чисел, вывод, запись в поля и коллекции — в том же порядке.',
    '  Перестановка циклов, обход HashSet/HashMap вместо списка меняют порядок — так нельзя.',
    '- Поля-счётчики шагов (steps++) можно увеличивать реже: их значения при ускорении изменятся, это допустимо.',
    '- Java 17. Сохрани отступы и стиль исходного кода, комментарии оставь.',
    '- code — только Java-код метода (и новых методов), без ``` и пояснений. summary — что изменено, одной фразой по-русски.',
    '',
    'Класс (начало и поля):',
    '```java',
    classHeader.slice(0, 3000),
    '```',
    '',
    ...(siblings.length ? ['Другие методы класса (уже объявлены):', ...siblings.map((x) => `- ${x.isStatic ? 'static ' : ''}${x.returnType ?? ''} ${x.signature}`), ''] : []),
    'Метод:',
    '```java',
    code,
    '```',
    ...(previous
      ? [
          '',
          'Твой предыдущий вариант не подошёл:',
          '```java',
          previous.code,
          '```',
          'Ошибки:',
          previous.errors.slice(0, MAX_ERRORS_TEXT),
          '',
          'Верни исправленный вариант, в котором этих ошибок нет. Тот же код ещё раз не подойдёт: найди, какая правка дала расхождение, и измени подход.',
        ]
      : []),
  ].join('\n');
  const r = await chatJson<{ code?: string }>('Ты опытный Java-разработчик и делаешь рефакторинг без изменения поведения. Отвечай только JSON по схеме.', prompt, LLM_SCHEMA, signal);
  const out = withoutRedeclared((r.code ?? '').replace(/^\s*```(?:java)?\s*\n?|\n?```\s*$/g, '').trimEnd(), siblings);
  if (!out.trim()) throw new Error('пустой ответ');
  if (!out.includes(method.name)) throw new Error(`в ответе нет метода ${method.name}`);
  return reindent(out, lineIndent(src, method.range.start));
}

/**
 * Модель повторяет в ответе методы, которые в классе уже есть, — javac отвергает такой ответ.
 * Копия с той же сигнатурой отбрасывается: остаётся метод из класса.
 */
function withoutRedeclared(code: string, siblings: MethodInfo[]): string {
  const taken = new Set(siblings.map((m) => m.signature));
  const prefix = 'class __Answer {\n';
  const tree = parseJava(prefix + code + '\n}');
  try {
    const members = tree.rootNode.descendantsOfType('class_body')[0]?.namedChildren ?? [];
    const cuts: [number, number][] = [];
    for (const n of members) {
      if (n?.type !== 'method_declaration' || !taken.has(`${n.childForFieldName('name')?.text}(${paramTypes(n).join(', ')})`)) continue;
      // Вместе с javadoc/комментарием прямо над методом.
      let first: Node = n;
      while (first.previousNamedSibling?.type.endsWith('comment') && first.previousNamedSibling.endPosition.row >= first.startPosition.row - 1) first = first.previousNamedSibling;
      cuts.push([first.startIndex - prefix.length, n.endIndex - prefix.length]);
    }
    let out = code;
    for (const [from, to] of cuts.reverse()) out = out.slice(0, from) + out.slice(to);
    return out.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trimEnd();
  } finally {
    tree.delete();
  }
}

/**
 * Модель часто возвращает метод с нулевым отступом. Общий отступ ответа заменяется отступом
 * исходного метода; первая строка встаёт после него, он в исходнике остаётся на месте.
 */
export function reindent(code: string, indent: string): string {
  const lines = code.split('\n');
  // Первая строка в исходнике идёт без отступа — модель часто повторяет это, поэтому в расчёт её не берём.
  const rest = lines.slice(1).filter((l) => l.trim());
  const common = rest.length ? Math.min(...rest.map((l) => l.match(/^[ \t]*/)![0].length)) : 0;
  // Модель пишет с шагом 2 пробела, а файл — с шагом 4: шаг выравнивается под файл.
  const steps = rest.map((l) => l.match(/^ */)![0].length - common).filter((n) => n > 0);
  const double = !indent.includes('\t') && indent.length % 4 === 0 && steps.length > 0 && Math.min(...steps) === 2 && steps.every((n) => n % 2 === 0);
  const shift = (l: string) => {
    const lead = l.slice(common).match(/^ */)![0].length;
    return double ? ' '.repeat(lead * 2) + l.slice(common + lead) : l.slice(common);
  };
  return lines.map((l, i) => (!l.trim() ? '' : i ? indent + shift(l) : l.trimStart())).join('\n');
}

/**
 * Расхождения поведения текстом для модели: вход теста и построчная разница вывода.
 * Строки, где разошлись только счётчики шагов, расхождением не считаются — их и меняет ускорение.
 * Одинаковые расхождения разных тестов сводятся в одно.
 */
function behaviorErrors(r: CompareResult, counters: CounterLine[]): { errors: string | null; counters: string[] } {
  const byText = new Map<string, string[]>();
  const changed = new Set<string>();
  for (const c of r.cases.filter((x) => !x.passed && !x.flaky)) {
    const out: string[] = [];
    for (const stream of ['stdout', 'stderr'] as const) {
      const lines: string[] = [];
      for (const h of diffText(stream, c.original[stream], c.modified[stream])) {
        const only = h.removed.length === h.added.length ? h.removed.map((l, i) => onlyCounters(l, h.added[i], counters)) : [];
        if (only.length && only.every(Boolean)) {
          only.forEach((names) => names!.forEach((n) => changed.add(n)));
          continue;
        }
        lines.push(...h.removed.map((l) => `- ${l}`), ...h.added.map((l) => `+ ${l}`));
      }
      if (lines.length) out.push(`${stream} (- ожидалось, + получено):`, ...lines.slice(0, 20));
    }
    if (c.original.exitCode !== c.modified.exitCode) out.push(`код выхода: ожидался ${c.original.exitCode}, получен ${c.modified.exitCode}`);
    if (c.modified.timedOut && !c.original.timedOut) out.push('программа не завершилась за отведённое время: этот вариант работает медленнее исходного');
    if (!out.length) continue;
    const key = out.join('\n');
    byText.set(key, [...(byText.get(key) ?? []), c.name]);
  }
  const out = [...byText].map(([text, names]) => `${names.length > 1 ? 'Тесты' : 'Тест'} ${names.map((n) => `«${n}»`).join(', ')} — вывод расходится.\n${text}`);
  for (const u of r.units.filter((x) => !x.passed && !x.flaky)) {
    out.push(`Тест-кейс «${u.name}» (${u.label}): ожидалось ${u.original.kind} ${u.original.value}, получено ${u.modified.kind} ${u.modified.value}.`);
  }
  return { errors: out.length ? out.join('\n') : null, counters: [...changed] };
}

/** Классы JDK, которые модель пишет коротким именем: import для них добавляется сам. */
const JDK_CLASSES: Record<string, string> = Object.fromEntries([
  ...['List', 'ArrayList', 'LinkedList', 'Map', 'HashMap', 'LinkedHashMap', 'TreeMap', 'Set', 'HashSet', 'LinkedHashSet', 'TreeSet',
    'Deque', 'ArrayDeque', 'Queue', 'PriorityQueue', 'Arrays', 'Collections', 'Objects', 'Optional', 'Iterator', 'Comparator',
    'BitSet', 'StringJoiner', 'NoSuchElementException'].map((c) => [c, `java.util.${c}`]),
  ...['Collectors', 'Stream', 'IntStream', 'LongStream'].map((c) => [c, `java.util.stream.${c}`]),
  ...['Function', 'BiFunction', 'Predicate', 'Supplier', 'Consumer', 'IntFunction', 'ToIntFunction'].map((c) => [c, `java.util.function.${c}`]),
]);

/** Текст файла с недостающими import по ошибкам javac «cannot find symbol: class X»; null — добавить нечего. */
export function withMissingImports(text: string, errors: string): string | null {
  const missing = [...new Set([...errors.matchAll(/symbol:\s+class (\w+)/g)].map((m) => m[1]))]
    .filter((c) => JDK_CLASSES[c] && !new RegExp(`^import\\s+${JDK_CLASSES[c].replace(/\./g, '\\.')};`, 'm').test(text));
  if (!missing.length) return null;
  const lines = missing.map((c) => `import ${JDK_CLASSES[c]};`).join('\n');
  const anchor = [...text.matchAll(/^import\s+[\w.*]+;[ \t]*$/gm)].pop() ?? text.match(/^package\s+[\w.]+;[ \t]*$/m);
  if (!anchor) return `${lines}\n${text}`;
  const at = anchor.index! + anchor[0].length;
  return `${text.slice(0, at)}\n${lines}${text.slice(at)}`;
}

/** Ошибки сборки проекта или null, если собирается. */
export async function compileErrors(files: SourceFile[]): Promise<string | null> {
  const ws = await Workspace.create(files);
  try {
    const r = await ws.compile(files);
    return r.ok ? null : r.errors.trim() || 'сборка не прошла';
  } finally {
    await ws.dispose();
  }
}

/** Чем проверять ответы LLM: компиляцией (если проект собирается и без правок) и тестами проекта. */
export interface Verification {
  compiles: boolean;
  tests: TestCase[];
  unitCases: UnitCase[];
}

export async function verificationFor(files: SourceFile[], tests: TestCase[] = [], unitCases: UnitCase[] = []): Promise<Verification> {
  const compiles = (await checkJava()).ok && (await compileErrors(files)) === null;
  return { compiles, tests, unitCases };
}

/**
 * Цикл «LLM пишет → проверка → ошибки обратно модели» для одного файла.
 * generate получает прошлую неудачную попытку и возвращает новый текст файла и ответ модели (его она увидит при повторе).
 * withFile(text) — проект с этим текстом файла, before — проект до правки.
 */
export async function verifiedRewrite(opts: {
  src: string;
  before: SourceFile[];
  withFile: (text: string) => SourceFile[];
  generate: (previous: Attempt | null) => Promise<{ text: string; answer: string }>;
  verify: Verification;
  progress: (p: FixProgress) => void;
  signal?: AbortSignal;
  label: string;
}): Promise<{ ok: true; text: string; note: string } | { ok: false; reason: string }> {
  const { src, verify, progress, signal } = opts;
  const checksBehavior = verify.tests.length + verify.unitCases.length > 0;
  const counters = checksBehavior ? counterLines(opts.before) : [];
  /** Сборка и сравнение поведения текста файла: ошибки для модели или число пройденных тестов. */
  const check = async (text: string): Promise<{ errors: string | null; kind: '' | 'compile' | 'behavior'; verified: number; counters: string[] }> => {
    const candidate = opts.withFile(text);
    if (!checksBehavior) {
      const errors = await compileErrors(candidate);
      return { errors, kind: errors ? 'compile' : '', verified: 0, counters: [] };
    }
    // Сравнение с версией до этой правки: так видно влияние именно ответа LLM.
    const r = await compareBehavior(opts.before, candidate, verify.tests, undefined, verify.unitCases);
    if (!r.modifiedCompile.ok) return { errors: r.modifiedCompile.errors.trim() || 'сборка не прошла', kind: 'compile', verified: 0, counters: [] };
    const b = behaviorErrors(r, counters);
    return { errors: b.errors, kind: b.errors ? 'behavior' : '', verified: b.errors ? 0 : r.total, counters: b.counters };
  };
  let previous: Attempt | null = null;
  let failure = '';
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      progress({ step: 'generate', attempt, detail: attempt > 1 ? failure : undefined });
      const generated = await opts.generate(previous);
      let next = generated.text;
      const { answer } = generated;
      const tree = parseJava(next);
      const parseErrors = collectErrors(tree.rootNode);
      tree.delete();
      let errors = parseErrors.length > parseErrorCount(src) ? parseErrors.map((e) => `строка ${e.line}: ${e.message}`).join('\n') : null;
      let kind = errors ? 'parse' : '';
      let verified = 0;
      let changedCounters: string[] = [];
      if (!errors && verify.compiles) {
        progress({ step: checksBehavior ? 'behavior' : 'compile', attempt });
        let r = await check(next);
        // Модель пишет Set или Collectors без import — их добавляем сами, попытку на это не тратим.
        const imported = r.kind === 'compile' ? withMissingImports(next, r.errors!) : null;
        if (imported) {
          next = imported;
          r = await check(next);
        }
        ({ errors, kind, verified } = r);
        changedCounters = r.counters;
      }
      if (errors) {
        console.warn(`LLM: ${opts.label}, попытка ${attempt}: ${errors.split('\n')[0]}`);
        if (process.env.LLM_DEBUG) console.warn(`--- ответ:\n${answer}\n--- ошибки:\n${errors}`);
        previous = { code: answer, errors };
        failure = kind === 'parse' ? 'ответ не разбирается как Java'
          : kind === 'behavior' ? `поведение изменилось: ${errors.split('\n')[0]}`
          : `не компилируется: ${errors.split('\n').find((l) => /error|ошибка/i.test(l))?.trim() ?? errors.split('\n')[0]}`;
        continue;
      }
      const tries = attempt > 1 ? ` с ${attempt}-й попытки` : '';
      const note = !verify.compiles
        ? 'Переписано LLM. Компиляцию проверить не удалось (нет JDK или проект не собирается и без правок): проверьте сборку и поведение.'
        : verified
          ? `Переписано LLM${tries}: проект компилируется, поведение совпало на ${verified} тест(ах)${changedCounters.length ? `; разошлись только счётчики шагов (${changedCounters.join(', ')}) — это ожидаемо при смене алгоритма` : ''}. Тесты покрывают не всё — просмотрите правку.`
          : `Переписано LLM${tries}: проект компилируется, но тестов, на которых можно сравнить поведение, нет — проверьте его вручную.`;
      progress({ step: 'method-done', attempt, ok: true, detail: note });
      return { ok: true, text: next, note };
    } catch (e) {
      if (signal?.aborted) throw e;
      const message = e instanceof Error ? e.message : String(e);
      // Модель зациклилась на повторе токенов — следующая попытка обычно проходит. Сбой связи или пустой ответ повтор не исправит.
      if (/token repeat limit/.test(message)) {
        failure = 'модель зациклилась, ответ оборван';
        continue;
      }
      failure = e instanceof TypeError && message === 'fetch failed' ? 'Ollama недоступна — проверьте адрес в настройках' : `LLM: ${message}`;
      break;
    }
  }
  const reason = `${failure}${attempts > 1 ? ` (попыток: ${attempts})` : ''}`;
  progress({ step: 'method-done', attempt: attempts, ok: false, detail: reason });
  return { ok: false, reason };
}

// ---------- Точка входа ----------

export interface FixOptions {
  onProgress?: (p: FixProgress) => void;
  /** Клиент отменил запрос: генерация прерывается, результат не нужен. */
  signal?: AbortSignal;
}

export async function proposeFixes(req: FixRequest, { onProgress = () => {}, signal }: FixOptions = {}): Promise<FixResult> {
  onProgress({ step: 'rules' });
  const analysis = analyzeProject(req.files);
  const wanted = req.ids ? new Set(req.ids) : null;
  const targets = analysis.diagnostics.filter((d) => (wanted ? wanted.has(d.id) : RULE_FIXES.has(d.rule) || LLM_FIXES.has(d.rule)));
  const applied: AppliedFix[] = [];
  const skipped: FixResult['skipped'] = [];
  const skip = (d: Diagnostic, reason: string) => skipped.push({ title: d.title, file: d.range.file, line: d.range.startLine, reason });
  const toLlm: Diagnostic[] = [];

  // 1. Правила — по файлам: все замены считаются по исходному тексту и применяются разом.
  const files = new Map(req.files.map((f) => [f.path, f.content]));
  const byFile = groupBy(targets.filter((d) => RULE_FIXES.has(d.rule)), (d) => d.range.file);
  for (const [path, diags] of byFile) {
    const src = files.get(path) ?? '';
    const tree = parseJava(src);
    const ctx: Ctx = { src, fields: new Map() };
    const accepted: Edit[] = [];
    const fixesSoFar: Edit[][] = [];
    for (const d of diags) {
      const { types, fix } = FIXERS[d.rule];
      const node = nodeAt(tree.rootNode, d.range.start, d.range.end, types);
      const fieldsBefore = new Map([...ctx.fields].map(([k, e]) => [k, e.list.length]));
      const result = node ? fix(node, ctx) : null;
      if (!result) {
        if (d.methodId) toLlm.push(d);
        else skip(d, 'шаблон исправления не подошёл к этому коду');
        continue;
      }
      const edits = [...result.edits].sort((a, b) => a.start - b.start);
      // Одно исправление на несколько находок (s += … в нескольких местах) — засчитываем один раз.
      if (!fixesSoFar.some((f) => sameEdits(f, edits))) {
        if (edits.some((e) => accepted.some((a) => overlaps(a, e)))) {
          // Поле, которое успело зарегистрироваться, откатывается вместе с исправлением.
          for (const [k, entry] of ctx.fields) entry.list.length = fieldsBefore.get(k) ?? 0;
          skip(d, 'пересекается с другим исправлением — запустите ещё раз после принятия');
          continue;
        }
        accepted.push(...edits);
        fixesSoFar.push(edits);
      }
      applied.push({ rule: d.rule, title: d.title, source: 'rule', file: path, line: d.range.startLine, note: result.note });
    }
    const next = applyEdits(src, [...accepted, ...fieldInsertions(ctx)]);
    tree.delete();
    if (next === src) continue;
    if (parseErrorCount(next) > parseErrorCount(src)) {
      // Защита от ошибки в самом правиле: лучше не исправить, чем сломать файл.
      for (const a of applied.filter((x) => x.file === path)) {
        applied.splice(applied.indexOf(a), 1);
        skipped.push({ title: a.title, file: path, line: a.line, reason: 'после замены файл не разбирается' });
      }
      continue;
    }
    files.set(path, next);
  }

  // 2. LLM — по методам, на тексте после правил. Id методов от правок не меняются.
  for (const d of targets) if (LLM_FIXES.has(d.rule) && !RULE_FIXES.has(d.rule)) toLlm.push(d);
  const llmTargets = toLlm.filter((d) => {
    if (!d.methodId) skip(d, 'исправляется только вручную');
    else if (!req.llm) skip(d, 'нужна LLM — включите переключатель «LLM»');
    return !!d.methodId && req.llm;
  });
  if (llmTargets.length) {
    const current = () => req.files.map((f) => ({ ...f, content: files.get(f.path) ?? f.content }));
    const after = analyzeProject(current());
    const methods = new Map(after.types.flatMap((t) => t.methods).map((m) => [m.id, m]));
    // Компиляция — главная проверка ответа LLM. Если проект не собирается и без правок (нет JDK,
    // зависимостей или код уже сломан), проверить нечем — остаётся разбор синтаксиса.
    onProgress({ step: 'build' });
    const verify = await verificationFor(current(), req.tests, req.unitCases);
    // С конца файла: замена метода сдвигает диапазоны только тех, что ниже.
    const groups = [...groupBy(llmTargets, (d) => d.methodId!)].sort(([a], [b]) => {
      const ma = methods.get(a), mb = methods.get(b);
      return (ma?.range.file ?? '').localeCompare(mb?.range.file ?? '') || (mb?.range.start ?? 0) - (ma?.range.start ?? 0);
    });
    const total = Math.min(groups.length, MAX_LLM_METHODS);
    for (const [i, [methodId, diags]] of groups.entries()) {
      signal?.throwIfAborted();
      const m = methods.get(methodId);
      if (!m) {
        diags.forEach((d) => skip(d, 'метод не найден после правок'));
        continue;
      }
      if (i >= MAX_LLM_METHODS) {
        diags.forEach((d) => skip(d, `за один запуск LLM исправляет до ${MAX_LLM_METHODS} методов — запустите ещё раз`));
        continue;
      }
      const src = files.get(m.range.file) ?? '';
      const type = after.types.find((t) => t.methods.some((x) => x.id === methodId));
      const header = type ? src.slice(type.range.start, Math.min(type.range.end, ...type.methods.map((x) => x.range.start))) : '';
      const r = await verifiedRewrite({
        src,
        before: current(),
        withFile: (text) => current().map((f) => (f.path === m.range.file ? { ...f, content: text } : f)),
        generate: async (previous) => {
          const siblings = (type?.methods ?? []).filter((x) => x.id !== m.id && x.kind !== 'lambda');
          const code = await llmRewrite(m, src, diags, header, siblings, previous, signal);
          return { text: src.slice(0, m.range.start) + code + src.slice(m.range.end), answer: code };
        },
        verify,
        progress: (p) => onProgress({ method: m.signature, ids: diags.map((d) => d.id), index: i + 1, total, maxAttempts: MAX_ATTEMPTS, ...p }),
        signal,
        label: m.signature,
      });
      if (r.ok) {
        files.set(m.range.file, r.text);
        for (const d of diags) applied.push({ rule: d.rule, title: d.title, source: 'llm', file: d.range.file, line: d.range.startLine, note: r.note });
      } else {
        diags.forEach((d) => skip(d, r.reason));
      }
    }
  }

  return { files: req.files.map((f) => ({ ...f, content: files.get(f.path) ?? f.content })), applied, skipped };
}
