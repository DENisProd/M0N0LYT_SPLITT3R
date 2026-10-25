import type { Node, Tree } from 'web-tree-sitter';
import type { FixProgress, FixResult, MethodInfo, PatternApplyRequest, PatternFinding, PatternId, SourceFile, TypeInfo } from '../../shared/types.ts';
import { analyzeProject } from './analyze.ts';
import { MAX_ATTEMPTS, MAX_ERRORS_TEXT, lineIndent, reindent, verificationFor, verifiedRewrite, type Attempt, type FixOptions } from './fixes.ts';
import { chatJson } from './llm.ts';
import { descendants, parseJava, rangeOf } from './parser.ts';

/*
 * Паттерны проектирования по AST, без LLM.
 *   found       — паттерн уже есть: кто в нём какую роль играет и нет ли изъяна (небезопасный Singleton).
 *   opportunity — место, где паттерн упростил бы код: ветвление по типу → Strategy, создание по условию → Factory,
 *                 конструктор с длинным списком параметров → Builder, большой класс → разделение.
 * Применение — через LLM с той же проверкой, что у автоисправления: компиляция и тесты проекта.
 */

const TYPE_DECLS = ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'];
const COLLECTIONS = /^(List|ArrayList|LinkedList|Set|HashSet|LinkedHashSet|Collection|CopyOnWriteArrayList|Queue|Deque)$/;
const LARGE_CLASS_LINES = 400;
const LARGE_CLASS_METHODS = 25;
const BUILDER_PARAMS = 5;
const DISPATCH_BRANCHES = 3;

const modifiersOf = (n: Node) => n.namedChildren.find((c) => c?.type === 'modifiers') ?? null;
const hasModifier = (n: Node, m: string) => !!modifiersOf(n)?.children.some((c) => c?.text === m);
/** Имя типа без пакета и параметров: java.util.List<Order> → List. */
const baseName = (t: string) => t.replace(/<[\s\S]*$/, '').replace(/\[\]/g, '').trim().split('.').pop() ?? t;
/** Аргумент обобщённого типа: List<Listener> → Listener. */
const typeArg = (t: string) => t.match(/<\s*([\w.]+)/)?.[1]?.split('.').pop();
const children = (n: Node | null, type?: string) => (n?.namedChildren ?? []).filter((c): c is Node => !!c && (!type || c.type === type));
const lineCount = (n: Node) => n.endPosition.row - n.startPosition.row + 1;
const unique = <T,>(xs: T[]) => [...new Set(xs)];

function qualifiedName(decl: Node): string {
  const names: string[] = [];
  for (let n: Node | null = decl; n; n = n.parent) if (TYPE_DECLS.includes(n.type)) names.unshift(n.childForFieldName('name')?.text ?? '?');
  return names.join('.');
}

interface Ctx {
  file: string;
  types: TypeInfo[];
  /** Кто наследует или реализует тип (по простому имени). */
  subtypes: Map<string, string[]>;
  methodAt: (n: Node) => MethodInfo | undefined;
  out: PatternFinding[];
}

function add(ctx: Ctx, node: Node, f: Omit<PatternFinding, 'id' | 'range' | 'file'> & { file?: string }) {
  ctx.out.push({ id: `${f.kind}:${f.pattern}:${ctx.file}:${node.startIndex}`, range: rangeOf(node, ctx.file), ...f });
}

// ---------- Найденные паттерны ----------

