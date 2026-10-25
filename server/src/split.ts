import type { Node } from 'web-tree-sitter';
import type { SourceFile, SplitMember, SplitPart, SplitPlan, SplitRequest, SplitResult } from '../../shared/types.ts';
import { analyzeProject } from './analyze.ts';
import { collectErrors, descendants, parseJava } from './parser.ts';
import { checkJava, compareBehavior, Workspace } from './runner.ts';

/*
 * Разделение большого класса на несколько (Extract Class) без LLM.
 *   План: граф членов класса (метод ↔ поле, метод → метод, общие слова в именах) делится на N частей
 *   агломеративной кластеризацией; часть 0 — исходный класс, в нём остаётся то, что переносить нельзя.
 *   Перенос: члены переезжают в новые классы того же пакета, каждое обращение к ним переписывается:
 *     статический член      → Part.member
 *     член экземпляра       → part.member из исходного класса (поле-делегат), owner.member — обратно,
 *                             owner.part.member — между новыми классами
 *   Проверка: компиляция и тесты проекта на версиях до и после.
 */

interface Unit {
  id: string;
  kind: 'method' | 'field';
  /** Имена: перегрузки метода — одно имя, объявление поля — все переменные (int a, b). */
  names: string[];
  nodes: Node[];
  isStatic: boolean;
  lines: number;
  pinned?: string;
}

interface Ctx {
  src: string;
  file: string;
  decl: Node;
  body: Node;
  className: string;
  units: Unit[];
  methodUnit: Map<string, Unit>;
  fieldUnit: Map<string, Unit>;
  /** Вложенные типы исходного класса: в новых классах их имя уточняется (Main.Order). */
  nested: Map<string, Node>;
}

const ANNOTATIONS_OK = new Set(['Override', 'SuppressWarnings', 'Deprecated', 'SafeVarargs']);
const modifiersOf = (n: Node) => n.namedChildren.find((c) => c?.type === 'modifiers') ?? null;
const hasModifier = (n: Node, m: string) => !!modifiersOf(n)?.children.some((c) => c?.text === m);
const annotationsOf = (n: Node) =>
  (modifiersOf(n)?.namedChildren ?? []).filter((c): c is Node => !!c && /annotation/.test(c.type)).map((a) => a.childForFieldName('name')?.text ?? a.text.slice(1));
