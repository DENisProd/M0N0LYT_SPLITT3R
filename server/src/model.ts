import type { Node } from 'web-tree-sitter';
import type { CallEdge, FieldInfo, MethodInfo, TypeInfo, TypeKind } from '../../shared/types.ts';
import { descendants, rangeOf, shortLabel } from './parser.ts';
import { enclosingLambda, lambdaId } from './streams.ts';

const TYPE_DECLS: Record<string, TypeKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'record',
};

export interface MethodNode {
  info: MethodInfo;
  node: Node;
  body: Node | null;
  /** Метод, внутри которого объявлена лямбда (для обычных методов — он сам). */
  rootId: string;
}

export interface ExtractedModel {
  types: TypeInfo[];
  methods: MethodNode[];
}

function hasModifier(decl: Node, mod: string): boolean {
  const mods = decl.children.find((c) => c?.type === 'modifiers');
  return !!mods && mods.text.split(/\s+/).includes(mod);
}

function paramsOf(decl: Node): { name: string; type: string }[] {
  const params = decl.childForFieldName('parameters');
  if (!params) return [];
  return params.namedChildren
    .filter((p): p is Node => !!p && (p.type === 'formal_parameter' || p.type === 'spread_parameter'))
    .map((p, i) => {
      const t = p.childForFieldName('type') ?? p.namedChildren.find((c) => c && c.type !== 'modifiers');
      // У spread_parameter имя внутри variable_declarator.
      const name = p.childForFieldName('name') ?? p.namedChildren.find((c) => c?.type === 'variable_declarator')?.childForFieldName('name');
      return { name: name?.text ?? `arg${i}`, type: (t?.text ?? '?') + (p.type === 'spread_parameter' ? '...' : '') };
    });
}

const paramTypes = (decl: Node) => paramsOf(decl).map((p) => p.type);

/** Тело типа: члены класса, включая члены после констант enum. */
function members(body: Node): Node[] {
  const out: Node[] = [];
  for (const c of body.namedChildren) {
    if (!c) continue;
    if (c.type === 'enum_body_declarations') out.push(...(c.namedChildren.filter(Boolean) as Node[]));
    else out.push(c);
  }
  return out;
}

/** Кому адресованы вызовы: имя метода → тексты получателей ("" — свой объект). */
function receiversIn(body: Node | null): Record<string, string[]> | undefined {
  if (!body) return undefined;
  const out: Record<string, string[]> = Object.create(null); // имена вроде toString не должны попадать в прототип
  // Объявленные типы локальных переменных: получатель buffer.toByteArray() записывается как "@ByteArrayOutputStream".
  const locals = new Map<string, string>();
  for (const d of descendants(body, ['local_variable_declaration', 'enhanced_for_statement', 'catch_formal_parameter', 'resource'])) {
    let type = d.childForFieldName('type')?.text ?? d.namedChildren.find((c) => c?.type === 'catch_type')?.text;
    const declarators = d.type === 'local_variable_declaration' ? d.namedChildren.filter((c) => c?.type === 'variable_declarator') as Node[] : [d];
    for (const v of declarators) {
      const name = v.childForFieldName('name')?.text;
      const init = v.childForFieldName('value');
      if (type === 'var') type = init?.type === 'object_creation_expression' ? init.childForFieldName('type')?.text : undefined;
      if (name && type) locals.set(name, type);
    }
  }
  for (const inv of descendants(body, 'method_invocation')) {
    const name = inv.childForFieldName('name')?.text;
    if (!name) continue;
    const obj = inv.childForFieldName('object');
    const text = !obj || obj.text === 'this' ? '' : obj.text.replace(/^this\./, '');
    const receiver = locals.has(text) ? `@${locals.get(text)}` : text;
    const list = (out[name] ??= []);
    if (!list.includes(receiver)) list.push(receiver);
  }
  return Object.keys(out).length ? out : undefined;
}

function callsIn(body: Node | null): string[] {
  if (!body) return [];
  const names = new Set<string>();
  for (const inv of descendants(body, 'method_invocation')) {
    const name = inv.childForFieldName('name')?.text;
    if (name) names.add(name);
  }
  // Ссылки на методы: Order::id, this::format, String::valueOf. Order::new — конструктор.
  for (const ref of descendants(body, 'method_reference')) {
    const parts = ref.text.split('::');
    const target = parts[1]?.trim();
    if (target === 'new') names.add(`new ${parts[0].trim().replace(/<.*$/, '').split('.').pop()}`);
    else if (target) names.add(target);
  }
  for (const creation of descendants(body, 'object_creation_expression')) {
    const type = creation.childForFieldName('type')?.text.replace(/<.*$/, '');
    if (type) names.add(`new ${type}`);
  }
  return [...names];
}