function singleton(ctx: Ctx, decl: Node) {
  const name = decl.childForFieldName('name')?.text ?? '';
  const body = decl.childForFieldName('body');
  if (decl.type === 'enum_declaration') {
    const constants = children(body, 'enum_constant');
    if (constants.length === 1 && /^INSTANCE$/i.test(constants[0].childForFieldName('name')?.text ?? ''))
      add(ctx, decl, { pattern: 'singleton', kind: 'found', title: 'Singleton (enum)', typeName: qualifiedName(decl), message: `${name}.INSTANCE — единственный экземпляр. Самая надёжная форма: потокобезопасна и устойчива к сериализации и рефлексии.`, roles: [{ role: 'Одиночка', name }] });
    return;
  }
  const ctors = children(body, 'constructor_declaration');
  if (!ctors.length || !ctors.every((c) => hasModifier(c, 'private'))) return;
  const field = children(body, 'field_declaration').find((f) => hasModifier(f, 'static') && baseName(f.childForFieldName('type')?.text ?? '') === name);
  const getter = children(body, 'method_declaration').find((m) => hasModifier(m, 'static') && baseName(m.childForFieldName('type')?.text ?? '') === name);
  if (!field || !getter) return;
  const fieldName = field.childForFieldName('declarator')?.childForFieldName('name')?.text ?? '';
  const lazy = descendants(getter, 'if_statement').some((i) => /==\s*null|null\s*==/.test(i.childForFieldName('condition')?.text ?? ''));
  const locked = hasModifier(getter, 'synchronized') || descendants(getter, 'synchronized_statement').length > 0;
  const warning = !lazy ? undefined
    : !locked ? 'Ленивая инициализация без синхронизации: два потока могут одновременно создать два экземпляра.'
    : !hasModifier(getter, 'synchronized') && !hasModifier(field, 'volatile') ? 'Двойная проверка без volatile: другой поток может увидеть не до конца созданный объект.'
    : undefined;
  add(ctx, decl, {
    pattern: 'singleton', kind: 'found', title: 'Singleton', typeName: qualifiedName(decl), methodId: warning ? ctx.methodAt(getter)?.id : undefined,
    message: `Закрытый конструктор, ${fieldName} хранит единственный экземпляр, ${getter.childForFieldName('name')?.text}() его выдаёт${lazy ? ' (создаёт при первом обращении)' : ''}.`,
    roles: [{ role: 'Одиночка', name }, { role: 'Точка доступа', name: `${getter.childForFieldName('name')?.text}()` }],
    warning, action: warning ? 'llm' : undefined,
  });
}

function builder(ctx: Ctx, decl: Node) {
  const name = decl.childForFieldName('name')?.text ?? '';
  const body = decl.childForFieldName('body');
  const methods = children(body, 'method_declaration');
  const build = methods.find((m) => /^(build|create|get)$/.test(m.childForFieldName('name')?.text ?? ''));
  const fluent = methods.filter((m) => baseName(m.childForFieldName('type')?.text ?? '') === name
    && descendants(m, 'return_statement').some((r) => r.namedChildren[0]?.type === 'this'));
  if (!build || fluent.length < 2 && !/Builder$/.test(name)) return;
  const product = baseName(build.childForFieldName('type')?.text ?? '');
  if (product === name || product === 'void') return;
  add(ctx, decl, {
    pattern: 'builder', kind: 'found', title: 'Builder', typeName: qualifiedName(decl),
    message: `${name} собирает ${product} по шагам: ${fluent.slice(0, 4).map((m) => m.childForFieldName('name')?.text + '()').join(', ')}${fluent.length > 4 ? '…' : ''} и ${build.childForFieldName('name')?.text}().`,
    roles: [{ role: 'Строитель', name }, { role: 'Продукт', name: product }],
  });
}

function factory(ctx: Ctx, method: Node) {
  const product = baseName(method.childForFieldName('type')?.text ?? '');
  const subs = ctx.subtypes.get(product) ?? [];
  if (subs.length < 2) return;
  const created = unique(descendants(method, 'object_creation_expression').map((n) => baseName(n.childForFieldName('type')?.text ?? '')).filter((t) => subs.includes(t)));
  if (created.length < 2) return;
  const m = ctx.methodAt(method);
  add(ctx, method, {
    pattern: 'factory', kind: 'found', title: 'Factory Method', methodId: m?.id, typeName: m?.className,
    message: `${method.childForFieldName('name')?.text}() решает, какой ${product} создать: ${created.join(', ')}. Вызывающий код зависит только от ${product}.`,
    roles: [{ role: 'Фабрика', name: `${m?.className ?? ''}.${method.childForFieldName('name')?.text}()` }, { role: 'Продукт', name: product }, ...created.map((c) => ({ role: 'Конкретный продукт', name: c }))],
  });
}

