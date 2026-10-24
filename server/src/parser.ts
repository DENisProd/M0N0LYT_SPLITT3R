import { createRequire } from 'node:module';
import { Parser, Language, type Node, type Tree } from 'web-tree-sitter';
import type { Range } from '../../shared/types.ts';

const require = createRequire(import.meta.url);

let parser: Parser | null = null;

export async function initParser(): Promise<void> {
  if (parser) return;
  await Parser.init();
  const java = await Language.load(require.resolve('tree-sitter-java/tree-sitter-java.wasm'));
  parser = new Parser();
  parser.setLanguage(java);
}

export function parseJava(source: string): Tree {
  if (!parser) throw new Error('Parser is not initialized, call initParser() first');
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse source');
  return tree;
}

export function rangeOf(node: Node, file: string): Range {
  return {
    file,
    start: node.startIndex,
    end: node.endIndex,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

/** Все потомки заданного типа (обход в глубину). */
export function descendants(node: Node, type: string | string[]): Node[] {
  const types = Array.isArray(type) ? type : [type];
  return node.descendantsOfType(types).filter((n): n is Node => n !== null);
}

export function collectErrors(root: Node): { line: number; message: string }[] {
  const errors: { line: number; message: string }[] = [];
  const walk = (n: Node) => {
    if (n.isError || n.isMissing) {
      errors.push({
        line: n.startPosition.row + 1,
        message: n.isMissing ? `Пропущено: ${n.type}` : `Синтаксическая ошибка рядом с "${n.text.slice(0, 40)}"`,
      });
      return;
    }
    if (n.hasError) for (const c of n.children) if (c) walk(c);
  };
  walk(root);
  return errors;
}

/** Схлопывает пробелы и обрезает длинный текст для подписи узла. */
export function shortLabel(text: string, max = 80): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