/** Каждая лямбда в теле метода — отдельная единица со своей блок-схемой. */
function lambdasIn(owner: MethodInfo, body: Node | null, file: string): MethodNode[] {
  if (!body) return [];
  const out: MethodNode[] = [];
  for (const l of descendants(body, 'lambda_expression')) {
    const parent = enclosingLambda(l, body.parent ?? undefined);
    const lambdaBody = l.childForFieldName('body');
    const params = l.childForFieldName('parameters') ?? l.namedChildren[0];
    const line = l.startPosition.row + 1;
    const info: MethodInfo = {
      id: lambdaId(owner.id, l),
      kind: 'lambda',
      className: owner.className,
      parentId: parent ? lambdaId(owner.id, parent) : owner.id,
      name: 'λ',
      signature: `λ ${shortLabel(params?.text ?? '()', 40)} · стр. ${line}`,
      params: [],
      isStatic: owner.isStatic,
      isConstructor: false,
      lines: l.endPosition.row - l.startPosition.row + 1,
      range: rangeOf(l, file),
      bodyRange: lambdaBody?.type === 'block' ? rangeOf(lambdaBody, file) : undefined,
      calls: callsIn(lambdaBody),
      receivers: receiversIn(lambdaBody),
    };
    out.push({ info, node: l, body: lambdaBody, rootId: owner.id });
  }
  return out;
}

/**
 * qualifier различает одноимённые классы из разных файлов (OrderDto в двух сервисах):
 * без него у их методов совпали бы id. Без '/' — после него в id начинается лямбда.
 */
export function extractModel(root: Node, file: string, qualifier?: string): ExtractedModel {
  const types: TypeInfo[] = [];
  const methods: MethodNode[] = [];
  const pkg = root.namedChildren.find((c) => c?.type === 'package_declaration')?.namedChildren.find((c) => c?.type !== 'annotation')?.text ?? '';

  const visitType = (decl: Node, outer?: string) => {
    const kind = TYPE_DECLS[decl.type];
    const simpleName = decl.childForFieldName('name')?.text ?? '?';
    const name = outer ? `${outer}.${simpleName}` : simpleName;
    const superclass = decl.childForFieldName('superclass');
    const interfaces = decl.childForFieldName('interfaces') ?? decl.children.find((c) => c?.type === 'extends_interfaces');
    const typeParams = decl.childForFieldName('type_parameters') ?? decl.children.find((c) => c?.type === 'type_parameters');
    const type: TypeInfo = {
      name,
      binaryName: `${pkg ? `${pkg}.` : ''}${name.replace(/\./g, '$')}`,
      kind,
      isAbstract: kind === 'interface' || hasModifier(decl, 'abstract'),
      typeParameters: typeParams?.text,
      file,
      outer,
      extends: superclass?.namedChildren[0]?.text,
      implements: interfaces ? descendants(interfaces, ['type_identifier', 'generic_type', 'scoped_type_identifier'])
        .filter((t) => t.parent?.type === 'type_list')
        .map((t) => t.text) : [],
      fields: [],
      methods: [],
      range: rangeOf(decl, file),
    };
    types.push(type);

    if (kind === 'record') {
      const params = decl.childForFieldName('parameters');
      type.components = (params?.namedChildren ?? [])
        .filter((p): p is Node => p?.type === 'formal_parameter')
        .map((p) => ({ name: p.childForFieldName('name')?.text ?? '?', type: p.childForFieldName('type')?.text ?? '?' }));
      // Компоненты record — это final-поля с неявными аксессорами.
      for (const p of params?.namedChildren.filter((c) => c?.type === 'formal_parameter') as Node[] ?? []) {
        type.fields.push({ name: p.childForFieldName('name')?.text ?? '?', type: p.childForFieldName('type')?.text ?? '?', isStatic: false, range: rangeOf(p, file) });
      }
    }

    const body = decl.childForFieldName('body');
    if (!body) return;
    if (kind === 'enum') {
      type.constants = body.namedChildren.filter((c) => c?.type === 'enum_constant').map((c) => c!.childForFieldName('name')?.text ?? '?');
    }
    for (const m of members(body)) {
      if (TYPE_DECLS[m.type]) {
        visitType(m, name);
      } else if (m.type === 'field_declaration' || m.type === 'constant_declaration') {
        const fieldType = m.childForFieldName('type')?.text ?? '?';
        for (const d of m.namedChildren.filter((c) => c?.type === 'variable_declarator') as Node[]) {
          const field: FieldInfo = {
            name: d.childForFieldName('name')?.text ?? '?',
            type: fieldType,
            isStatic: hasModifier(m, 'static') || type.kind === 'interface',
            range: rangeOf(m, file),
          };
          type.fields.push(field);
        }
      } else if (
        m.type === 'method_declaration' ||
        m.type === 'constructor_declaration' ||
        m.type === 'compact_constructor_declaration'
      ) {
        const isConstructor = m.type !== 'method_declaration';
        const methodName = isConstructor ? simpleName : m.childForFieldName('name')?.text ?? '?';
        const signature = `${methodName}(${paramTypes(m).join(', ')})`;
        const methodBody = m.childForFieldName('body');
        const methodTypeParams = m.childForFieldName('type_parameters') ?? m.children.find((c) => c?.type === 'type_parameters');
        const info: MethodInfo = {
          id: `${name}#${signature}${qualifier ? `@${qualifier}` : ''}`,
          kind: isConstructor ? 'constructor' : 'method',
          typeParameters: methodTypeParams?.text,
          className: name,
          name: methodName,
          signature,
          params: paramsOf(m),
          returnType: isConstructor ? undefined : m.childForFieldName('type')?.text,
          isStatic: hasModifier(m, 'static'),
          isConstructor,
          lines: m.endPosition.row - m.startPosition.row + 1,
          range: rangeOf(m, file),
          bodyRange: methodBody ? rangeOf(methodBody, file) : undefined,
          calls: callsIn(methodBody),
          receivers: receiversIn(methodBody),
        };
        type.methods.push(info);
        methods.push({ info, node: m, body: methodBody, rootId: info.id });
        for (const l of lambdasIn(info, methodBody, file)) {
          type.methods.push(l.info);
          methods.push(l);
        }
      }
    }
  };

  for (const c of root.namedChildren) if (c && TYPE_DECLS[c.type]) visitType(c);
  return { types, methods };
}

