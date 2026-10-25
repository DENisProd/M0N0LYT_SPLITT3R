import { randomUUID } from 'node:crypto';
import type { MethodInfo, SourceFile, StubSpec, TypeInfo, UnitCase } from '../../shared/types.ts';
import { analyzeProject } from './analyze.ts';
import { chatJson } from './llm.ts';
import { getSettings } from './store.ts';

/*
 * Генерация тест-кейсов класса.
 *   Эвристики: типичное значение каждого параметра + граничные (0, -1, "", null, пустые коллекции,
 *   все константы enum) по одному параметру за раз — детерминированно и быстро.
 *   Локальная LLM (Ollama): читает код метода и придумывает осмысленные данные и ответы заглушек
 *   для веток if/else и исключений. Облачные API не используются.
 */

const MAX_HEURISTIC_CASES = 8;

interface Ctx {
  /** Типы проекта по простому имени. */
  types: Map<string, TypeInfo>;
  sources: Map<string, string>;
}

const simpleName = (t: TypeInfo) => t.name.split('.').pop()!;
const textOf = (ctx: Ctx, file: string, start: number, end: number) => ctx.sources.get(file)?.slice(start, end) ?? '';
const typeSource = (ctx: Ctx, t: TypeInfo) => textOf(ctx, t.file, t.range.start, t.range.end);

/** "List<Long>" → { base: "List", args: ["Long"] }; запятые внутри вложенных <> не делят. */
function parseType(type: string): { base: string; args: string[]; array: boolean } {
  let t = type.trim();
  const array = /(\[\]|\.\.\.)$/.test(t);
  t = t.replace(/(\[\]|\.\.\.)$/, '');
  const lt = t.indexOf('<');
  if (lt < 0) return { base: t.split('.').pop()!, args: [], array };
  const inner = t.slice(lt + 1, t.lastIndexOf('>'));
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return { base: t.slice(0, lt).split('.').pop()!, args: args.map((a) => a.replace(/^\?\s*(extends|super)\s+/, '')), array };
}

/** Сокращение для имени кейса: `new ArrayList<>()` → «пустой список». */
function describe(v: string): string {
  if (v === 'null') return 'null';
  if (/^new (java\.util\.)?(ArrayList|HashSet|HashMap)<>\(\)$/.test(v)) return 'пусто';
  if (v === '""') return 'пустая строка';
  if (v === '"  "') return 'пробелы';
  const short = v.replace(/\b(?:[a-z]\w*\.)+(?=[A-Z])/g, ''); // org.springframework.data.domain.PageRequest → PageRequest
  return short.length > 28 ? `${short.slice(0, 27)}…` : short;
}

/**
 * Значения для типа: [типичное, ...граничные]. Выражения Java, которые компилируются в пакете класса
 * с его импортами. Неизвестный тип — только null.
 */