const lineCount = (n: Node) => n.endPosition.row - n.startPosition.row + 1;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function load(files: SourceFile[], file: string, typeName: string): { ctx: Ctx | null; error?: string; free: () => void } {
  const src = files.find((f) => f.path === file)?.content;
  if (src === undefined) return { ctx: null, error: `Файл ${file} не найден`, free: () => {} };
  const tree = parseJava(src);
  const free = () => tree.delete();
  const simple = typeName.split('.').pop()!;
  const decl = descendants(tree.rootNode, ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'])
    .find((d) => d.childForFieldName('name')?.text === simple && d.parent?.type === 'program');
  if (!decl) return { ctx: null, error: `${typeName} — не класс верхнего уровня: разделяются только они`, free };
  if (decl.type !== 'class_declaration') return { ctx: null, error: `${simple} — ${decl.type === 'interface_declaration' ? 'интерфейс' : decl.type === 'enum_declaration' ? 'enum' : 'record'}: разделяются только классы`, free };
  const body = decl.childForFieldName('body')!;
  const generic = !!decl.childForFieldName('type_parameters');
  const units: Unit[] = [];
  const methodUnit = new Map<string, Unit>();
  const fieldUnit = new Map<string, Unit>();
  const nested = new Map<string, Node>();
  // Поля, которым присваивают в конструкторе или блоке инициализации: их порядок и смысл привязаны к нему.
  const assignedInInit = new Set<string>();
  for (const c of body.namedChildren) {
    if (!c) continue;
    if (['constructor_declaration', 'block', 'static_initializer'].includes(c.type)) {
      for (const a of descendants(c, 'assignment_expression')) {
        const left = a.childForFieldName('left');
        const name = left?.type === 'field_access' ? left.childForFieldName('field')?.text : left?.text;
        if (name) assignedInInit.add(name);
      }
    }
    if (['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'].includes(c.type)) {
      const name = c.childForFieldName('name')?.text;
      if (name) nested.set(name, c);
    }
  }
  const implementsSomething = !!decl.childForFieldName('interfaces') || !!decl.childForFieldName('superclass');
  for (const c of body.namedChildren) {
    if (!c) continue;
    if (c.type === 'method_declaration') {
      const name = c.childForFieldName('name')!.text;
      let u = methodUnit.get(name);
      if (!u) {
        u = { id: `m:${name}`, kind: 'method', names: [name], nodes: [], isStatic: true, lines: 0 };
        methodUnit.set(name, u);
        units.push(u);
      }
      u.nodes.push(c);
      u.lines += lineCount(c);
      const isStatic = hasModifier(c, 'static');
      u.isStatic &&= isStatic;
      const anns = annotationsOf(c);
      const special = anns.find((a) => !ANNOTATIONS_OK.has(a));
      u.pinned ??=
        name === 'main' && isStatic ? 'точка входа программы'
        : hasModifier(c, 'abstract') || hasModifier(c, 'native') ? 'абстрактный метод'
        : anns.includes('Override') ? 'переопределяет метод родителя или интерфейса'
        : special ? `аннотация @${special} работает, только пока метод в этом классе`
        : !isStatic && generic ? 'класс обобщённый: методы экземпляра используют его параметры типа'
        : !isStatic && implementsSomething && hasModifier(c, 'public') ? 'public-метод класса с родителем: может реализовывать интерфейс'
        : undefined;
    } else if (c.type === 'field_declaration') {
      const names = c.namedChildren.filter((d) => d?.type === 'variable_declarator').map((d) => d!.childForFieldName('name')!.text);
      const isStatic = hasModifier(c, 'static');
      const special = annotationsOf(c).find((a) => !ANNOTATIONS_OK.has(a));
      const u: Unit = {
        id: `f:${names[0]}`, kind: 'field', names, nodes: [c], isStatic, lines: lineCount(c),
        pinned:
          names.includes('serialVersionUID') ? 'служебное поле сериализации'
          : special ? `аннотация @${special}: поле заполняет фреймворк`
          : names.some((n) => assignedInInit.has(n)) ? 'значение задаётся в конструкторе или блоке инициализации'
          : !isStatic && !hasModifier(c, 'private') ? 'не private: его могут читать другие классы'
          : !isStatic && generic ? 'класс обобщённый'
          : undefined,
      };
      units.push(u);
      for (const n of names) fieldUnit.set(n, u);
    }
  }
  return { ctx: { src, file, decl, body, className: decl.childForFieldName('name')!.text, units, methodUnit, fieldUnit, nested }, free };
}

// ---------- Ссылки на члены класса ----------

interface Ref {
  /** Узел, который заменяется: идентификатор, field_access, объект вызова или ссылки на метод. */
  node: Node;
  unit: Unit;
  name: string;
  /** Член класса, внутри которого ссылка; null — конструктор, инициализатор, вложенный тип: они остаются в исходном классе. */
  at: Unit | null;
  /**
   *   bare   — foo / foo(): перед именем вставляется квалификатор
   *   this   — this.foo / this.foo(): this заменяется
   *   static — Main.foo / Main.foo() / Main::foo: имя класса заменяется
   *   mref   — this::foo
   *   other  — m.foo() / m.foo, где m — другой объект этого же класса: после объекта вставляется поле-делегат
   */
  form: 'bare' | 'this' | 'static' | 'mref' | 'other';
}

const DECLARING = ['formal_parameter', 'catch_formal_parameter', 'enhanced_for_statement', 'resource', 'spread_parameter'];

/** Имена, объявленные внутри члена класса: параметры, локальные переменные, поля анонимных классов. Они затеняют поля. */
function localNames(member: Node): Set<string> {
  const names = new Set<string>();
  for (const d of descendants(member, [...DECLARING, 'variable_declarator', 'lambda_expression', 'inferred_parameters'])) {
    if (d.type === 'variable_declarator') {
      // Поля самого класса — не локальные; поля вложенных классов внутри метода — затеняют.
      if (d.parent?.type === 'field_declaration' && d.parent.parent?.id === member.parent?.id) continue;
      names.add(d.childForFieldName('name')!.text);
    } else if (d.type === 'lambda_expression') {
      const p = d.childForFieldName('parameters');
      if (p?.type === 'identifier') names.add(p.text);
    } else if (d.type === 'inferred_parameters') {
      for (const c of d.namedChildren) if (c) names.add(c.text);
    } else {
      const n = d.childForFieldName('name');
      if (n) names.add(n.text);
    }
  }
  return names;
}

/** Внутри вложенного, локального или анонимного класса (относительно тела исходного класса). */
function nestedClassOf(n: Node, body: Node): Node | null {
  for (let p = n.parent; p && p.id !== body.id; p = p.parent) if (p.type === 'class_body' || p.type === 'interface_body' || p.type === 'enum_body') return p;
  return null;
}

function topMember(n: Node, body: Node): Node | null {
  let cur: Node | null = n;
  while (cur && cur.parent?.id !== body.id) cur = cur.parent;
  return cur;
}

/** Переменные типа исходного класса внутри члена: Main m = new Main(…), параметр Main other. */
function ownTypedNames(member: Node, className: string): Set<string> {
  const names = new Set<string>();
  for (const d of descendants(member, ['formal_parameter', 'local_variable_declaration', 'enhanced_for_statement'])) {
    const type = d.childForFieldName('type');
    const declarators = d.type === 'local_variable_declaration' ? (d.namedChildren.filter((c) => c?.type === 'variable_declarator') as Node[]) : [d];
    for (const v of declarators) {
      const init = v.childForFieldName('value');
      const typed = type?.text === className || (type?.text === 'var' && init?.type === 'object_creation_expression' && init.childForFieldName('type')?.text === className);
      const name = v.childForFieldName('name')?.text;
      if (typed && name) names.add(name);
    }
  }
  return names;
}

function collectRefs(ctx: Ctx): { refs: Ref[]; thisRefs: { node: Node; at: Unit }[]; typeRefs: { node: Node; at: Unit; inner: boolean }[] } {
  const { body, className } = ctx;
  const unitByNode = new Map<number, Unit>();
  for (const u of ctx.units) for (const n of u.nodes) unitByNode.set(n.id, u);
  const locals = new Map<number, Set<string>>();
  const localsOf = (m: Node) => locals.get(m.id) ?? locals.set(m.id, localNames(m)).get(m.id)!;
  const refs: Ref[] = [];
  const thisRefs: { node: Node; at: Unit }[] = [];
  const typeRefs: { node: Node; at: Unit; inner: boolean }[] = [];
  const typedCache = new Map<number, Set<string>>();
  // Объект — другой экземпляр этого класса: переменная его типа или new Main(…).
  const isOwnObject = (obj: Node, top: Node | null) =>
    (obj.type === 'object_creation_expression' && obj.childForFieldName('type')?.text === className) ||
    (obj.type === 'identifier' && !!top && (typedCache.get(top.id) ?? typedCache.set(top.id, ownTypedNames(top, className)).get(top.id)!).has(obj.text));
  const whereIs = (n: Node) => {
    const top = topMember(n, body);
    return { top, at: top ? unitByNode.get(top.id) ?? null : null };
  };
  // Метод или поле с тем же именем во вложенном классе перекрывает член исходного класса.
  const shadowedByNested = (n: Node, name: string, kind: 'method' | 'field') => {
    for (let p = n.parent; p && p.id !== body.id; p = p.parent) {
      if (p.type !== 'class_body') continue;
      if (p.namedChildren.some((c) => c && (kind === 'method'
        ? c.type === 'method_declaration' && c.childForFieldName('name')?.text === name
        : c.type === 'field_declaration' && c.namedChildren.some((d) => d?.type === 'variable_declarator' && d.childForFieldName('name')?.text === name)))) return true;
    }
    return false;
  };
  const isClassName = (n: Node | null) => !!n && (n.type === 'identifier' || n.type === 'type_identifier') && n.text === className;

  for (const inv of descendants(body, 'method_invocation')) {
    const name = inv.childForFieldName('name')!.text;
    const unit = ctx.methodUnit.get(name);
    const obj = inv.childForFieldName('object');
    if (!unit || shadowedByNested(inv, name, 'method')) continue;
    const { top, at } = whereIs(inv);
    if (!obj) refs.push({ node: inv.childForFieldName('name')!, unit, name, at, form: 'bare' });
    else if (obj.type === 'this') refs.push({ node: obj, unit, name, at, form: 'this' });
    else if (isClassName(obj)) refs.push({ node: obj, unit, name, at, form: 'static' });
    else if (isOwnObject(obj, top)) refs.push({ node: obj, unit, name, at, form: 'other' });
  }
  for (const ref of descendants(body, 'method_reference')) {
    const [obj, , target] = ref.children;
    const unit = target ? ctx.methodUnit.get(target.text) : undefined;
    if (!obj || !unit) continue;
    const { at } = whereIs(ref);
    if (obj.type === 'this') refs.push({ node: obj, unit, name: target!.text, at, form: 'mref' });
    else if (isClassName(obj)) refs.push({ node: obj, unit, name: target!.text, at, form: 'static' });
  }
  for (const fa of descendants(body, 'field_access')) {
    const obj = fa.childForFieldName('object');
    const field = fa.childForFieldName('field');
    const unit = field ? ctx.fieldUnit.get(field.text) : undefined;
    if (!obj || !unit) continue;
    const { top, at } = whereIs(fa);
    if (obj.type === 'this' && !nestedClassOf(fa, body)) refs.push({ node: obj, unit, name: field!.text, at, form: 'this' });
    else if (isClassName(obj)) refs.push({ node: obj, unit, name: field!.text, at, form: 'static' });
    else if (isOwnObject(obj, top)) refs.push({ node: obj, unit, name: field!.text, at, form: 'other' });
  }
  for (const id of descendants(body, 'identifier')) {
    const unit = ctx.fieldUnit.get(id.text);
    const p = id.parent;
    if (!unit || !p) continue;
    if (p.type === 'variable_declarator' && p.childForFieldName('name')?.id === id.id) continue;
    if (p.type === 'field_access' && p.childForFieldName('field')?.id === id.id) continue;
    if (p.type === 'method_invocation' && p.childForFieldName('name')?.id === id.id) continue;
    if (p.type === 'method_reference' || p.type === 'scoped_identifier' || /annotation|label|break|continue/.test(p.type)) continue;
    if (DECLARING.includes(p.type) && p.childForFieldName('name')?.id === id.id) continue;
    if (p.type === 'inferred_parameters' || (p.type === 'lambda_expression' && p.childForFieldName('parameters')?.id === id.id)) continue;
    const { top, at } = whereIs(id);
    if (top && localsOf(top).has(id.text)) continue;
    if (shadowedByNested(id, id.text, 'field')) continue;
    refs.push({ node: id, unit, name: id.text, at, form: 'bare' });
  }
  for (const t of descendants(body, 'this')) {
    const { at } = whereIs(t);
    const p = t.parent;
    if (!at || nestedClassOf(t, body)) continue;
    // this.x и this.foo() уже учтены как ссылки на члены; здесь — this как значение: register(this).
    if ((p?.type === 'field_access' || p?.type === 'method_invocation' || p?.type === 'method_reference') && p.children[0]?.id === t.id) {
      const name = p.type === 'field_access' ? p.childForFieldName('field')?.text : p.type === 'method_invocation' ? p.childForFieldName('name')?.text : p.children[2]?.text;
      if (name && (ctx.fieldUnit.has(name) || ctx.methodUnit.has(name))) continue;
    }
    thisRefs.push({ node: t, at });
  }
  // Вложенные типы: в новом классе их простое имя не видно.
  for (const t of descendants(body, ['type_identifier', 'identifier'])) {
    if (!ctx.nested.has(t.text)) continue;
    const p = t.parent;
    if (t.type === 'identifier' && !(p && (p.type === 'field_access' || p.type === 'method_invocation' || p.type === 'method_reference') && p.children[0]?.id === t.id)) continue;
    if (p?.type === 'scoped_type_identifier' && p.children[0]?.id !== t.id) continue;
    const { at } = whereIs(t);
    // new Inner() для внутреннего (не static) класса: в новом классе — owner.new Inner().
    const decl = ctx.nested.get(t.text)!;
    const inner = p?.type === 'object_creation_expression' && p.childForFieldName('type')?.id === t.id
      && decl.type === 'class_declaration' && !hasModifier(decl, 'static');
    if (at) typeRefs.push({ node: inner ? p! : t, at, inner });
  }
  return { refs, thisRefs, typeRefs };
}

// ---------- План ----------

/** Глагол в начале имени → роль класса. */
const ROLES: [RegExp, string][] = [
  [/^(parse|read|load|import|scan|fetch)/, 'Reader'],
  [/^(print|report|render|show|display|draw)/, 'Printer'],
  [/^(format|to[A-Z]|stringify)/, 'Formatter'],
  [/^(validate|check|verify|is|has|can|ensure)/, 'Validator'],
  [/^(calc|calculate|compute|count|sum|total|avg|average|max|min|stat)/, 'Calculator'],
  [/^(save|write|store|persist|export)/, 'Writer'],
  [/^(find|search|select|filter|lookup|get|query)/, 'Finder'],
  [/^(build|create|make|new)/, 'Factory'],
  [/^(send|notify|publish|emit)/, 'Notifier'],
  [/^(merge|group|sort|map|convert|transform|normalize)/, 'Processor'],
  [/^(execute|run|process|handle|apply)/, 'Executor'],
];
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/).filter(Boolean).map((w) => w.toLowerCase());
const STOP = new Set(['get', 'set', 'is', 'has', 'to', 'of', 'by', 'for', 'and', 'all', 'from', 'with', 'new', 'the', 'main', 'value', 'data', 'list', 'item', 'items']);

