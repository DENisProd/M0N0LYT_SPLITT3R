import type { Node } from 'web-tree-sitter';
import type { Diagnostic, MethodMetrics, TypeInfo } from '../../shared/types.ts';
import type { MethodNode } from './model.ts';
import { descendants, rangeOf } from './parser.ts';
import { isIteratingLambda, isPipelineRoot, pipelineOf } from './streams.ts';

const LOOP_TYPES = ['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement'];
const BRANCH_TYPES = [
  'if_statement',
  ...LOOP_TYPES,
  'catch_clause',
  'ternary_expression',
  'switch_label',
];

const LONG_METHOD = 40;
const VERY_LONG_METHOD = 80;
const HIGH_CYCLOMATIC = 10;

export function bigO(power: number): string {
  if (power <= 0) return 'O(1)';
  if (power === 1) return 'O(n)';
  const sup = ['', '', '²', '³', '⁴', '⁵'];
  return `O(n${sup[power] ?? '^' + power})`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${word}`;
}

/**
 * Сколько проходов по данным охватывает узел: циклы и лямбды, которые
 * вызываются для каждого элемента (filter/map/forEach/groupingBy…).
 */
export function loopDepth(n: Node, stopAt: Node): number {
  let depth = 0;
  for (let child = n, p = n.parent; p && p.id !== stopAt.id; child = p, p = p.parent) {
    // Коллекция в for (x : items) вычисляется один раз, до цикла.
    if (p.type === 'enhanced_for_statement' && p.childForFieldName('value')?.id === child.id) continue;
    if (LOOP_TYPES.includes(p.type) || (p.type === 'lambda_expression' && isIteratingLambda(p))) depth++;
  }
  return depth;
}

/** Единицы итерации: циклы и конвейеры Stream API. */
function iterationUnits(n: Node): Node[] {
  return [...descendants(n, LOOP_TYPES), ...descendants(n, 'method_invocation').filter(isPipelineRoot)];
}

function isInsideLoop(n: Node, stopAt: Node): boolean {
  return loopDepth(n, stopAt) > 0;
}

/** Имя переменной → объявленный тип (параметры, локальные переменные, поля класса). */
export function declaredTypes(m: MethodNode, type: TypeInfo | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of type?.fields ?? []) map.set(f.name, f.type);
  for (const p of descendants(m.node, ['formal_parameter', 'local_variable_declaration', 'enhanced_for_statement'])) {
    const t = p.childForFieldName('type')?.text;
    if (!t) continue;
    if (p.type === 'local_variable_declaration') {
      for (const d of p.namedChildren) if (d?.type === 'variable_declarator') map.set(d.childForFieldName('name')!.text, t);
    } else {
      const name = p.childForFieldName('name')?.text;
      if (name) map.set(name, t);
    }
  }
  return map;
}

const isListType = (t?: string) => !!t && /(^|\b)(List|ArrayList|LinkedList|Collection)\b|\[\]$/.test(t) && !/Set|Map/.test(t);
const isStringType = (t?: string) => t === 'String';

function normalized(n: Node): string {
  return n.text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
}

export function analyze(methods: MethodNode[], types: TypeInfo[]): { diagnostics: Diagnostic[]; metrics: MethodMetrics[] } {
  const diagnostics: Diagnostic[] = [];
  const metrics: MethodMetrics[] = [];
  const typeByName = new Map(types.map((t) => [t.name, t]));
  let seq = 0;
  const reportDiagnostic = (d: Omit<Diagnostic, 'id'>) => diagnostics.push({ id: `d${seq++}`, ...d });

  for (const m of methods) {
    const { info } = m;
    const file = info.range.file;
    const root = m.body ?? m.node;
    const types = declaredTypes(m, typeByName.get(info.className));

    // Тело лямбды уже входит в тело метода: дефекты ищем один раз — на уровне метода,
    // а для лямбды считаем только метрики.
    const isLambda = info.kind === 'lambda';
    const report = isLambda ? () => {} : reportDiagnostic;

    // --- Вложенные циклы и потоки ---
    const units = iterationUnits(root);
    let maxDepth = 0;
    for (const u of units) maxDepth = Math.max(maxDepth, loopDepth(u, root) + 1);
    for (const outer of units.filter((u) => loopDepth(u, root) === 0)) {
      const inner = iterationUnits(outer).filter((u) => u.id !== outer.id);
      const depth = Math.max(1, ...inner.map((u) => loopDepth(u, root) + 1));
      if (depth < 2) continue;
      const withStreams = [outer, ...inner].some((u) => u.type === 'method_invocation');
      const hasEquals = descendants(outer, 'method_invocation').some((c) => c.childForFieldName('name')?.text === 'equals')
        || descendants(outer, 'binary_expression').some((b) => b.children.some((c) => c?.type === '=='));
      report({
        rule: 'nested-loops',
        severity: depth >= 3 ? 'high' : 'medium',
        title: withStreams ? 'Вложенный проход в потоке' : 'Вложенные циклы',
        message: withStreams
          ? `Циклы и стримы вложены на ${depth} уровня: для каждого элемента данные проходятся заново, время растёт как ${bigO(depth)}.`
          : `Цикл содержит ${depth} уровня вложенности: время растёт как ${bigO(depth)} от размера входа.`,
        recommendation: hasEquals
          ? 'Внутренний проход ищет совпадение — постройте индекс (HashMap/HashSet или Collectors.toMap/groupingBy) за один проход и ищите за O(1).'
          : 'Проверьте, нельзя ли вынести внутренний проход наружу или заменить его предвычисленной структурой.',
        methodId: info.id,
        range: rangeOf(outer, file),
        complexity: bigO(depth),
        improvedComplexity: hasEquals ? bigO(depth - 1) : undefined,
      });
    }

    // --- Идиомы Stream API ---
    for (const pipeRoot of units.filter((u) => u.type === 'method_invocation')) {
      const p = pipelineOf(pipeRoot);
      const names = p.stages.map((st) => st.name);
      const argsText = (i: number) => p.stages[i].args?.text.slice(1, -1).trim() ?? '';

      const sortedAt = names.indexOf('sorted');
      const firstAt = names.findIndex((x, i) => i > sortedAt && (x === 'findFirst' || (x === 'limit' && argsText(i) === '1')));
      const between = names.slice(sortedAt + 1, firstAt);
      if (sortedAt !== -1 && firstAt !== -1 && between.every((x) => ['map', 'mapToObj', 'peek'].includes(x))) {
        const cmp = argsText(sortedAt);
        report({
          rule: 'stream-sort-for-min',
          severity: 'medium',
          title: 'Сортировка ради одного элемента',
          message: 'sorted() упорядочивает весь поток за O(n log n), хотя нужен только первый элемент.',
          recommendation: `Замените sorted(${cmp})…findFirst() на min(${cmp || 'Comparator.naturalOrder()'}): один проход за O(n), результат тот же.`,
          methodId: info.id,
          range: rangeOf(pipeRoot, file),
          complexity: 'O(n log n)',
          improvedComplexity: 'O(n)',
        });
      }

      const n = names.length;
      const last = names[n - 1];
      const parent = pipeRoot.parent;
      if (last === 'count' && parent?.type === 'binary_expression') {
        const op = parent.children[1]?.text;
        const other = parent.children[2]?.text;
        const exists = (op === '>' && other === '0') || (op === '!=' && other === '0') || (op === '>=' && other === '1');
        const none = op === '==' && other === '0';
        if (exists || none) {
          report({
            rule: 'stream-count-for-exists',
            severity: 'low',
            title: 'count() для проверки наличия',
            message: 'count() проходит весь поток, хотя ответ известен на первом подходящем элементе.',
            recommendation: `Используйте ${exists ? 'anyMatch' : 'noneMatch'}(…) вместо count() ${op} ${other}: он останавливается на первом совпадении.`,
            methodId: info.id,
            range: rangeOf(parent, file),
          });
        }
      }

      if (n >= 3 && names[n - 3] === 'filter' && ['findFirst', 'findAny'].includes(names[n - 2]) && ['isPresent', 'isEmpty'].includes(last)) {
        report({
          rule: 'stream-find-is-present',
          severity: 'low',
          title: 'filter + find + isPresent',
          message: 'Цепочка создаёт Optional только для того, чтобы проверить наличие элемента.',
          recommendation: `Короче и яснее: ${last === 'isPresent' ? 'anyMatch' : 'noneMatch'}(предикат из filter).`,
          methodId: info.id,
          range: rangeOf(pipeRoot, file),
        });
      }

      if (last === 'forEach') {
        const lambda = p.stages[n - 1].args?.namedChildren.find((a) => a?.type === 'lambda_expression');
        const body = lambda?.childForFieldName('body');
        const call = body?.type === 'method_invocation' ? body : null;
        if (call && call.childForFieldName('name')?.text === 'add') {
          report({
            rule: 'stream-foreach-add',
            severity: 'low',
            title: 'Сбор результата через forEach',
            message: `forEach наполняет внешнюю коллекцию ${call.childForFieldName('object')?.text ?? ''} побочным эффектом.`,
            recommendation: 'Соберите результат через collect(Collectors.toList()): поток без побочных эффектов проще проверить и распараллелить.',
            methodId: info.id,
            range: rangeOf(pipeRoot, file),
          });
        }
      }
    }

    // --- Линейный поиск по списку внутри цикла ---
    let power = maxDepth;
    for (const inv of descendants(root, 'method_invocation')) {
      const name = inv.childForFieldName('name')?.text;
      if (!name || !['contains', 'indexOf', 'lastIndexOf', 'remove'].includes(name)) continue;
      const obj = inv.childForFieldName('object')?.text;
      if (!obj || !isListType(types.get(obj)) || !isInsideLoop(inv, root)) continue;
      const depth = loopDepth(inv, root) + 1;
      power = Math.max(power, depth);
      report({
        rule: 'linear-search-in-loop',
        severity: 'medium',
        title: 'Линейный поиск в цикле',
        message: `${obj}.${name}(…) у списка работает за O(n) и вызывается в цикле — итого ${bigO(depth)}.`,
        recommendation: `Храните элементы в HashSet/HashMap, чтобы ${name} выполнялся за O(1).`,
        methodId: info.id,
        range: rangeOf(inv, file),
        complexity: bigO(depth),
        improvedComplexity: bigO(depth - 1),
      });
    }

    // --- Конкатенация строк в цикле ---
    for (const a of descendants(root, 'assignment_expression')) {
      const left = a.childForFieldName('left')?.text;
      const op = a.childForFieldName('operator')?.text ?? a.children[1]?.text;
      const right = a.childForFieldName('right');
      if (!left || !isStringType(types.get(left)) || !isInsideLoop(a, root)) continue;
      const concat = op === '+=' || (op === '=' && right?.type === 'binary_expression' && right.text.startsWith(left));
      if (!concat) continue;
      report({
        rule: 'string-concat-in-loop',
        severity: 'medium',
        title: 'Конкатенация строк в цикле',
        message: `Строка ${left} пересоздаётся на каждой итерации — копирование даёт квадратичное время.`,
        recommendation: 'Используйте StringBuilder и вызывайте toString() после цикла.',
        methodId: info.id,
        range: rangeOf(a, file),
        complexity: 'O(n²)',
        improvedComplexity: 'O(n)',
      });
    }

    // --- Пустой catch ---
    for (const c of descendants(root, 'catch_clause')) {
      const body = c.childForFieldName('body');
      const statements = body?.namedChildren.filter((x) => x && !x.type.endsWith('comment')) ?? [];
      if (statements.length) continue;
      report({
        rule: 'empty-catch',
        severity: 'medium',
        title: 'Проглоченное исключение',
        message: 'Блок catch пустой — ошибка теряется без следа.',
        recommendation: 'Залогируйте исключение в System.err, пробросьте дальше или обработайте явно.',
        methodId: info.id,
        range: rangeOf(c, file),
      });
    }

    // --- Метрики и длинные/сложные методы ---
    const cyclomatic =
      1 +
      descendants(root, BRANCH_TYPES).filter((n) => !(n.type === 'switch_label' && n.text.startsWith('default'))).length +
      descendants(root, 'binary_expression').filter((b) => b.children.some((c) => c?.type === '&&' || c?.type === '||')).length;
    const complexity = bigO(power);
    metrics.push({ methodId: info.id, lines: info.lines, cyclomatic, maxLoopDepth: maxDepth, complexity });

    if (isLambda) continue;
    if (info.lines > LONG_METHOD) {
      report({
        rule: 'long-method',
        severity: info.lines > VERY_LONG_METHOD ? 'high' : 'medium',
        title: 'Длинный метод',
        message: `Метод ${info.signature} содержит ${plural(info.lines, 'строку', 'строки', 'строк')}.`,
        recommendation: 'Выделите логически независимые части в отдельные методы.',
        methodId: info.id,
        range: info.range,
      });
    }
    if (cyclomatic > HIGH_CYCLOMATIC) {
      report({
        rule: 'high-cyclomatic',
        severity: 'medium',
        title: 'Высокая цикломатическая сложность',
        message: `Цикломатическая сложность ${cyclomatic} (порог ${HIGH_CYCLOMATIC}): метод трудно тестировать.`,
        recommendation: 'Разбейте ветвления на методы, замените цепочки if на switch/полиморфизм/таблицу.',
        methodId: info.id,
        range: info.range,
      });
    }
  }

  // --- Дублирование логики: одинаковые блоки из 3+ операторов ---
  const blocks = new Map<string, { node: Node; method: MethodNode }[]>();
  for (const m of methods.filter((x) => x.info.kind !== 'lambda')) {
    for (const b of descendants(m.node, 'block')) {
      const stmts = b.namedChildren.filter((x) => x && !x.type.endsWith('comment'));
      if (stmts.length < 3) continue;
      const key = normalized(b);
      blocks.set(key, [...(blocks.get(key) ?? []), { node: b, method: m }]);
    }
  }
  for (const group of blocks.values()) {
    if (group.length < 2) continue;
    const places = group.map((g) => `${g.method.info.className}.${g.method.info.name}:${g.node.startPosition.row + 1}`);
    for (const g of group) {
      reportDiagnostic({
        rule: 'duplicate-block',
        severity: 'low',
        title: 'Дублирование логики',
        message: `Одинаковый блок встречается ${group.length} раза: ${places.join(', ')}.`,
        recommendation: 'Вынесите общий фрагмент в отдельный метод.',
        methodId: g.method.info.id,
        range: rangeOf(g.node, g.method.info.range.file),
      });
    }
  }

  return { diagnostics, metrics };
}