/** Интерфейс с несколькими реализациями, который класс держит в поле: Strategy, Command, Observer, Decorator. */
function composition(ctx: Ctx, decl: Node, reported: Set<string>) {
  const name = decl.childForFieldName('name')?.text ?? '';
  const body = decl.childForFieldName('body');
  const own = qualifiedName(decl);
  const info = ctx.types.find((t) => t.name === own && t.file === ctx.file);
  const supers = info ? [info.extends, ...info.implements].filter((x): x is string => !!x).map(baseName) : [];
  const ctorParams = children(body, 'constructor_declaration').flatMap((c) => children(c.childForFieldName('parameters'), 'formal_parameter').map((p) => baseName(p.childForFieldName('type')?.text ?? '')));
  for (const f of children(body, 'field_declaration')) {
    const type = f.childForFieldName('type')?.text ?? '';
    const fieldName = f.childForFieldName('declarator')?.childForFieldName('name')?.text ?? '';
    const base = baseName(type);
    // Коллекция подписчиков, которых обходят и уведомляют — Observer.
    const item = COLLECTIONS.test(base) ? typeArg(type) : undefined;
    if (item && ctx.types.some((t) => t.name.split('.').pop() === item && t.kind === 'interface')) {
      const notifies = descendants(body!, 'enhanced_for_statement').some((loop) => {
        if (!new RegExp(`\\b${fieldName}\\b`).test(loop.childForFieldName('value')?.text ?? '')) return false;
        const v = loop.childForFieldName('name')?.text;
        return descendants(loop.childForFieldName('body')!, 'method_invocation').some((c) => c.childForFieldName('object')?.text === v);
      }) || descendants(body!, 'method_invocation').some((c) => c.childForFieldName('name')?.text === 'forEach' && c.childForFieldName('object')?.text.endsWith(fieldName));
      if (notifies && !reported.has(`observer:${own}:${item}`)) {
        reported.add(`observer:${own}:${item}`);
        add(ctx, f, {
          pattern: 'observer', kind: 'found', title: 'Observer', typeName: own,
          message: `${name} хранит подписчиков ${item} в ${fieldName} и уведомляет каждого. Источник событий не знает конкретных классов подписчиков.`,
          roles: [{ role: 'Издатель', name }, { role: 'Подписчик', name: item }, ...(ctx.subtypes.get(item) ?? []).slice(0, 4).map((s) => ({ role: 'Конкретный подписчик', name: s }))],
        });
      }
      continue;
    }
    const target = ctx.types.find((t) => t.name.split('.').pop() === base && t.isAbstract);
    const subs = ctx.subtypes.get(base) ?? [];
    if (!target) continue;
    // Оборачивает объект своего же интерфейса — Decorator (или Proxy).
    if (supers.includes(base) && ctorParams.includes(base)) {
      add(ctx, decl, {
        pattern: 'decorator', kind: 'found', title: 'Decorator', typeName: own,
        message: `${name} реализует ${base} и оборачивает другой ${base} (${fieldName}), добавляя поведение к его вызовам.`,
        roles: [{ role: 'Компонент', name: base }, { role: 'Декоратор', name }, ...subs.filter((s) => s !== name).slice(0, 3).map((s) => ({ role: 'Конкретный компонент', name: s }))],
      });
      continue;
    }
    if (subs.length < 2 || reported.has(`strategy:${base}:${own}`)) continue;
    reported.add(`strategy:${base}:${own}`);
    const ops = target.methods.filter((m) => !m.isStatic && m.kind === 'method');
    const command = /Command$|Action$|Task$/.test(base) || (ops.length === 1 && /^(execute|run|perform|undo|redo)$/.test(ops[0].name));
    add(ctx, f, {
      pattern: command ? 'command' : 'strategy', kind: 'found', title: command ? 'Command' : 'Strategy', typeName: own,
      message: command
        ? `${name} получает действие как объект ${base} и запускает его, не зная, что именно оно делает. Реализации: ${subs.join(', ')}.`
        : `${name} делегирует работу ${base} (${fieldName}); реализацию можно подменить: ${subs.join(', ')}.`,
      roles: [{ role: command ? 'Вызывающий' : 'Контекст', name }, { role: command ? 'Команда' : 'Стратегия', name: base }, ...subs.slice(0, 4).map((s) => ({ role: command ? 'Конкретная команда' : 'Конкретная стратегия', name: s }))],
    });
  }
}

