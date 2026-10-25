import type { Node } from 'web-tree-sitter';
import type { SourceFile } from '../../shared/types.ts';
import { descendants, parseJava } from './parser.ts';

/**
 * Счётчики-«инструментовка»: числовые поля, которые только увеличиваются (steps++, calls += 1)
 * и печатаются. Ускорение алгоритма меняет их значения — это ожидаемо, а не смена поведения.
 */
export interface CounterLine {
  /** Строка вывода, где счётчики — числа, остальные выражения — захваченные группы. */
  pattern: RegExp;
  counters: string[];
}

const NUMERIC = /^(int|long|short|byte|Integer|Long|AtomicInteger|AtomicLong)$/;

/** Поля, в которые только прибавляют (или обнуляют): их значение — сколько раз что-то выполнилось. */
function counterFields(root: Node): Set<string> {
  const candidates = new Set<string>();
  for (const f of descendants(root, 'field_declaration')) {
    if (!NUMERIC.test(f.childForFieldName('type')?.text ?? '')) continue;
    for (const d of f.namedChildren) if (d?.type === 'variable_declarator') candidates.add(d.childForFieldName('name')!.text);
  }
  const nameOf = (n: Node | null) => (n?.type === 'identifier' ? n.text : n?.type === 'field_access' ? n.childForFieldName('field')?.text : undefined);
  const counted = new Set<string>();
  for (const u of descendants(root, 'update_expression')) {
    const name = nameOf(u.namedChildren[0]);
    if (name && candidates.has(name)) counted.add(name);
  }
  for (const a of descendants(root, 'assignment_expression')) {
    const name = nameOf(a.childForFieldName('left'));
    if (!name || !candidates.has(name)) continue;
    const op = a.childForFieldName('operator')?.text ?? a.children.find((c) => c?.type.endsWith('='))?.type;
    const right = a.childForFieldName('right')?.text;
    if (op === '+=' || op === '-=') counted.add(name);
    // Обнуление между прогонами не делает поле значимым; любое другое присваивание — делает.
    else if (right !== '0' && right !== '0L') candidates.delete(name);
  }
  return new Set([...counted].filter((n) => candidates.has(n)));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Текст строкового литерала как регулярное выражение; null — не литерал или экранирование не разобрать. */
function literal(n: Node): string | null {
  if (n.type !== 'string_literal' || n.text.startsWith('"""')) return null;
  try {
    return escape(JSON.parse(n.text));
  } catch {
    return null;
  }
}

/** Операнды цепочки a + b + c. */
function concatParts(n: Node): Node[] {
  if (n.type === 'binary_expression' && n.children.some((c) => c?.type === '+')) {
    return [...concatParts(n.childForFieldName('left')!), ...concatParts(n.childForFieldName('right')!)];
  }
  if (n.type === 'parenthesized_expression' && n.namedChildren[0]) return concatParts(n.namedChildren[0]);
  return [n];
}

/** Шаблоны строк вывода println/print, в которых печатаются счётчики. */
export function counterLines(files: SourceFile[]): CounterLine[] {
  const out: CounterLine[] = [];
  for (const f of files.filter((x) => x.path.endsWith('.java'))) {
    const tree = parseJava(f.content);
    try {
      const counters = counterFields(tree.rootNode);
      if (!counters.size) continue;
      for (const call of descendants(tree.rootNode, 'method_invocation')) {
        if (!/^print(ln)?$/.test(call.childForFieldName('name')?.text ?? '')) continue;
        const arg = call.childForFieldName('arguments')?.namedChildren[0];
        if (!arg) continue;
        const parts = concatParts(arg);
        const used = parts.map((p) => (p.type === 'identifier' && counters.has(p.text) ? p.text : null));
        if (!used.some(Boolean)) continue;
        // Литерал — как есть, счётчик — любое целое, прочее — группа, которая должна совпасть дословно.
        const source = parts.map((p, i) => (used[i] ? '-?\\d+' : literal(p) ?? '(.*?)')).join('');
        out.push({ pattern: new RegExp(`^${source}$`), counters: used.filter((x): x is string => !!x) });
      }
    } finally {
      tree.delete();
    }
  }
  return out;
}

/** Строки различаются только значениями счётчиков: какими именно — или null, если различие по существу. */
export function onlyCounters(expected: string, actual: string, lines: CounterLine[]): string[] | null {
  for (const l of lines) {
    const a = expected.match(l.pattern), b = actual.match(l.pattern);
    if (a && b && a.slice(1).every((g, i) => g === b[i + 1])) return l.counters;
  }
  return null;
}
