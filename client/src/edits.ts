import type { Range, SourceFile } from '../../shared/types.ts';

// Правки из графа — это точечные замены текста по диапазонам из AST.
// После каждой правки код заново анализируется, и граф перестраивается.

function updateFile(files: SourceFile[], path: string, fn: (content: string) => string): SourceFile[] {
  return files.map((f) => (f.path === path ? { ...f, content: fn(f.content) } : f));
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

function indentAt(text: string, offset: number): string {
  const start = lineStart(text, offset);
  return text.slice(start).match(/^[ \t]*/)![0];
}

export function replaceRange(files: SourceFile[], range: Range, newText: string): SourceFile[] {
  return updateFile(files, range.file, (c) => c.slice(0, range.start) + newText + c.slice(range.end));
}

/** Удаляет оператор; если строка становится пустой — удаляет и её. */
export function deleteRange(files: SourceFile[], range: Range): SourceFile[] {
  return updateFile(files, range.file, (c) => {
    let start = range.start;
    let end = range.end;
    const ls = lineStart(c, start);
    const le = c.indexOf('\n', end);
    if (/^\s*$/.test(c.slice(ls, start)) && /^\s*$/.test(c.slice(end, le === -1 ? c.length : le))) {
      start = ls;
      end = le === -1 ? c.length : le + 1;
    }
    return c.slice(0, start) + c.slice(end);
  });
}

/** Вставляет блок отдельной строкой после оператора, с тем же отступом. */
export function insertAfter(files: SourceFile[], range: Range, snippet: string): SourceFile[] {
  return updateFile(files, range.file, (c) => {
    const indent = indentAt(c, range.start);
    const text = snippet.split('\n').map((l) => indent + l).join('\n');
    return c.slice(0, range.end) + '\n' + text + c.slice(range.end);
  });
}

/** Вставляет блок первой строкой тела метода (после "{"). */
export function insertAtBodyStart(files: SourceFile[], bodyRange: Range, snippet: string): SourceFile[] {
  return updateFile(files, bodyRange.file, (c) => {
    const indent = indentAt(c, bodyRange.start) + '    ';
    const text = snippet.split('\n').map((l) => indent + l).join('\n');
    const at = bodyRange.start + 1;
    return c.slice(0, at) + '\n' + text + c.slice(at);
  });
}

export interface BlockTemplate {
  kind: string;
  title: string;
  snippet: string;
}

export const BLOCKS: BlockTemplate[] = [
  { kind: 'variable', title: 'Переменная', snippet: 'int value = 0;' },
  { kind: 'condition', title: 'Условие', snippet: 'if (value > 0) {\n}' },
  { kind: 'loop', title: 'Цикл', snippet: 'for (int i = 0; i < 10; i++) {\n}' },
  { kind: 'call', title: 'Вывод', snippet: 'System.out.println("…");' },
  { kind: 'operation', title: 'Операция', snippet: 'value++;' },
  { kind: 'try', title: 'try / catch', snippet: 'try {\n} catch (RuntimeException e) {\n    System.err.println(e.getMessage());\n}' },
  { kind: 'return', title: 'Возврат', snippet: 'return;' },
];