const baseName = (t: string | undefined) => t?.replace(/<[\s\S]*$/, '').replace(/\[\]$/, '').split('.').pop()?.trim() ?? '';

/**
 * Разрешение вызовов. Если известен тип получателя (поле, параметр, имя класса, super) —
 * цель ищется в этом типе и его наследниках/реализациях: orderService.place(…) из контроллера
 * с собственным place попадёт в OrderService. Иначе — по имени: сначала метод того же класса,
 * затем единственный метод с таким именем в проекте. Перегрузки не различаем.
 * canCall отсекает цели, недоступные вызывающему файлу (другой сервис — другая JVM).
 */
export function buildCallGraph(types: TypeInfo[], canCall: (fromFile: string, toFile: string) => boolean = () => true): CallEdge[] {
  const byName = new Map<string, MethodInfo[]>();
  // Простое имя типа → он сам и все, кто его расширяет или реализует (транзитивно).
  const directSubs = new Map<string, Set<string>>();
  const projectTypes = new Set(types.map((t) => baseName(t.name)));
  for (const t of types) {
    for (const m of t.methods) {
      if (m.kind === 'lambda') continue; // лямбду нельзя вызвать по имени
      const key = m.isConstructor ? `new ${m.className.split('.').pop()}` : m.name;
      byName.set(key, [...(byName.get(key) ?? []), m]);
    }
    for (const parent of [t.extends, ...t.implements]) {
      const p = baseName(parent);
      if (p) directSubs.set(p, (directSubs.get(p) ?? new Set()).add(baseName(t.name)));
    }
  }
  const family = (name: string) => {
    const out = new Set([name]);
    const queue = [name];
    while (queue.length) for (const s of directSubs.get(queue.pop()!) ?? []) if (!out.has(s)) {
      out.add(s);
      queue.push(s);
    }
    return out;
  };

  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const t of types) {
    const fieldType = new Map(t.fields.map((f) => [f.name, baseName(f.type)]));
    for (const m of t.methods) {
      if (m.parentId) edges.push({ from: m.parentId, to: m.id, kind: 'lambda' });
      const root = m.parentId ? t.methods.find((x) => x.id === m.id.split('/')[0]) ?? m : m;
      const varType = new Map([...fieldType, ...root.params.map((p) => [p.name, baseName(p.type)] as const)]);
      for (const call of m.calls) {
        const candidates = (byName.get(call) ?? []).filter((c) => canCall(m.range.file, c.range.file));
        const sameClass = candidates.filter((c) => c.className === m.className);
        const byNameOnly = () => (sameClass.length ? sameClass : candidates.length <= 3 ? candidates : []);
        const receivers = m.receivers && Object.hasOwn(m.receivers, call) ? m.receivers[call] : undefined;
        let targets: MethodInfo[];
        if (!receivers) targets = byNameOnly(); // ссылки на методы и конструкторы
        else {
          const found = new Set<MethodInfo>();
          for (const r of receivers) {
            const type = r === '' ? '' : r.startsWith('@') ? baseName(r.slice(1)) : r === 'super' ? baseName(t.extends) : /^[A-Z][\w.]*$/.test(r) ? baseName(r) : varType.get(r);
            if (r === '') for (const c of sameClass.length ? sameClass : byNameOnly()) found.add(c);
            else if (type === undefined) for (const c of candidates.length <= 3 ? candidates : []) found.add(c); // получатель — локальная переменная или выражение
            else if (projectTypes.has(type)) {
              const fam = family(type);
              for (const c of candidates) if (fam.has(baseName(c.className))) found.add(c);
            }
            // Тип известен и он не из проекта (List, String, JpaRepository…) — вызов уходит в библиотеку.
          }
          targets = [...found];
        }
        for (const target of targets) {
          const key = `${m.id}->${target.id}`;
          if (target.id === m.id || seen.has(key)) continue;
          seen.add(key);
          edges.push({ from: m.id, to: target.id });
        }
      }
    }
  }
  return edges;
}
