import type { Node } from 'web-tree-sitter';
import type { FlowEdge, FlowGraph, FlowNode, FlowNodeKind, Range } from '../../shared/types.ts';
import { descendants, rangeOf, shortLabel } from './parser.ts';
import { enclosingLambda, lambdaId, pipelinesIn, stagesOf } from './streams.ts';

/** «Висящий» выход, который нужно соединить со следующим узлом. */
interface Exit {
  from: string;
  label?: string;
  kind?: FlowEdge['kind'];
}

interface JumpContext {
  label?: string; // метка для break/continue label
  breaks: Exit[];
  continueTarget?: string; // у switch нет continue
}

const LOOPS = new Set(['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement']);

/**
 * Строит блок-схему тела метода или лямбды. Каждый узел помнит диапазон исходника,
 * поэтому правка узла в графе превращается в точечную замену текста.
 * rootMethodId — метод, в котором объявлена лямбда: от него строятся id вложенных лямбд.
 */
export function buildFlow(
  methodId: string,
  header: string,
  body: Node | null,
  file: string,
  source: string,
  rootMethodId: string = methodId,
): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const jumps: JumpContext[] = [];
  let seq = 0;

  /** Оператор, к которому относится создаваемый узел (для stmtRange). */
  let current: Node | null = null;
  const add = (kind: FlowNodeKind, label: string, range?: Range, editable = false): string => {
    const id = `n${seq++}`;
    nodes.push({ id, kind, label, range, code: range ? source.slice(range.start, range.end) : undefined, editable, stmtRange: current ? rangeOf(current, file) : undefined });
    return id;
  };
  const link = (exits: Exit[], to: string) => {
    for (const e of exits) {
      edges.push({ id: `e${edges.length}`, source: e.from, target: to, label: e.label, kind: e.kind ?? 'normal' });
    }
  };

  const start = add('start', header);
  const end = add('end', 'Конец');

  /** Текст заголовка конструкции до её тела: "for (int i = 0; i < n; i++)". */
  const headerOf = (n: Node, bodyNode: Node | null) => {
    const text = bodyNode ? n.text.slice(0, bodyNode.startIndex - n.startIndex) : n.text;
    return text.trimEnd();
  };
  const headerRange = (n: Node, bodyNode: Node | null): Range => {
    const r = rangeOf(n, file);
    if (!bodyNode) return r;
    const h = headerOf(n, bodyNode);
    const lines = h.split('\n').length - 1;
    return { ...r, end: n.startIndex + h.length, endLine: r.startLine + lines };
  };
  const unparen = (n: Node | null): Node | null =>
    n?.type === 'parenthesized_expression' ? n.namedChildren[0] ?? n : n;

  /** Первый конвейер Stream API в операторе — показываем его стадии прямо в узле. */
  const attachStream = (id: string, n: Node) => {
    const pipeline = pipelinesIn(n)[0];
    if (!pipeline) return false;
    const node = nodes.find((x) => x.id === id)!;
    node.stream = { source: shortLabel(pipeline.source, 50), stages: stagesOf(pipeline, rootMethodId) };
    return true;
  };

  const simple = (n: Node, exits: Exit[]): Exit[] => {
    let kind: FlowNodeKind = 'operation';
    if (n.type === 'local_variable_declaration') kind = 'variable';
    else if (n.type === 'expression_statement' && n.namedChildren[0]?.type === 'method_invocation') kind = 'call';
    const id = add(kind, shortLabel(n.text), rangeOf(n, file), true);
    if (attachStream(id, n)) nodes.find((x) => x.id === id)!.kind = 'stream';
    link(exits, id);
    return [{ from: id }];
  };

  const sequence = (stmts: (Node | null)[], exits: Exit[]): Exit[] => {
    let cur = exits;
    for (const s of stmts) if (s && s.type !== 'line_comment' && s.type !== 'block_comment') cur = stmt(s, cur);
    return cur;
  };

  const loop = (n: Node, exits: Exit[], label?: string): Exit[] => {
    const bodyNode = n.childForFieldName('body');
    const ctx: JumpContext = { label, breaks: [] };
    jumps.push(ctx);
    let out: Exit[];
    if (n.type === 'do_statement') {
      const head = add('loop', 'do', headerRange(n, bodyNode));
      ctx.continueTarget = head;
      link(exits, head);
      const bodyExits = bodyNode ? stmt(bodyNode, [{ from: head, label: 'Тело' }]) : [{ from: head }];
      const condNode = unparen(n.childForFieldName('condition'));
      current = null;
      const cond = add('condition', `while (${shortLabel(condNode?.text ?? '')})`, condNode ? rangeOf(condNode, file) : undefined, !!condNode);
      link(bodyExits, cond);
      link([{ from: cond, label: 'Да', kind: 'back' }], head);
      out = [{ from: cond, label: 'Нет' }];
    } else {
      const head = add('loop', shortLabel(headerOf(n, bodyNode)), headerRange(n, bodyNode), true);
      ctx.continueTarget = head;
      link(exits, head);
      const bodyExits = bodyNode ? stmt(bodyNode, [{ from: head, label: 'Тело' }]) : [];
      link(bodyExits.map((e) => ({ ...e, kind: 'back' as const })), head);
      out = [{ from: head, label: 'Выход' }];
    }
    jumps.pop();
    return [...out, ...ctx.breaks];
  };

  const switchStmt = (n: Node, exits: Exit[], label?: string): Exit[] => {
    const cond = unparen(n.childForFieldName('condition'));
    const sw = add('switch', `switch (${shortLabel(cond?.text ?? '')})`, cond ? rangeOf(cond, file) : undefined, !!cond);
    link(exits, sw);
    const ctx: JumpContext = { label, breaks: [] };
    jumps.push(ctx);
    const out: Exit[] = [];
    let fallthrough: Exit[] = [];
    let hasDefault = false;
    const block = n.childForFieldName('body');
    for (const group of block?.namedChildren ?? []) {
      if (!group) continue;
      const labels = group.namedChildren.filter((c) => c?.type === 'switch_label') as Node[];
      const caseText = labels.map((l) => shortLabel(l.text, 30)).join(', ');
      if (labels.some((l) => l.text.startsWith('default'))) hasDefault = true;
      const entry: Exit[] = [{ from: sw, label: caseText }, ...fallthrough];
      const bodyStmts = group.namedChildren.filter((c) => c && c.type !== 'switch_label');
      if (group.type === 'switch_rule') {
        out.push(...sequence(bodyStmts, entry));
        fallthrough = [];
      } else {
        fallthrough = sequence(bodyStmts, entry);
      }
    }
    out.push(...fallthrough);
    if (!hasDefault) out.push({ from: sw, label: 'иначе' });
    jumps.pop();
    return [...out, ...ctx.breaks];
  };

  const tryStmt = (n: Node, exits: Exit[]): Exit[] => {
    const resources = n.childForFieldName('resources');
    const t = add('try', resources ? `try ${shortLabel(resources.text)}` : 'try', resources ? rangeOf(resources, file) : undefined, !!resources);
    link(exits, t);
    const bodyNode = n.childForFieldName('body');
    const out: Exit[] = bodyNode ? stmt(bodyNode, [{ from: t }]) : [{ from: t }];
    let fin: Node | null = null;
    for (const c of n.namedChildren) {
      if (!c) continue;
      current = null; // catch/finally нельзя удалить или вставить после них как оператор
      if (c.type === 'catch_clause') {
        const param = c.namedChildren.find((x) => x?.type === 'catch_formal_parameter');
        const catchNode = add('catch', `catch (${shortLabel(param?.text ?? '')})`, param ? rangeOf(param, file) : undefined, !!param);
        link([{ from: t, label: 'исключение', kind: 'exception' }], catchNode);
        const catchBody = c.childForFieldName('body');
        out.push(...(catchBody ? stmt(catchBody, [{ from: catchNode }]) : [{ from: catchNode }]));
      } else if (c.type === 'finally_clause') {
        fin = c;
      }
    }
    if (!fin) return out;
    current = null;
    const f = add('finally', 'finally');
    link(out, f);
    const finBody = fin.namedChildren.find((x) => x?.type === 'block') ?? null;
    return finBody ? stmt(finBody, [{ from: f }]) : [{ from: f }];
  };

  const findJump = (label: string | undefined, needContinue: boolean): JumpContext | undefined => {
    for (let i = jumps.length - 1; i >= 0; i--) {
      const j = jumps[i];
      if (label ? j.label === label : !needContinue || j.continueTarget) return j;
    }
    return undefined;
  };

  function stmt(n: Node, exits: Exit[], label?: string): Exit[] {
    if (n.type !== 'block' && n.type !== 'constructor_body') current = n.parent?.type === 'labeled_statement' ? n.parent : n;
    switch (n.type) {
      case 'block':
      case 'constructor_body':
        return sequence(n.namedChildren, exits);
      case 'if_statement': {
        const condNode = unparen(n.childForFieldName('condition'));
        const cond = add('condition', shortLabel(condNode?.text ?? ''), condNode ? rangeOf(condNode, file) : undefined, !!condNode);
        link(exits, cond);
        const cons = n.childForFieldName('consequence');
        const alt = n.childForFieldName('alternative');
        const yes = cons ? stmt(cons, [{ from: cond, label: 'Да' }]) : [{ from: cond, label: 'Да' }];
        const no = alt ? stmt(alt, [{ from: cond, label: 'Нет' }]) : [{ from: cond, label: 'Нет' }];
        return [...yes, ...no];
      }
      case 'for_statement':
      case 'enhanced_for_statement':
      case 'while_statement':
      case 'do_statement':
        return loop(n, exits, label);
      case 'switch_expression':
        return switchStmt(n, exits, label);
      case 'try_statement':
      case 'try_with_resources_statement':
        return tryStmt(n, exits);
      case 'labeled_statement': {
        const name = n.namedChildren[0]?.text;
        const inner = n.namedChildren[1];
        return inner ? stmt(inner, exits, name) : exits;
      }
      case 'return_statement':
      case 'yield_statement': {
        const id = add('return', shortLabel(n.text), rangeOf(n, file), true);
        attachStream(id, n);
        link(exits, id);
        link([{ from: id }], end);
        return [];
      }
      case 'throw_statement': {
        const id = add('throw', shortLabel(n.text), rangeOf(n, file), true);
        link(exits, id);
        link([{ from: id, label: 'исключение', kind: 'exception' }], end);
        return [];
      }
      case 'break_statement': {
        const id = add('break', shortLabel(n.text), rangeOf(n, file), true);
        link(exits, id);
        findJump(n.namedChildren[0]?.text, false)?.breaks.push({ from: id });
        return [];
      }
      case 'continue_statement': {
        const id = add('continue', shortLabel(n.text), rangeOf(n, file), true);
        link(exits, id);
        const target = findJump(n.namedChildren[0]?.text, true)?.continueTarget;
        if (target) link([{ from: id, kind: 'back' }], target);
        return [];
      }
      case 'synchronized_statement': {
        const bodyNode = n.childForFieldName('body') ?? n.namedChildren.find((c) => c?.type === 'block') ?? null;
        return bodyNode ? stmt(bodyNode, exits) : exits;
      }
      case ';':
        return exits;
      default:
        if (LOOPS.has(n.type)) return loop(n, exits, label);
        return simple(n, exits);
    }
  }

  let exits: Exit[];
  if (body && body.parent?.type === 'lambda_expression' && body.type !== 'block') {
    // Лямбда-выражение x -> x.amount() > 0: одно вычисление, результат которого возвращается.
    current = null;
    const id = add('return', shortLabel(body.text), rangeOf(body, file), true);
    attachStream(id, body);
    link([{ from: start }], id);
    exits = [{ from: id }];
  } else {
    exits = body ? stmt(body, [{ from: start }]) : [{ from: start }];
  }
  link(exits, end);

  // Лямбды, объявленные прямо в этом теле (не во вложенных лямбдах), — переходы из узлов.
  const owner = body?.parent?.type === 'lambda_expression' ? body.parent : null;
  const lambdas = body
    ? descendants(body, 'lambda_expression').filter((l) => enclosingLambda(l)?.id === owner?.id)
    : [];
  if (lambdas.length) {
    for (const node of nodes) {
      if (!node.range) continue;
      const inside = lambdas.filter((l) => l.startIndex >= node.range!.start && l.startIndex < node.range!.end);
      if (inside.length) node.lambdas = inside.map((l) => ({ id: lambdaId(rootMethodId, l), line: l.startPosition.row + 1 }));
    }
  }
  return { methodId, nodes, edges };
}