function nameFor(units: Unit[], className: string, taken: Set<string>): { name: string; why: string } {
  const methods = units.filter((u) => u.kind === 'method').map((u) => u.names[0]);
  const roleVotes = new Map<string, number>();
  for (const m of methods) {
    const role = ROLES.find(([re]) => re.test(m))?.[1];
    if (role) roleVotes.set(role, (roleVotes.get(role) ?? 0) + 1);
  }
  const role = [...roleVotes].sort((a, b) => b[1] - a[1])[0]?.[0];
  const nounVotes = new Map<string, number>();
  // У метода первое слово — глагол (findOrder), у поля — само существительное (orders).
  for (const u of units) for (const n of u.names) for (const w of words(n).slice(u.kind === 'method' ? 1 : 0)) if (!STOP.has(w) && w.length > 2) nounVotes.set(w, (nounVotes.get(w) ?? 0) + 1);
  const noun = [...nounVotes].sort((a, b) => b[1] - a[1]).find(([, c]) => c >= 2)?.[0];
  // Ни роли, ни общего слова — по самому крупному члену: shipping() → ShopShipping.
  const largest = [...units].sort((a, b) => b.lines - a.lines)[0];
  const fallback = largest && words(largest.names[0]).find((w) => !STOP.has(w) && w.length > 2);
  let base = noun && role ? `${capitalize(noun)}${role}`
    : noun ? `${className}${capitalize(noun)}`
    : role ? `${className}${role}`
    : fallback ? `${className}${capitalize(fallback)}`
    : `${className}Part`;
  if (base === className) base += 'Part';
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  return { name, why: role ? `методы ${methods.filter((m) => ROLES.find(([, r]) => r === role)?.[0].test(m)).slice(0, 4).join(', ')}` : '' };
}