function samples(type: string, ctx: Ctx, depth = 0): string[] {
  const { base, args, array } = parseType(type);
  if (array) {
    const elem = type.replace(/(\[\]|\.\.\.)$/, '').replace(/<.*>/s, '');
    const first = samples(elem, ctx, depth + 1)[0];
    return [`new ${elem}[]{${first}}`, `new ${elem}[0]`, 'null'];
  }
  const elem = (i: number) => samples(args[i] ?? 'Object', ctx, depth + 1)[0];
  switch (base) {
    case 'int': return ['1', '0', '-1'];
    case 'Integer': return ['1', '0', '-1', 'null'];
    case 'long': return ['1L', '0L', '-1L'];
    case 'Long': return ['1L', '0L', '-1L', 'null'];
    case 'short': case 'Short': return ['(short) 1', '(short) 0'];
    case 'byte': case 'Byte': return ['(byte) 1', '(byte) 0'];
    case 'double': return ['1.5', '0.0', '-1.0'];
    case 'Double': return ['1.5', '0.0', '-1.0', 'null'];
    case 'float': case 'Float': return ['1.5f', '0f'];
    case 'boolean': return ['true', 'false'];
    case 'Boolean': return ['true', 'false', 'null'];
    case 'char': case 'Character': return ["'a'"];
    case 'String': case 'CharSequence': return ['"тест"', '""', '"  "', 'null'];
    case 'Object': return ['"тест"', 'null'];
    case 'BigDecimal': return ['new java.math.BigDecimal("10.50")', 'java.math.BigDecimal.ZERO', 'null'];
    case 'BigInteger': return ['java.math.BigInteger.TEN', 'java.math.BigInteger.ZERO'];
    case 'UUID': return ['java.util.UUID.fromString("00000000-0000-0000-0000-000000000001")', 'null'];
    case 'LocalDate': return ['java.time.LocalDate.of(2024, 1, 15)', 'null'];
    case 'LocalDateTime': return ['java.time.LocalDateTime.of(2024, 1, 15, 10, 0)', 'null'];
    case 'Instant': return ['java.time.Instant.parse("2024-01-15T10:00:00Z")', 'null'];
    case 'List': case 'Collection': case 'Iterable': case 'ArrayList':
      return [`new java.util.ArrayList<>(java.util.List.of(${elem(0)}))`, 'new java.util.ArrayList<>()', 'null'];
    case 'Set': case 'HashSet':
      return [`new java.util.HashSet<>(java.util.Set.of(${elem(0)}))`, 'new java.util.HashSet<>()', 'null'];
    case 'Map': case 'HashMap':
      return [`new java.util.HashMap<>(java.util.Map.of(${elem(0)}, ${elem(1)}))`, 'new java.util.HashMap<>()', 'null'];
    case 'Optional': return [`java.util.Optional.of(${elem(0)})`, 'java.util.Optional.empty()'];
    case 'Pageable': case 'PageRequest': return ['org.springframework.data.domain.PageRequest.of(0, 10)', 'org.springframework.data.domain.PageRequest.of(1, 1)'];
    case 'Sort': return ['org.springframework.data.domain.Sort.unsorted()'];
  }
  const t = ctx.types.get(base);
  if (!t || depth > 2) return ['null'];
  if (t.kind === 'enum' && t.constants?.length) return [...t.constants.slice(0, 3).map((c) => `${base}.${c}`), 'null'];
  const r = recipe(t, ctx, depth);
  return r ? [r, 'null'] : ['null'];
}

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * Как создать заполненный объект типа проекта: record — конструктором, Lombok @Builder — билдером,
 * класс с сеттерами (@Data, @Setter или setX) — блоком `{ X v = new X(); v.setA(..); return v; }`.
 */
function recipe(t: TypeInfo, ctx: Ctx, depth = 0): string | null {
  const base = simpleName(t);
  const value = (type: string) => samples(type, ctx, depth + 1)[0];
  if (t.kind === 'record' && t.components) return `new ${base}(${t.components.map((c) => value(c.type)).join(', ')})`;
  if (t.kind !== 'class' || t.isAbstract) return null;
  const src = typeSource(ctx, t);
  const fields = t.fields.filter((f) => !f.isStatic);
  if (/@Builder\b/.test(src)) return `${base}.builder()${fields.map((f) => `.${f.name}(${value(f.type)})`).join('')}.build()`;
  const ctors = t.methods.filter((m) => m.isConstructor);
  const lombokArgs = /@(AllArgsConstructor|RequiredArgsConstructor|Value)\b/.test(src) && !/@NoArgsConstructor\b/.test(src);
  if (!ctors.some((c) => c.params.length === 0) && (ctors.length || lombokArgs)) return null;
  const lombokSetters = /@(Data|Setter)\b/.test(src);
  const explicit = new Set(t.methods.filter((m) => m.name.startsWith('set') && m.params.length === 1).map((m) => m.name));
  const sets = fields
    .filter((f) => lombokSetters || explicit.has(`set${capitalize(f.name)}`))
    .map((f) => ({ f, v: value(f.type) }))
    .filter((x) => x.v !== 'null')
    .slice(0, 8)
    .map(({ f, v }) => ` v.set${capitalize(f.name)}(${v});`)
    .join('');
  return sets ? `{ ${base} v = new ${base}();${sets} return v; }` : `new ${base}()`;
}