function templateMethod(ctx: Ctx, decl: Node) {
  if (decl.type !== 'class_declaration' || !hasModifier(decl, 'abstract')) return;
  const name = decl.childForFieldName('name')?.text ?? '';
  const methods = children(decl.childForFieldName('body'), 'method_declaration');
  const abstract = new Set(methods.filter((m) => hasModifier(m, 'abstract')).map((m) => m.childForFieldName('name')?.text));
  if (!abstract.size) return;
  for (const m of methods) {
    if (hasModifier(m, 'abstract') || !m.childForFieldName('body')) continue;
    const steps = unique(descendants(m, 'method_invocation')
      .filter((c) => (!c.childForFieldName('object') || c.childForFieldName('object')?.type === 'this') && abstract.has(c.childForFieldName('name')?.text))
      .map((c) => c.childForFieldName('name')!.text));
    if (!steps.length) continue;
    add(ctx, m, {
      pattern: 'template-method', kind: 'found', title: 'Template Method', typeName: qualifiedName(decl), methodId: ctx.methodAt(m)?.id,
      message: `${name}.${m.childForFieldName('name')?.text}() задаёт порядок шагов, а шаги ${steps.map((s) => s + '()').join(', ')} реализуют подклассы.`,
      roles: [{ role: 'Абстрактный класс', name }, { role: 'Шаблонный метод', name: `${m.childForFieldName('name')?.text}()` }, ...(ctx.subtypes.get(name) ?? []).slice(0, 4).map((s) => ({ role: 'Подкласс', name: s }))],
    });
    return;
  }
}

// ---------- Возможности ----------

/** Что сравнивает условие ветки: a.equals("x") / "x".equals(a) / a == X / a instanceof T. */
function subjectOf(cond: Node): { subject: string; instanceOf: boolean } | null {
  let c = cond;
  while (c.type === 'parenthesized_expression' && c.namedChildren[0]) c = c.namedChildren[0];
  if (c.type === 'instanceof_expression') return { subject: c.childForFieldName('left')?.text ?? '', instanceOf: true };
  if (c.type === 'binary_expression' && c.children.some((x) => x?.type === '==')) {
    const [l, r] = [c.childForFieldName('left'), c.childForFieldName('right')];
    const constant = (n: Node | null) => !!n && (/literal/.test(n.type) || /^[A-Z][A-Z0-9_]*$/.test(n.text.split('.').pop() ?? ''));
    if (constant(r) && l) return { subject: l.text, instanceOf: false };
    if (constant(l) && r) return { subject: r.text, instanceOf: false };
  }
  if (c.type === 'method_invocation' && /^equals(IgnoreCase)?$/.test(c.childForFieldName('name')?.text ?? '')) {
    const obj = c.childForFieldName('object');
    const arg = c.childForFieldName('arguments')?.namedChildren[0];
    if (obj?.type === 'string_literal' && arg) return { subject: arg.text, instanceOf: false };
    if (obj && arg?.type === 'string_literal') return { subject: obj.text, instanceOf: false };
  }
  return null;
}