/**
 * Агломеративная кластеризация переносимых членов в n групп: сливаются самые связанные,
 * с поправкой на размер — чтобы не росла одна часть. Закреплённые члены (main, конструкторы)
 * в кластеризацию не входят: точка входа вызывает почти всё и стянула бы весь класс к себе.
 */
function cluster(ctx: Ctx, refs: Ref[], n: number): Unit[][] {
  const weight = new Map<string, number>();
  const key = (a: Unit, b: Unit) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
  const add = (a: Unit | null, b: Unit, w: number) => {
    if (!a || a === b) return;
    weight.set(key(a, b), (weight.get(key(a, b)) ?? 0) + w);
  };
  for (const r of refs) add(r.at, r.unit, r.unit.kind === 'field' ? 3 : 2);
  // Общее начало имени (parseLine, parseOrder) — слабая, но полезная связь.
  const methods = ctx.units.filter((u) => u.kind === 'method');
  for (const a of methods) for (const b of methods) if (a.id < b.id && words(a.names[0])[0] === words(b.names[0])[0] && words(a.names[0]).length > 1) add(a, b, 1);

  const groups: Unit[][] = ctx.units.filter((u) => !u.pinned).map((u) => [u]);
  const size = (g: Unit[]) => Math.max(1, g.reduce((s, u) => s + u.lines, 0));
  const link = (a: Unit[], b: Unit[]) => {
    let w = 0;
    for (const x of a) for (const y of b) w += weight.get(key(x, y)) ?? 0;
    return w;
  };
  const target = Math.max(1, n);
  while (groups.length > target) {
    let best = -1, bi = -1, bj = -1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const w = link(groups[i], groups[j]);
        const score = (w + 0.01) / Math.sqrt(size(groups[i]) * size(groups[j]));
        if (score > best) best = score, bi = i, bj = j;
      }
    }
    groups[bi].push(...groups[bj]);
    groups.splice(bj, 1);
  }
  return groups;
}

