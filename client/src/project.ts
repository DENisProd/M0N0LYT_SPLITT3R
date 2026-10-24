import type { SourceFile } from '../../shared/types.ts';

/** Служебные каталоги сборки и IDE: в них сгенерированные копии исходников, а не код проекта. */
const BUILD_DIRS = new Set(['target', 'build', 'out', 'bin']);

/** Почему файл папки проекта не попадает в импорт, или null. */
function skipReason(path: string): 'build' | 'test' | null {
  const dirs = path.split('/').slice(0, -1);
  // Внутри дерева пакетов (…/java/com/…) каталог `build` может быть обычным пакетом.
  const packageRoot = dirs.indexOf('java');
  const outer = packageRoot < 0 ? dirs : dirs.slice(0, packageRoot);
  if (dirs.some((d) => d.startsWith('.') || d === 'node_modules') || outer.some((d) => BUILD_DIRS.has(d))) return 'build';
  // Тесты Maven/Gradle зависят от JUnit, которого нет в classpath песочницы.
  if (/(^|\/)src\/test\//.test(path)) return 'test';
  return null;
}

/** Общий каталог всех файлов (`app/src/main/java/`), чтобы показывать пути от корня пакетов. */
function commonDir(paths: string[]): string {
  const split = paths.map((p) => p.split('/').slice(0, -1));
  const first = split[0] ?? [];
  // Не глубже корня пакетов: путь `com/shop/App.java` должен остаться целым.
  const limit = first.includes('java') ? first.indexOf('java') + 1 : first.length;
  let n = 0;
  while (n < limit && split.every((s) => s[n] === first[n])) n++;
  return n ? `${first.slice(0, n).join('/')}/` : '';
}

export interface ProjectImport {
  files: SourceFile[];
  /** Имя выбранной папки или первого файла. */
  name: string;
  skipped: { build: number; test: number };
}

/** pom.xml нужен сборке: по нему Maven скачивает зависимости проекта. */
const isSource = (name: string) => name.endsWith('.java') || name === 'pom.xml';

/** Отпечаток проекта по списку путей: правки содержимого его не меняют, другой проект — меняет. */
export async function projectKey(files: SourceFile[]): Promise<string> {
  const data = new TextEncoder().encode(files.map((f) => f.path).sort().join('\n'));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Читает .java и pom.xml из выбора файлов или папки (`webkitdirectory`), сохраняя пути пакетов. */
export async function readJavaFiles(list: FileList): Promise<ProjectImport> {
  const skipped = { build: 0, test: 0 };
  const picked: { path: string; file: File }[] = [];
  for (const file of list) {
    if (!isSource(file.name)) continue;
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    const reason = skipReason(path);
    if (reason) skipped[reason]++;
    else picked.push({ path, file });
  }
  const root = commonDir(picked.map((p) => p.path));
  const files = await Promise.all(picked.map(async (p) => ({ path: p.path.slice(root.length), content: await p.file.text() })));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const name = picked[0]?.path.includes('/') && list[0]?.webkitRelativePath ? picked[0].path.split('/')[0] : (picked[0]?.file.name.replace(/\.java$/, '') ?? 'Проект');
  return { files, name, skipped };
}
