import type { Node } from 'web-tree-sitter';
import type { StreamStage } from '../../shared/types.ts';
import { descendants, shortLabel } from './parser.ts';

/** Вызовы, которые порождают поток: list.stream(), Arrays.stream(a), IntStream.range(0, n)… */
const SOURCE_METHODS = new Set(['stream', 'parallelStream']);
const STATIC_SOURCES = new Set(['Stream', 'IntStream', 'LongStream', 'DoubleStream', 'Arrays']);
const STATIC_SOURCE_METHODS = new Set(['of', 'range', 'rangeClosed', 'stream', 'iterate', 'generate']);

/**
 * Методы, лямбда-аргумент которых вызывается для каждого элемента.
 * Для оценки сложности такая лямбда — тело цикла.
 */
const ITERATING_METHODS = new Set([
  // Stream API
  'filter', 'map', 'flatMap', 'mapToInt', 'mapToLong', 'mapToDouble', 'mapToObj', 'peek',
  'forEach', 'forEachOrdered', 'anyMatch', 'allMatch', 'noneMatch', 'reduce', 'takeWhile', 'dropWhile',
  'sorted', 'max', 'min', 'collect',
  // Collectors
  'groupingBy', 'partitioningBy', 'toMap', 'mapping', 'filtering', 'flatMapping', 'reducing',
  'summingInt', 'summingLong', 'summingDouble', 'averagingInt', 'averagingLong', 'averagingDouble',
  // Iterable / Collection / Map
  'removeIf', 'replaceAll', 'sort',
]);

const objectOf = (inv: Node) => inv.childForFieldName('object');
const nameOf = (inv: Node) => inv.childForFieldName('name')?.text ?? '';

function isSource(inv: Node): boolean {
  const name = nameOf(inv);
  if (SOURCE_METHODS.has(name)) return true;
  const obj = objectOf(inv);
  return !!obj && obj.type === 'identifier' && STATIC_SOURCES.has(obj.text) && STATIC_SOURCE_METHODS.has(name);
}

/** Цепочка a.b().c().d() от первого вызова к последнему. */
function chain(root: Node): Node[] {
  const calls: Node[] = [];
  for (let cur: Node | null = root; cur?.type === 'method_invocation'; cur = objectOf(cur)) calls.unshift(cur);
  return calls;
}

/** Корень конвейера — самый внешний вызов цепочки, в которой есть источник потока. */
export function isPipelineRoot(n: Node): boolean {
  if (n.type !== 'method_invocation') return false;
  const p = n.parent;
  if (p?.type === 'method_invocation' && objectOf(p)?.id === n.id) return false;
  const calls = chain(n);
  const src = calls.findIndex(isSource);
  return src !== -1 && src < calls.length - 1; // источник без операций — ещё не конвейер
}

export interface Pipeline {
  root: Node;
  source: string;
  stages: { name: string; node: Node; args: Node | null }[];
}

export function pipelineOf(root: Node): Pipeline {
  const calls = chain(root);
  const src = calls.findIndex(isSource);
  return {
    root,
    source: calls[src].text,
    stages: calls.slice(src + 1).map((c) => ({ name: nameOf(c), node: c, args: c.childForFieldName('arguments') })),
  };
}

/** Ближайшая лямбда-предок (или null, если узел не внутри лямбды). */
export function enclosingLambda(n: Node, stopAt?: Node): Node | null {
  for (let p = n.parent; p && p.id !== stopAt?.id; p = p.parent) if (p.type === 'lambda_expression') return p;
  return null;
}

/** Конвейеры внутри узла, кроме вложенных в лямбды (у тех своя блок-схема). */
export function pipelinesIn(n: Node): Pipeline[] {
  const own = enclosingLambda(n);
  return descendants(n, 'method_invocation')
    .filter((m) => isPipelineRoot(m) && enclosingLambda(m)?.id === own?.id)
    .map(pipelineOf);
}

/** Методы, которые есть и у Optional: там лямбда вызывается не больше одного раза. */
const OPTIONAL_METHODS = new Set(['map', 'flatMap', 'filter']);
/** Промежуточные стадии потока: через них цепочка остаётся потоком. */
const STREAM_STAGES = new Set(['filter', 'map', 'flatMap', 'mapToObj', 'mapToInt', 'mapToLong', 'mapToDouble', 'boxed', 'sorted', 'distinct', 'peek', 'limit', 'skip', 'takeWhile', 'dropWhile', 'parallel', 'sequential', 'unordered']);

/** repo.findById(id).map(…) — Optional: у коллекций нет map/filter, значит до потока цепочка не дошла. */
function isOptionalChain(call: Node): boolean {
  for (let obj = objectOf(call); obj; ) {
    if (obj.type !== 'method_invocation') return false; // переменная или поле: тип неизвестен, считаем потоком
    if (isSource(obj)) return false;
    const name = nameOf(obj);
    if (objectOf(obj)?.text === 'Optional' || !STREAM_STAGES.has(name)) return true;
    obj = objectOf(obj);
  }
  return false;
}

/** Лямбда передана методу, который вызывает её для каждого элемента. */
export function isIteratingLambda(lambda: Node): boolean {
  const args = lambda.parent;
  const call = args?.type === 'argument_list' ? args.parent : null;
  if (call?.type !== 'method_invocation' || !ITERATING_METHODS.has(nameOf(call))) return false;
  return !(OPTIONAL_METHODS.has(nameOf(call)) && isOptionalChain(call));
}

/** Стабильный id лямбды: метод + позиция в исходнике. */
export function lambdaId(rootMethodId: string, lambda: Node): string {
  return `${rootMethodId}/λ${lambda.startPosition.row + 1}:${lambda.startPosition.column + 1}`;
}

export function stagesOf(p: Pipeline, rootMethodId: string): StreamStage[] {
  return p.stages.map((s) => {
    const lambda = s.args?.namedChildren.find((a) => a?.type === 'lambda_expression') ?? null;
    const inner = s.args ? s.args.text.slice(1, -1) : '';
    return { name: s.name, args: shortLabel(inner, 60), lambdaId: lambda ? lambdaId(rootMethodId, lambda) : undefined };
  });
}