/** Ветви диспетчеризации: группы switch или цепочка if/else if по одному значению. */
function dispatch(ctx: Ctx, n: Node) {
  let branches: Node[] = [];
  let subject = '';
  let instanceOf = false;
  if (n.type === 'switch_expression') {
    branches = children(n.childForFieldName('body')).filter((g) => !g.namedChildren.some((l) => l?.type === 'switch_label' && l.text.startsWith('default')));
    subject = n.childForFieldName('condition')?.text.replace(/^\(|\)$/g, '') ?? '';
  } else {
    if (n.parent?.type === 'if_statement' && n.parent.childForFieldName('alternative')?.equals(n)) return; // не начало цепочки
    const subjects: string[] = [];
    for (let i: Node | null = n; i?.type === 'if_statement'; i = i.childForFieldName('alternative')) {
      const s = subjectOf(i.childForFieldName('condition')!);
      if (!s) break;
      subjects.push(s.subject);
      instanceOf ||= s.instanceOf;
      branches.push(i.childForFieldName('consequence')!);
    }
    if (unique(subjects).length !== 1) return;
    subject = subjects[0];
  }
  if (branches.length < DISPATCH_BRANCHES) return;
  const m = ctx.methodAt(n);
  if (!m) return;
  // Почти в каждой ветке создаётся свой тип — это выбор реализации, ему место в фабрике.
  const created = branches.map((b) => descendants(b, 'object_creation_expression').map((o) => baseName(o.childForFieldName('type')?.text ?? '')));
  const distinct = unique(created.map((c) => c[0]).filter(Boolean));
  if (distinct.length >= DISPATCH_BRANCHES && created.every((c) => c.length === 1)) {
    if (ctx.out.some((f) => f.pattern === 'factory' && f.methodId === m.id)) return; // это уже фабрика
    add(ctx, n, {
      pattern: 'factory', kind: 'opportunity', title: 'Создание по условию → Factory', methodId: m.id, typeName: m.className, action: 'llm',
      message: `${m.name}() выбирает, что создать, по ${subject}: ${distinct.join(', ')}. Фабричный метод соберёт этот выбор в одном месте — новый вариант добавится без правки вызывающего кода.`,
      roles: [{ role: 'Фабрика (будет)', name: `${m.className}.create…()` }, ...distinct.map((d) => ({ role: 'Продукт', name: d }))],
    });
    return;
  }
  if (lineCount(n) < 10) return; // короткое сопоставление «значение → значение» проще оставить как есть
  add(ctx, n, {
    pattern: 'strategy', kind: 'opportunity', title: instanceOf ? 'Проверки instanceof → полиморфизм' : 'Ветвление по типу → Strategy', methodId: m.id, typeName: m.className, action: 'llm',
    message: instanceOf
      ? `${m.name}() проверяет тип ${subject} в ${branches.length} ветках. Метод, переопределённый в каждом типе (или Strategy), уберёт проверки — новый тип не потребует правки этого метода.`
      : `${m.name}() ветвится по ${subject}${n.type === 'switch_expression' ? ' в switch' : ' в if/else'}, вариантов: ${branches.length}. Каждый вариант можно вынести в свою стратегию — добавление нового не затронет остальные.`,
    roles: [{ role: 'Контекст', name: `${m.className}.${m.name}()` }, { role: 'Стратегия (будет)', name: `по ${subject}` }],
  });
}

function wideConstructor(ctx: Ctx, decl: Node) {
  const name = decl.childForFieldName('name')?.text ?? '';
  const body = decl.childForFieldName('body');
  if (children(body, 'class_declaration').some((c) => /Builder$/.test(c.childForFieldName('name')?.text ?? ''))) return;
  const ctors = children(body, 'constructor_declaration');
  const widest = ctors.map((c) => ({ c, n: children(c.childForFieldName('parameters'), 'formal_parameter').length })).sort((a, b) => b.n - a.n)[0];
  if (!widest || (widest.n < BUILDER_PARAMS && ctors.length < 3)) return;
  add(ctx, widest.c, {
    pattern: 'builder', kind: 'opportunity', title: 'Длинный конструктор → Builder', typeName: qualifiedName(decl), action: 'llm',
    message: widest.n >= BUILDER_PARAMS
      ? `new ${name}(…) принимает ${widest.n} параметров — на вызове легко перепутать аргументы одного типа. Builder даст именованные шаги: ${name}.builder().x(…).y(…).build().`
      : `У ${name} ${ctors.length} конструктора для разных наборов параметров. Builder заменит перегрузки одним понятным способом создания.`,
    roles: [{ role: 'Продукт', name }, { role: 'Строитель (будет)', name: `${name}.Builder` }],
  });
}

function largeClass(ctx: Ctx, decl: Node) {
  if (decl.type !== 'class_declaration' || decl.parent?.type !== 'program') return;
  const lines = lineCount(decl);
  const methods = children(decl.childForFieldName('body'), 'method_declaration').length;
  if (lines <= LARGE_CLASS_LINES && methods <= LARGE_CLASS_METHODS) return;
  const name = decl.childForFieldName('name')?.text ?? '';
  add(ctx, decl, {
    pattern: 'extract-class', kind: 'opportunity', title: 'Большой класс → разделение', typeName: name, action: 'split',
    message: `${name}: ${lines} строк, ${methods} методов. Такой класс обычно отвечает за несколько задач сразу — разделение на классы по обязанностям упростит чтение и изменения.`,
    roles: [{ role: 'Класс', name }],
  });
}

// ---------- Точка входа анализа ----------

