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

/**
 * Исходник проекта как он есть на диске — для экспорта копии с изменениями.
 * Файлы не читаются заранее: File — лишь ссылка, содержимое берётся при экспорте.
 */
export interface ProjectSource {
  /** Все файлы папки, кроме служебных каталогов; путь от выбранной папки, с её именем. */
  entries: { path: string; file: File }[];
  /** Префикс, отрезанный от путей SourceFile: путь на диске = root + path. */
  root: string;
  /** Файлы в том виде, в каком их импортировали: неизменённые экспортируются исходными байтами. */
  imported: SourceFile[];
}

export interface ProjectImport {
  files: SourceFile[];
  /** Имя выбранной папки или первого файла. */
  name: string;
  skipped: { build: number; test: number };
  source: ProjectSource;
}

/** pom.xml нужен сборке: по нему Maven скачивает зависимости проекта. */
const isSource = (name: string) => name.endsWith('.java') || name === 'pom.xml';
/** Конфигурация Spring/JPA: из неё берутся адреса баз данных и других хранилищ. */
const isConfig = (name: string) => /^(application|bootstrap)[\w-]*\.(properties|ya?ml)$|^persistence\.xml$|^hibernate\.cfg\.xml$/.test(name);

/** Отпечаток проекта по списку путей: правки содержимого его не меняют, другой проект — меняет. */
export async function projectKey(files: SourceFile[]): Promise<string> {
  const data = new TextEncoder().encode(files.map((f) => f.path).sort().join('\n'));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Читает .java, pom.xml и конфигурацию хранилищ из выбора файлов или папки (`webkitdirectory`), сохраняя пути пакетов. */
export async function readJavaFiles(list: FileList): Promise<ProjectImport> {
  const skipped = { build: 0, test: 0 };
  const picked: { path: string; file: File }[] = [];
  const configs: { path: string; file: File }[] = [];
  const entries: { path: string; file: File }[] = [];
  for (const file of list) {
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    // В копию проекта идёт всё, кроме служебного: ресурсы, тесты, README — тоже.
    if (skipReason(path) !== 'build') entries.push({ path, file });
    if (isConfig(file.name) && !skipReason(path)) configs.push({ path, file });
    if (!isSource(file.name)) continue;
    const reason = skipReason(path);
    if (reason) skipped[reason]++;
    else picked.push({ path, file });
  }
  // Конфигурация входит в расчёт корня: в Gradle-проекте resources/ лежит рядом с java/, а не внутри.
  const all = [...picked, ...configs];
  const root = commonDir(all.map((p) => p.path));
  const files = await Promise.all(all.map(async (p) => ({ path: p.path.slice(root.length), content: await p.file.text() })));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const name = picked[0]?.path.includes('/') && list[0]?.webkitRelativePath ? picked[0].path.split('/')[0] : (picked[0]?.file.name.replace(/\.java$/, '') ?? 'Проект');
  return { files, name, skipped, source: { entries, root, imported: files } };
}