function reasonOf(units: Unit[], refs: Ref[], extra: string): string {
  const inside = new Set(units);
  const fields = [...new Set(refs.filter((r) => r.unit.kind === 'field' && inside.has(r.unit) && r.at && inside.has(r.at) && r.at !== r.unit).map((r) => r.name))];
  const calls = refs.filter((r) => r.unit.kind === 'method' && inside.has(r.unit) && r.at && inside.has(r.at) && r.at !== r.unit).length;
  const parts = [fields.length ? `общие поля: ${fields.slice(0, 4).join(', ')}` : '', calls ? `вызовов внутри: ${calls}` : '', extra].filter(Boolean);
  return parts.join('; ') || 'слабо связаны с остальным кодом';
}

export function planSplit(files: SourceFile[], file: string, typeName: string, parts?: number): SplitPlan {
  const { ctx, error, free } = load(files, file, typeName);
  try {
    if (!ctx) return { file, typeName, members: [], parts: [], suggested: 0, totalLines: 0, error };
    const totalLines = lineCount(ctx.decl);
    // Методы, которые вызывают из других классов: у экземпляра их не перенести без правки вызывающих.
    const analysis = analyzeProject(files);
    const own = new Set(analysis.types.filter((t) => t.file === file && (t.name === ctx.className || t.name.startsWith(`${ctx.className}.`))).flatMap((t) => t.methods.map((m) => m.id)));
    const methodName = (id: string) => id.split('#')[1]?.replace(/\(.*$/, '');
    for (const e of analysis.callGraph) {
      if (own.has(e.from) || !own.has(e.to) || !e.to.startsWith(`${ctx.className}#`)) continue;
      const u = ctx.methodUnit.get(methodName(e.to) ?? '');
      if (u && !u.isStatic) u.pinned ??= 'вызывается из других классов через объект';
    }
    const { refs } = collectRefs(ctx);
    const movable = ctx.units.filter((u) => !u.pinned);
    const suggested = Math.max(2, Math.min(6, Math.round(totalLines / 250) + 1, movable.length + 1));
    const n = Math.max(2, Math.min(parts ?? suggested, movable.length + 1));
    // Исходный класс — тонкая точка входа с закреплёнными членами; переносимые делятся на n − 1 новых классов.
    const ordered = [ctx.units.filter((u) => u.pinned), ...cluster(ctx, refs, n - 1)];
    const taken = new Set([ctx.className, ...ctx.nested.keys(), ...analysis.types.map((t) => t.name.split('.').pop()!)]);
    const planParts: SplitPart[] = ordered.map((g, i) => {
      if (i === 0) return { name: ctx.className, members: g.map((u) => u.id), reason: g.length ? 'остаются конструкторы, точка входа и члены, которые переносить нельзя' : 'остаются конструкторы и вложенные типы' };
      const { name, why } = nameFor(g, ctx.className, taken);
      return { name, members: g.map((u) => u.id), reason: reasonOf(g, refs, why) };
    });
    const members: SplitMember[] = ctx.units.map((u) => ({
      id: u.id,
      kind: u.kind,
      name: u.names.join(', '),
      label: u.kind === 'method'
        ? u.nodes.map((m) => `${m.childForFieldName('name')!.text}${m.childForFieldName('parameters')?.text.replace(/\s+/g, ' ') ?? '()'}`).join('\n')
        : u.nodes[0].childForFieldName('type')?.text ?? '',
      lines: u.lines,
      isStatic: u.isStatic,
      pinned: u.pinned,
    }));
    return { file, typeName, members, parts: planParts, suggested, totalLines };
  } finally {
    free();
  }
}

// ---------- Перенос ----------

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(src: string, edits: Edit[], offset = 0): string {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, e.start - offset) + e.text + out.slice(e.end - offset);
  return out;
}