export function findPatterns(files: SourceFile[], trees: Tree[], types: TypeInfo[]): PatternFinding[] {
  const subtypes = new Map<string, string[]>();
  for (const t of types) {
    for (const s of [t.extends, ...t.implements].filter((x): x is string => !!x).map(baseName)) subtypes.set(s, [...(subtypes.get(s) ?? []), t.name.split('.').pop()!]);
  }
  const methods = types.flatMap((t) => t.methods).filter((m) => m.kind !== 'lambda');
  const out: PatternFinding[] = [];
  const reported = new Set<string>();
  trees.forEach((tree, i) => {
    const file = files[i].path;
    const inFile = methods.filter((m) => m.range.file === file);
    const ctx: Ctx = {
      file, types, subtypes, out,
      methodAt: (n) => inFile.filter((m) => m.range.start <= n.startIndex && n.endIndex <= m.range.end).sort((a, b) => a.range.end - a.range.start - (b.range.end - b.range.start))[0],
    };
    for (const decl of descendants(tree.rootNode, TYPE_DECLS)) {
      singleton(ctx, decl);
      if (decl.type === 'class_declaration') {
        builder(ctx, decl);
        composition(ctx, decl, reported);
        templateMethod(ctx, decl);
        wideConstructor(ctx, decl);
        largeClass(ctx, decl);
      }
    }
    for (const m of descendants(tree.rootNode, 'method_declaration')) factory(ctx, m);
    for (const n of descendants(tree.rootNode, ['switch_expression', 'if_statement'])) dispatch(ctx, n);
  });
  // Сначала найденные, потом возможности; внутри — по файлу и строке.
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'found' ? -1 : 1) || a.range.file.localeCompare(b.range.file) || a.range.start - b.range.start);
}

// ---------- Применение через LLM ----------

const HOWTO: Partial<Record<PatternId, string>> = {
  strategy: [
    'Замени ветвление на Strategy: объяви интерфейс стратегии (или enum с абстрактным методом) и по реализации на каждую ветку;',
    'выбор стратегии по значению — через Map или switch, который только возвращает стратегию. Ветка default/else сохраняет прежнее поведение.',
  ].join('\n'),
  factory: 'Вынеси выбор создаваемого объекта в фабричный метод (private static … create…(…)), который возвращает общий супертип; исходный метод вызывает его.',
  builder: [
    'Добавь в класс public static final class Builder: поле на каждый параметр самого длинного конструктора, метод-шаг с тем же именем, возвращающий this,',
    'и build(), вызывающий этот конструктор. Добавь public static Builder builder(). Существующие конструкторы и их вызовы не меняй.',
  ].join('\n'),
  singleton: 'Сделай получение экземпляра потокобезопасным: идиома holder (private static class Holder { static final X INSTANCE = new X(); }) или synchronized. Поведение для однопоточного кода не меняется.',
};

const SCHEMA = {
  type: 'object',
  properties: { code: { type: 'string' }, additions: { type: 'string' }, summary: { type: 'string' } },
  required: ['code', 'additions', 'summary'],
};

const stripFence = (s: string) => s.replace(/^\s*```(?:java)?\s*\n?|\n?```\s*$/g, '').trimEnd();

/** Место перед закрывающей скобкой тела класса: туда встают новые вложенные типы и методы. */
function classEnd(src: string, type: TypeInfo): { at: number; indent: string } | null {
  const tree = parseJava(src);
  try {
    const decl = descendants(tree.rootNode, TYPE_DECLS).find((d) => d.startIndex === type.range.start);
    const body = decl?.childForFieldName('body');
    if (!body) return null;
    const close = body.endIndex - 1;
    const lineStart = src.lastIndexOf('\n', close - 1) + 1;
    const onOwnLine = !src.slice(lineStart, close).trim();
    const unit = lineIndent(src, decl!.startIndex);
    const member = children(body)[0];
    return { at: onOwnLine ? lineStart : close, indent: member ? lineIndent(src, member.startIndex) : unit + '    ' };
  } finally {
    tree.delete();
  }
}

