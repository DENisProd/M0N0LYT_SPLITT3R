import type { SourceFile } from './types.ts';

// Построчный diff (Myers) и выборочное применение фрагментов: основа ревью исправлений и версий.

export interface Hunk {
  /** Ключ решения «принять/отклонить»: путь + номер фрагмента. */
  key: string;
  /** Заменяемые строки базы: [baseStart, baseEnd), 0-based. */
  baseStart: number;
  baseEnd: number;
  /** Номер первой строки фрагмента в новой версии, 0-based. */
  nextStart: number;
  removed: string[];
  added: string[];
}

export interface FileDiff {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  base: string[];
  hunks: Hunk[];
}

const splitLines = (s: string) => (s === '' ? [] : s.split('\n'));

/** Пары совпадающих строк (i в a, j в b) по возрастанию — кратчайший сценарий правок Myers. */
function commonLines(a: string[], b: string[]): [number, number][] {
  // Общие начало и конец отрезаем сразу: правки обычно точечные, а Myers квадратичен по числу различий.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) x++, y++;
      v[off + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  const pairs: [number, number][] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const t = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && t[off + k - 1] < t[off + k + 1]) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : t[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) pairs.push([pre + --x, pre + --y]);
    if (d > 0) x = prevX, y = prevY;
  }
  pairs.reverse();
  const head = Array.from({ length: pre }, (_, i) => [i, i] as [number, number]);
  const tail = Array.from({ length: suf }, (_, i) => [a.length - suf + i, b.length - suf + i] as [number, number]);
  return [...head, ...pairs, ...tail];
}

export function diffText(path: string, before: string, after: string): Hunk[] {
  const a = splitLines(before), b = splitLines(after);
  const hunks: Hunk[] = [];
  let i = 0, j = 0;
  for (const [ci, cj] of [...commonLines(a, b), [a.length, b.length] as [number, number]]) {
    if (ci > i || cj > j) hunks.push({ key: `${path}#${hunks.length}`, baseStart: i, baseEnd: ci, nextStart: j, removed: a.slice(i, ci), added: b.slice(j, cj) });
    i = ci + 1;
    j = cj + 1;
  }
  return hunks;
}

export function diffFiles(base: SourceFile[], next: SourceFile[]): FileDiff[] {
  const before = new Map(base.map((f) => [f.path, f.content]));
  const after = new Map(next.map((f) => [f.path, f.content]));
  const out: FileDiff[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(path), b = after.get(path);
    if (a === b) continue;
    const hunks = diffText(path, a ?? '', b ?? '');
    if (!hunks.length) continue;
    out.push({ path, status: a === undefined ? 'added' : b === undefined ? 'deleted' : 'modified', base: splitLines(a ?? ''), hunks });
  }
  return out;
}

/** База с применёнными фрагментами: остальные остаются как в базе. */
export function applyHunks(base: SourceFile[], next: SourceFile[], diffs: FileDiff[], take: (h: Hunk) => boolean): SourceFile[] {
  const byPath = new Map(diffs.map((d) => [d.path, d]));
  const result = new Map(base.map((f) => [f.path, f.content]));
  for (const d of byPath.values()) {
    const taken = d.hunks.filter(take);
    if (d.status === 'added') {
      if (taken.length) result.set(d.path, next.find((f) => f.path === d.path)!.content);
      continue;
    }
    if (d.status === 'deleted' && taken.length === d.hunks.length) {
      result.delete(d.path);
      continue;
    }
    const lines: string[] = [];
    let at = 0;
    for (const h of taken) {
      lines.push(...d.base.slice(at, h.baseStart), ...h.added);
      at = h.baseEnd;
    }
    lines.push(...d.base.slice(at));
    result.set(d.path, lines.join('\n'));
  }
  // Порядок файлов — как в новой версии, новые файлы в конце.
  const order = [...next.map((f) => f.path), ...base.map((f) => f.path)];
  return [...new Set(order)].filter((p) => result.has(p)).map((path) => ({ path, content: result.get(path)! }));
}

/** Число изменённых файлов между версиями — без построчного diff. */
export function changedFiles(base: SourceFile[], next: SourceFile[]): number {
  const before = new Map(base.map((f) => [f.path, f.content]));
  const paths = new Set(next.map((f) => f.path));
  return next.filter((f) => before.get(f.path) !== f.content).length + base.filter((f) => !paths.has(f.path)).length;
}