const SPRING_DATA = /extends\s+(?:Jpa|Crud|ListCrud|PagingAndSorting|ListPagingAndSorting|Mongo|Reactive\w*)Repository\s*<\s*([\w.]+)\s*,\s*([\w.]+)\s*>/;

/** Методы зависимости и их типы результата: свои методы интерфейса + унаследованные от Spring Data. */
function dependencyMethods(type: string, ctx: Ctx): Map<string, string> {
  const t = ctx.types.get(parseType(type).base);
  const out = new Map<string, string>();
  if (!t) return out;
  const repo = typeSource(ctx, t).match(SPRING_DATA);
  if (repo) {
    const [, e, id] = repo;
    const inherited: [string, string][] = [
      ['findById', `Optional<${e}>`], ['findAll', `List<${e}>`], ['findAllById', `List<${e}>`], ['save', e], ['saveAll', `List<${e}>`],
      ['saveAndFlush', e], ['getReferenceById', e], ['existsById', 'boolean'], ['count', 'long'],
      ['deleteById', 'void'], ['delete', 'void'], ['deleteAll', 'void'], ['deleteAllById', 'void'], ['flush', 'void'],
    ];
    for (const [m, r] of inherited) out.set(m, r.replace('ID', id));
  }
  for (const m of t.methods) if (m.returnType && m.kind === 'method') out.set(m.name, m.returnType);
  return out;
}

function makeCase(t: TypeInfo, m: MethodInfo, name: string, args: string[], stubs: StubSpec[], source: UnitCase['source']): UnitCase {
  return {
    id: randomUUID(),
    name,
    methodId: m.id,
    label: `${simpleName(t)}.${m.signature}`,
    binaryName: t.binaryName,
    file: t.file,
    method: m.name,
    params: m.params,
    args,
    stubs,
    source,
  };
}

/** Типичный кейс + по одному граничному значению на параметр. */
function heuristicCases(t: TypeInfo, m: MethodInfo, ctx: Ctx): UnitCase[] {
  const values = m.params.map((p) => samples(p.type, ctx));
  const typical = values.map((v) => v[0]);
  const out = [makeCase(t, m, m.params.length ? 'типичные значения' : 'вызов', typical, [], 'heuristic')];
  for (let i = 0; i < m.params.length && out.length < MAX_HEURISTIC_CASES; i++) {
    for (const v of values[i].slice(1, 3)) {
      if (out.length >= MAX_HEURISTIC_CASES) break;
      const args = [...typical];
      args[i] = v;
      out.push(makeCase(t, m, `${m.params[i].name} = ${describe(v)}`, args, [], 'heuristic'));
    }
  }
  return out;
}

/** Поля, которые драйвер заменит заглушками: зависимости класса, а не значения. */
function dependencies(t: TypeInfo): { name: string; type: string }[] {
  const plain = /^(int|long|short|byte|double|float|boolean|char|String|Integer|Long|Short|Byte|Double|Float|Boolean|Character)$/;
  return t.fields.filter((f) => !f.isStatic && !plain.test(f.type)).map((f) => ({ name: f.name, type: f.type }));
}

// ---------- Локальная LLM ----------

const SCHEMA = {
  type: 'object',
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          stubs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                method: { type: 'string' },
                kind: { type: 'string', enum: ['returns', 'throws'] },
                value: { type: 'string' },
              },
              required: ['field', 'method', 'kind', 'value'],
            },
          },
        },
        required: ['name', 'args', 'stubs'],
      },
    },
  },
  required: ['cases'],
};