export async function applyPattern(req: PatternApplyRequest, { onProgress = () => {}, signal }: FixOptions = {}): Promise<FixResult> {
  const analysis = analyzeProject(req.files);
  const finding = analysis.patterns.find((p) => p.id === req.findingId);
  if (!finding) throw new Error('Находка устарела: код изменился — обновите анализ');
  if (finding.action !== 'llm') throw new Error('Для этой находки автоматического применения нет');
  const src = req.files.find((f) => f.path === finding.range.file)?.content ?? '';
  const method = finding.methodId ? analysis.types.flatMap((t) => t.methods).find((m) => m.id === finding.methodId) : undefined;
  const type = method ? analysis.types.find((t) => t.methods.some((m) => m.id === method.id)) : analysis.types.find((t) => t.name === finding.typeName && t.file === finding.range.file);
  if (!type) throw new Error(`Класс ${finding.typeName ?? ''} не найден`);
  const end = classEnd(src, type);
  if (!end) throw new Error('Не найдено тело класса');
  const code = method ? src.slice(method.range.start, method.range.end) : '';
  const classText = src.slice(type.range.start, type.range.end);

  onProgress({ step: 'rules', detail: 'Подготовка' });
  const verify = await verificationFor(req.files, req.tests, req.unitCases);
  const label = `${finding.title}: ${method ? method.signature : type.name}`;
  const prompt = (previous: Attempt | null) => [
    `Примени паттерн проектирования в классе ${type.name}.`,
    `Находка: ${finding.message}`,
    '',
    'Как применить:',
    HOWTO[finding.pattern] ?? '',
    '',
    'Требования:',
    '- Поведение не меняется: тот же вывод в stdout/stderr в том же порядке, те же исключения для тех же входов.',
    method ? `- code — новый текст метода ${method.signature} целиком (сигнатура, модификаторы и аннотации прежние).` : '- code — пустая строка: существующие члены класса не меняются.',
    '- additions — новые члены класса (вложенные интерфейсы, классы, enum, поля, методы), они добавятся в конец тела класса.',
    '  Новые типы делай вложенными (static, если класс не требует экземпляра), новых файлов не создавай. Пусто, если добавлять нечего.',
    '- Новых import нет: классы JDK, которых нет в коде, пиши полным именем (java.util.Map).',
    '- Java 17, стиль и отступы как в исходном коде. Без ``` и пояснений в коде. summary — что сделано, одной фразой по-русски.',
    '',
    'Класс:',
    '```java',
    classText.slice(0, 12000),
    '```',
    ...(method ? ['', 'Метод для изменения:', '```java', code, '```'] : []),
    ...(previous ? ['', 'Твой предыдущий вариант не подошёл:', '```java', previous.code, '```', 'Ошибки:', previous.errors.slice(0, MAX_ERRORS_TEXT), '', 'Верни вариант без этих ошибок.'] : []),
  ].join('\n');

  const r = await verifiedRewrite({
    src,
    before: req.files,
    withFile: (text) => req.files.map((f) => (f.path === finding.range.file ? { ...f, content: text } : f)),
    generate: async (previous) => {
      const out = await chatJson<{ code?: string; additions?: string }>('Ты опытный Java-разработчик и применяешь паттерны проектирования без изменения поведения. Отвечай только JSON по схеме.', prompt(previous), SCHEMA, signal);
      const body = method ? stripFence(out.code ?? '') : '';
      const additions = stripFence(out.additions ?? '');
      if (method && !body.trim()) throw new Error('пустой ответ');
      if (method && !body.includes(method.name)) throw new Error(`в ответе нет метода ${method.name}`);
      if (!method && !additions.trim()) throw new Error('пустой ответ');
      let text = src;
      // Сначала вставка в конец класса — она ниже метода и не сдвигает его диапазон.
      if (additions.trim()) text = text.slice(0, end.at) + `\n${end.indent}${reindent(additions, end.indent)}\n` + text.slice(end.at);
      if (method) text = text.slice(0, method.range.start) + reindent(body, lineIndent(src, method.range.start)) + text.slice(method.range.end);
      return { text, answer: [body, additions && `// additions:\n${additions}`].filter(Boolean).join('\n\n') };
    },
    verify,
    progress: (p: FixProgress) => onProgress({ method: label, index: 1, total: 1, maxAttempts: MAX_ATTEMPTS, ...p }),
    signal,
    label,
  });
  const at = { file: finding.range.file, line: finding.range.startLine };
  return r.ok
    ? { files: req.files.map((f) => (f.path === at.file ? { ...f, content: r.text } : f)), applied: [{ rule: `pattern-${finding.pattern}`, title: finding.title, source: 'llm', ...at, note: r.note }], skipped: [] }
    : { files: req.files, applied: [], skipped: [{ title: finding.title, ...at, reason: r.reason }] };
}