/** Диапазон члена вместе с комментарием над ним и целыми строками. */
function memberSpan(src: string, n: Node): { start: number; end: number } {
  let first = n;
  for (let p = n.previousNamedSibling; p && /comment/.test(p.type) && src.slice(p.endIndex, first.startIndex).split('\n').length <= 2; p = p.previousNamedSibling) first = p;
  const start = src.lastIndexOf('\n', first.startIndex - 1) + 1;
  const nl = src.indexOf('\n', n.endIndex);
  return { start, end: nl === -1 ? src.length : nl + 1 };
}

/** Снять private: член нужен из другого класса того же пакета. */
function unprivate(n: Node, src: string): Edit | null {
  const mods = modifiersOf(n);
  const p = mods?.children.find((c) => c?.text === 'private');
  if (!p) return null;
  const after = src.slice(p.endIndex).match(/^[ \t]*/)![0].length;
  return { start: p.startIndex, end: p.endIndex + after, text: '' };
}

export function applySplit(files: SourceFile[], plan: SplitPlan): { files: SourceFile[]; created: string[]; notes: string[]; error?: string } {
  const { ctx, error, free } = load(files, plan.file, plan.typeName);
  try {
    if (!ctx) return { files, created: [], notes: [], error };
    const partOf = new Map<Unit, number>();
    const byId = new Map(ctx.units.map((u) => [u.id, u]));
    // Закрепление — из плана: там учтены и вызовы из других классов.
    const pinned = new Set(plan.members.filter((m) => m.pinned).map((m) => m.id));
    plan.parts.forEach((p, i) => p.members.forEach((id) => byId.has(id) && partOf.set(byId.get(id)!, byId.get(id)!.pinned || pinned.has(id) ? 0 : i)));
    for (const u of ctx.units) if (!partOf.has(u)) partOf.set(u, 0);
    const names = plan.parts.map((p, i) => (i === 0 ? ctx.className : p.name.trim()));
    const bad = names.slice(1).find((n) => !/^[A-Z][A-Za-z0-9_]*$/.test(n));
    if (bad !== undefined) return { files, created: [], notes: [], error: `«${bad}» — не имя класса Java: латиница, с заглавной буквы` };
    if (new Set(names).size !== names.length) return { files, created: [], notes: [], error: 'Имена классов повторяются' };
    const used = plan.parts.map((_, i) => i).filter((i) => i > 0 && ctx.units.some((u) => partOf.get(u) === i));
    if (!used.length) return { files, created: [], notes: [], error: 'Ни один член не переносится: в новых классах пусто' };
    const dir = plan.file.includes('/') ? plan.file.slice(0, plan.file.lastIndexOf('/') + 1) : '';
    const clash = used.find((i) => files.some((f) => f.path === `${dir}${names[i]}.java`));
    if (clash !== undefined) return { files, created: [], notes: [], error: `Файл ${dir}${names[clash]}.java уже есть — выберите другое имя` };

    const { refs, thisRefs, typeRefs } = collectRefs(ctx);
    const part = (u: Unit | null) => (u ? partOf.get(u)! : 0);
    const hasInstance = (i: number) => ctx.units.some((u) => partOf.get(u) === i && !u.isStatic);
    const taken = new Set(ctx.units.flatMap((u) => u.names));
    const holder = new Map<number, string>();
    for (const i of used) {
      if (!hasInstance(i)) continue;
      let name = lowerFirst(names[i]);
      for (let k = 2; taken.has(name); k++) name = `${lowerFirst(names[i])}${k}`;
      taken.add(name);
      holder.set(i, name);
    }
    /** Как обратиться из части from к члену части to. */
    const qualifier = (unit: Unit, from: number): string => {
      const to = partOf.get(unit)!;
      if (unit.isStatic) return names[to];
      if (to === from) return 'this';
      if (from === 0) return holder.get(to)!;
      if (to === 0) return 'owner';
      return `owner.${holder.get(to)}`;
    };

    const edits: Edit[] = [];
    const needsAccess = new Set<Node>();
    for (const r of refs) {
      const from = part(r.at);
      const to = partOf.get(r.unit)!;
      if (r.form === 'other') {
        // m.foo(): у объекта класса член теперь в его поле-делегате — m.part.foo().
        if (to === 0) continue;
        if (from !== to) for (const n of r.unit.nodes) needsAccess.add(n);
        edits.push(r.unit.isStatic ? { start: r.node.startIndex, end: r.node.endIndex, text: names[to] } : { start: r.node.endIndex, end: r.node.endIndex, text: `.${holder.get(to)}` });
        continue;
      }
      if (from === to && r.form !== 'static') continue;
      if (from !== to) for (const n of r.unit.nodes) needsAccess.add(n);
      const q = qualifier(r.unit, from);
      if (r.form === 'bare') {
        if (from === to) continue;
        edits.push({ start: r.node.startIndex, end: r.node.startIndex, text: `${q}.` });
      } else {
        edits.push({ start: r.node.startIndex, end: r.node.endIndex, text: q });
      }
    }
    for (const t of thisRefs) if (part(t.at) !== 0) edits.push({ start: t.node.startIndex, end: t.node.endIndex, text: 'owner' });
    for (const t of typeRefs) {
      if (part(t.at) === 0) continue;
      if (t.inner) {
        edits.push({ start: t.node.startIndex, end: t.node.startIndex, text: 'owner.' });
        needsAccess.add(ctx.nested.get(t.node.childForFieldName('type')!.text)!);
        continue;
      }
      edits.push({ start: t.node.startIndex, end: t.node.startIndex, text: `${ctx.className}.` });
      needsAccess.add(ctx.nested.get(t.node.text)!);
    }
    // Всё, к чему обращаются из другого класса, — без private; остальное сохраняет видимость.
    for (const n of needsAccess) {
      const e = unprivate(n, ctx.src);
      if (e) edits.push(e);
    }

    // Исходный файл: перенесённые члены удаляются, правки внутри них уходят в новые классы.
    const spans = ctx.units.filter((u) => partOf.get(u) !== 0).flatMap((u) => u.nodes.map((n) => ({ u, n, ...memberSpan(ctx.src, n) })));
    const inSpan = (e: Edit) => spans.find((s) => s.start <= e.start && e.end <= s.end);
    const keep = edits.filter((e) => !inSpan(e));
    const removals = spans.map((s) => ({ start: s.start, end: s.end, text: '' }));
    const memberIndent = (ctx.src.slice(ctx.src.lastIndexOf('\n', ctx.body.namedChildren.find(Boolean)?.startIndex ?? ctx.body.startIndex) + 1).match(/^[ \t]*/)?.[0]) || '    ';
    // Без private: соседние новые классы обращаются к ним через owner.part.
    // Код новых классов: ссылка owner нужна, только если он обращается к исходному классу.
    const blocksOf = new Map(used.map((i) => [i, spans.filter((s) => partOf.get(s.u) === i).sort((a, b) => a.start - b.start)
      .map((s) => applyEdits(ctx.src.slice(s.start, s.end), edits.filter((e) => e.start >= s.start && e.end <= s.end), s.start).replace(/\s+$/, ''))]));
    const usesOwner = (i: number) => blocksOf.get(i)!.some((b) => /\bowner\b/.test(b));
    const holders = [...holder].map(([i, f]) => `${memberIndent}final ${names[i]} ${f} = new ${names[i]}(${usesOwner(i) ? 'this' : ''});`);
    const insert = holders.length ? [{ start: ctx.body.startIndex + 1, end: ctx.body.startIndex + 1, text: `\n${holders.join('\n')}\n` }] : [];
    const original = applyEdits(ctx.src, [...keep, ...removals, ...insert]).replace(/\n{3,}/g, '\n\n');

    const root = ctx.decl.parent!;
    const header = root.namedChildren.filter((c): c is Node => !!c && (c.type === 'package_declaration' || c.type === 'import_declaration')).map((c) => c.text);
    const pkg = header.find((h) => h.startsWith('package'));
    const imports = header.filter((h) => h.startsWith('import'));
    const created: string[] = [];
    const out = files.map((f) => (f.path === plan.file ? { ...f, content: original } : f));
    for (const i of used) {
      const blocks = blocksOf.get(i)!;
      const instance = holder.has(i) && usesOwner(i);
      const lines = [
        ...(pkg ? [pkg, ''] : []),
        ...(imports.length ? [...imports, ''] : []),
        `/** Выделено из ${ctx.className}: ${plan.parts[i].reason}. */`,
        `final class ${names[i]} {`,
        ...(instance
          ? [`${memberIndent}private final ${ctx.className} owner;`, '', `${memberIndent}${names[i]}(${ctx.className} owner) {`, `${memberIndent}${memberIndent}this.owner = owner;`, `${memberIndent}}`, '']
          // Только статические члены — утилитный класс без экземпляров; с членами экземпляра — обычный конструктор.
          : holder.has(i) ? [] : [`${memberIndent}private ${names[i]}() {`, `${memberIndent}}`, '']),
        blocks.join('\n\n'),
        '}',
        '',
      ];
      const path = `${dir}${names[i]}.java`;
      out.push({ path, content: lines.join('\n') });
      created.push(path);
    }

    // Статические члены, к которым обращаются из других файлов: Main.foo() → Part.foo().
    const moved = new Map(ctx.units.filter((u) => partOf.get(u) !== 0 && u.isStatic).flatMap((u) => u.names.map((n) => [n, names[partOf.get(u)!]] as const)));
    const notes: string[] = [];
    if (moved.size) {
      for (const [k, f] of out.entries()) {
        if (f.path === plan.file || created.includes(f.path) || !f.path.endsWith('.java') || !f.content.includes(ctx.className)) continue;
        const tree = parseJava(f.content);
        const ext: Edit[] = [];
        for (const n of descendants(tree.rootNode, ['method_invocation', 'field_access', 'method_reference'])) {
          const obj = n.type === 'method_reference' ? n.children[0] : n.childForFieldName('object');
          const member = n.type === 'method_invocation' ? n.childForFieldName('name')?.text : n.type === 'field_access' ? n.childForFieldName('field')?.text : n.children[2]?.text;
          const to = member ? moved.get(member) : undefined;
          if (obj && to && (obj.text === ctx.className || obj.text.endsWith(`.${ctx.className}`))) ext.push({ start: obj.startIndex, end: obj.endIndex, text: obj.text.replace(new RegExp(`${ctx.className}$`), to) });
        }
        for (const imp of descendants(tree.rootNode, 'import_declaration')) {
          const m = imp.text.match(new RegExp(`^import\\s+static\\s+([\\w.]*\\b${ctx.className})\\.(\\w+)\\s*;`));
          if (m && moved.has(m[2])) ext.push({ start: imp.startIndex, end: imp.endIndex, text: `import static ${m[1].replace(new RegExp(`${ctx.className}$`), moved.get(m[2])!)}.${m[2]};` });
        }
        tree.delete();
        if (ext.length) {
          out[k] = { ...f, content: applyEdits(f.content, ext) };
          notes.push(`${f.path}: обновлены обращения к перенесённым статическим членам`);
        }
      }
    }
    for (const f of out.filter((x) => x.path === plan.file || created.includes(x.path))) {
      const tree = parseJava(f.content);
      const errors = collectErrors(tree.rootNode);
      tree.delete();
      if (errors.length) return { files, created: [], notes: [], error: `После переноса ${f.path} не разбирается (строка ${errors[0].line}) — сообщите об этом случае` };
    }
    return { files: out, created, notes };
  } finally {
    free();
  }
}