/** Типы проекта, упомянутые в классе, и сущности его репозиториев — им нужны рецепты создания. */
function relatedTypes(t: TypeInfo, ctx: Ctx): TypeInfo[] {
  const used = new Set(typeSource(ctx, t).match(/\b[A-Z]\w+/g) ?? []);
  for (const d of dependencies(t)) {
    for (const r of dependencyMethods(d.type, ctx).values()) for (const id of r.match(/\b[A-Z]\w+/g) ?? []) used.add(id);
  }
  return [...ctx.types.values()].filter((x) => x !== t && !x.outer && used.has(simpleName(x)));
}

/** Аргументы вызовов `v.setName(...)` в блоке: имя поля → выражение (скобки и строки учитываются). */
function setterCalls(body: string, variable: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(`\\b${variable}\\.set(\\w+)\\(`, 'g');
  for (let m = re.exec(body); m; m = re.exec(body)) {
    let depth = 1;
    let quoted = false;
    let i = re.lastIndex;
    for (; i < body.length && depth; i++) {
      const ch = body[i];
      if (ch === '"' && body[i - 1] !== '\\') quoted = !quoted;
      else if (!quoted && ch === '(') depth++;
      else if (!quoted && ch === ')') depth--;
    }
    out.set(m[1][0].toLowerCase() + m[1].slice(1), body.slice(re.lastIndex, i - 1).trim());
    re.lastIndex = i;
  }
  return out;
}

/**
 * Модель создаёт record блоком с сеттерами, которых у record нет:
 * `{ Dto v = new Dto(); v.setName("x"); return v; }` → `new Dto(<id>, "x", …)` по порядку компонентов.
 */
function recordFromSetters(value: string, ctx: Ctx): string {
  const m = value.trim().match(/^\{\s*(\w+)\s+(\w+)\s*=\s*new\s+(\w+)\s*\(\s*\)\s*;([\s\S]*)return\s+\2\s*;\s*\}$/);
  const record = m && ctx.types.get(m[3]);
  if (!m || record?.kind !== 'record' || !record.components) return value;
  const set = setterCalls(m[4], m[2]);
  return `new ${m[3]}(${record.components.map((c) => set.get(c.name) ?? samples(c.type, ctx)[0]).join(', ')})`;
}

/** Код Java от модели → компилируемое выражение для типа параметра; null — кейс невалиден. */
function normalizeArg(raw: string, type: string, ctx: Ctx): string | null {
  const v = recordFromSetters(raw.trim(), ctx);
  const { base, args } = parseType(type);
  if (!v) return base === 'String' ? '""' : 'null';
  // Вместо значения — выдуманное имя (SomeExistingId): подставляем пример значения типа.
  if (/^(int|Integer|long|Long|short|Short|double|Double|float|Float|BigDecimal|UUID)$/.test(base) && /^[A-Za-z_]\w*$/.test(v) && v !== 'null') {
    return samples(type, ctx)[0];
  }
  // Модель путает код и данные: строка без кавычек, JSON-массив, int для Long.
  if (base === 'String' && !/^(".*"|null)$/s.test(v) && !/[(+]/.test(v)) return JSON.stringify(v);
  const en = ctx.types.get(base);
  if (en?.kind === 'enum') {
    const c = v.replace(/^(?:[\w$]+\.)*/, '');
    if (/^[A-Z_][A-Z0-9_]*$/.test(c)) return en.constants?.includes(c) ? `${base}.${c}` : null;
  }
  if (/^(List|Collection|Iterable|ArrayList|Set|HashSet)$/.test(base) && v.startsWith('[') && v.endsWith(']')) {
    const long = /^(Long|long)$/.test(parseType(args[0] ?? '').base);
    const items = v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map((x) => (long && /^-?\d+$/.test(x) ? `${x}L` : x));
    return /Set$/.test(base)
      ? `new java.util.HashSet<>(java.util.Set.of(${items.join(', ')}))`
      : `new java.util.ArrayList<>(java.util.List.of(${items.join(', ')}))`;
  }
  if (/^(long|Long)$/.test(base) && /^-?\d+$/.test(v)) return `${v}L`;
  if (/^(double|Double)$/.test(base) && /^-?\d+$/.test(v)) return `${v}.0`;
  return v;
}

/** Ответ заглушки по известному типу результата: без Optional там, где его нет, и наоборот. */
function normalizeStub(s: StubSpec, returnType: string | undefined): StubSpec | null {
  let value = s.value.trim();
  if (!value || /^\{\s*\}$/.test(value)) return null;
  if (s.kind === 'throws' || !returnType) return { ...s, value };
  if (returnType === 'void') return null; // ответ void-метода — только исключение
  const optional = /^(java\.util\.)?Optional\b/.test(returnType);
  const wrapped = value.match(/^(?:java\.util\.)?Optional\.(?:of|ofNullable)\((.*)\)$/s);
  const empty = /^(?:java\.util\.)?Optional\.empty\(\)$/.test(value);
  if (!optional) {
    if (empty) return null; // «ничего не найдено» для не-Optional — это ответ по умолчанию
    if (wrapped) value = wrapped[1];
  } else if (!wrapped && !empty && value !== 'null' && !value.startsWith('{')) {
    value = `java.util.Optional.of(${value})`;
  }
  return { ...s, value };
}

async function llmCases(t: TypeInfo, m: MethodInfo, ctx: Ctx): Promise<UnitCase[]> {
  const deps = dependencies(t).map((d) => ({ ...d, methods: dependencyMethods(d.type, ctx) }));
  const recipes = relatedTypes(t, ctx)
    .map((x) => {
      if (x.kind === 'enum') return `- ${simpleName(x)}: ${(x.constants ?? []).map((c) => `${simpleName(x)}.${c}`).join(', ')}`;
      const r = recipe(x, ctx);
      return r && `- ${simpleName(x)}: ${r}`;
    })
    .filter(Boolean);
  const prompt = [
    `Придумай 3–6 тест-кейсов для метода ${m.returnType ?? ''} ${m.signature} класса ${simpleName(t)}.`,
    'Кейсы нужны для дифференциального тестирования: один и тот же вызов выполняется на старой и новой версии кода, результаты сравниваются.',
    'Покрой разные ветки if/else и switch, исключения, пустые и граничные данные. Каждый кейс должен проверять своё.',
    '',
    `Параметры (args — ровно ${m.params.length}, по порядку):`,
    ...(m.params.length ? m.params.map((p) => `- ${p.type} ${p.name}, пример: ${samples(p.type, ctx)[0]}`) : ['- нет, args пустой']),
    '',
    'Зависимости — заглушки (stubs). field — только из этого списка, method — только из его методов:',
    ...(deps.length
      ? deps.map((d) => `- ${d.name} (${d.type}): ${[...d.methods].map(([name, r]) => `${name}() → ${r}`).join('; ') || 'методы неизвестны'}`)
      : ['- зависимостей нет, stubs пустой']),
    'Без заглушки метод зависимости возвращает null, 0, false, пустую коллекцию, пустую страницу или Optional.empty().',
    '',
    'Как создавать объекты проекта (используй эти рецепты, другие конструкторы могут не существовать):',
    ...(recipes.length ? recipes : ['- нет']),
    '',
    'Формат: args и value — код Java, а не JSON.',
    '- Строки в кавычках: "текст". Числа Long с суффиксом: 1L. Enum с именем типа: CategoryType.CITY.',
    '- Списки: new java.util.ArrayList<>(java.util.List.of(...)). Объект с сеттерами — блок { X v = new X(); v.setA(...); return v; }.',
    '- value совпадает по типу с результатом метода зависимости (Optional только там, где метод возвращает Optional). Для kind = "throws" value — new RuntimeException("…").',
    '- name — короткое описание кейса по-русски: «категория не найдена», «пустое имя».',
    '',
    'Класс:',
    '```java',
    typeSource(ctx, t).slice(0, 8000),
    '```',
  ].join('\n');

  const parsed = await chatJson<{ cases?: { name?: string; args?: unknown[]; stubs?: Partial<StubSpec>[] }[] }>(
    'Ты опытный Java-разработчик и пишешь тест-кейсы. Отвечай только JSON по схеме.',
    prompt,
    SCHEMA,
  );
  const depByName = new Map(deps.map((d) => [d.name, d]));
  const out: UnitCase[] = [];
  for (const c of parsed.cases ?? []) {
    // Неверное число аргументов или несуществующая константа enum — кейс не выполнится, отбрасываем сразу.
    if (!Array.isArray(c.args) || c.args.length !== m.params.length) continue;
    const args = c.args.map((a, i) => normalizeArg(String(a), m.params[i].type, ctx));
    if (args.some((a) => a === null)) continue;
    const stubs = (c.stubs ?? [])
      .filter((s) => s.field && depByName.has(s.field) && s.method && s.value)
      .map((s) => normalizeStub(
        { field: s.field!, method: s.method!, kind: s.kind === 'throws' ? 'throws' : 'returns', value: recordFromSetters(String(s.value), ctx) },
        depByName.get(s.field!)!.methods.get(s.method!),
      ))
      .filter((s): s is StubSpec => s !== null);
    out.push(makeCase(t, m, String(c.name ?? 'кейс LLM'), args as string[], stubs, 'llm'));
  }
  return out;
}


// ---------- Точка входа ----------

export interface GenerateRequest {
  files: SourceFile[];
  /** Класс: имя TypeInfo и файл (имена в разных сервисах совпадают). */
  typeName: string;
  file: string;
  /** Один метод; без него — все методы класса, кроме private и конструкторов. */
  methodId?: string;
  llm: boolean;
}

export async function generateCases(req: GenerateRequest): Promise<{ cases: UnitCase[]; warnings: string[] }> {
  const analysis = analyzeProject(req.files);
  const t = analysis.types.find((x) => x.name === req.typeName && x.file === req.file);
  if (!t) return { cases: [], warnings: [`Класс ${req.typeName} не найден в ${req.file}`] };
  if (t.isAbstract || t.kind === 'interface') {
    return { cases: [], warnings: [`${simpleName(t)} — ${t.kind === 'interface' ? 'интерфейс' : 'абстрактный класс'}: объект не создать, тестируйте реализацию`] };
  }
  const ctx: Ctx = {
    types: new Map(analysis.types.map((x) => [simpleName(x), x])),
    sources: new Map(req.files.map((f) => [f.path, f.content])),
  };
  const isPrivate = (m: MethodInfo) => /^\s*(@\w+(\([^)]*\))?\s+)*private\b/.test(textOf(ctx, m.range.file, m.range.start, m.range.end));
  const methods = t.methods.filter((m) =>
    req.methodId ? m.id === req.methodId : m.kind === 'method' && !isPrivate(m),
  );
  if (!methods.length) return { cases: [], warnings: [`У ${simpleName(t)} нет методов для тестирования`] };

  const cases: UnitCase[] = [];
  const warnings: string[] = [];
  for (const m of methods) {
    const own = heuristicCases(t, m, ctx);
    cases.push(...own);
    if (!req.llm) continue;
    try {
      const seen = new Set(own.map((c) => JSON.stringify([c.args, c.stubs])));
      for (const c of await llmCases(t, m, ctx)) {
        const key = JSON.stringify([c.args, c.stubs]);
        if (!seen.has(key)) cases.push(c);
        seen.add(key);
      }
    } catch (e) {
      // Без LLM остаются эвристические кейсы — сообщаем, а не молчим.
      const msg = `LLM (${(await getSettings()).ollamaModel}) не дала кейсов для ${m.signature}: ${e instanceof Error ? e.message : e}`;
      console.warn(msg);
      warnings.push(msg);
    }
  }
  return { cases, warnings };
}