async function compileErrors(files: SourceFile[]): Promise<string | null> {
  const ws = await Workspace.create(files);
  try {
    const r = await ws.compile(files);
    return r.ok ? null : r.errors.trim() || 'сборка не прошла';
  } finally {
    await ws.dispose();
  }
}

/** Перенос и проверка: компиляция, затем тесты проекта на версиях до и после. */
export async function splitClass(req: SplitRequest): Promise<SplitResult> {
  const r = applySplit(req.files, req.plan);
  const empty = { files: req.files, created: [], compiled: null, tests: 0, behaviorSame: null, notes: r.notes };
  if (r.error) return { ...empty, errors: r.error };
  const result: SplitResult = { files: r.files, created: r.created, compiled: null, tests: 0, behaviorSame: null, notes: r.notes };
  if (!(await checkJava()).ok || (await compileErrors(req.files)) !== null) {
    result.notes.push('Компиляцию проверить не удалось: нет JDK или проект не собирается и без правок.');
    return result;
  }
  // Тест-кейсы перенесённых методов вызывают их у исходного класса — после переноса таких методов там нет.
  const movedMethods = new Set(req.plan.parts.slice(1).flatMap((p) => p.members).filter((id) => id.startsWith('m:')).map((id) => id.slice(2)));
  const unitCases = (req.unitCases ?? []).filter((c) => !movedMethods.has(c.methodId.split('#')[1]?.replace(/\(.*$/, '') ?? ''));
  const dropped = (req.unitCases?.length ?? 0) - unitCases.length;
  if (dropped) result.notes.push(`Тест-кейсов перенесённых методов не прогонялось: ${dropped}. Перегенерируйте их для новых классов.`);
  const tests = req.tests ?? [];
  if (!tests.length && !unitCases.length) {
    const errors = await compileErrors(r.files);
    result.compiled = errors === null;
    if (errors) result.errors = errors;
    result.notes.push('Тестов нет: проверена только компиляция.');
    return result;
  }
  const cmp = await compareBehavior(req.files, r.files, tests, undefined, unitCases);
  result.compiled = cmp.modifiedCompile.ok;
  if (!cmp.modifiedCompile.ok) {
    result.errors = cmp.modifiedCompile.errors.trim();
    return result;
  }
  result.tests = cmp.total;
  result.behaviorSame = cmp.total ? cmp.cases.every((c) => c.passed || c.flaky) && cmp.units.every((u) => u.passed || u.flaky) : null;
  if (cmp.runSkipped && !cmp.total) result.notes.push(`Запуск не выполнялся: ${cmp.runSkipped}.`);
  if (result.behaviorSame === false) {
    const bad = [...cmp.cases.filter((c) => !c.passed && !c.flaky).map((c) => `тест «${c.name}»: ${c.mismatches.join(', ')}`), ...cmp.units.filter((u) => !u.passed && !u.flaky).map((u) => `тест-кейс «${u.name}»`)];
    result.errors = `Поведение изменилось — ${bad.slice(0, 5).join('; ')}`;
  }
  return result;
}
