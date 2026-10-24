import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompareCase, CompareResult, CompileResult, RunResult, SourceFile, TestCase, UnitCase } from '../../shared/types.ts';
import { librariesFor, resolveLibraries, usesJavaFx } from './libs.ts';
import { nondeterministicIn } from './scope.ts';
import { compareUnits } from './units.ts';

const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 10_000);
const COMPILE_TIMEOUT_MS = 60_000;
// Первая сборка Maven-проекта скачивает зависимости — это дольше javac.
const MAVEN_TIMEOUT_MS = Number(process.env.MAVEN_TIMEOUT_MS ?? 600_000);
export const MAVEN_CMD = process.env.MAVEN_CMD ?? (process.platform === 'win32' ? 'mvn.cmd' : 'mvn');
const MAX_OUTPUT = 1_000_000;

export function javaBin(tool: 'java' | 'javac'): string {
  const home = process.env.JAVA_HOME;
  if (home) {
    const exe = path.join(home, 'bin', process.platform === 'win32' ? `${tool}.exe` : tool);
    if (existsSync(exe)) return exe;
  }
  return tool; // из PATH
}

export function exec(cmd: string, args: string[], opts: { cwd: string; stdin?: string; timeoutMs: number; shell?: boolean }): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // .cmd (mvn.cmd) Node запускает только через shell; аргументы — наши константы, не ввод пользователя.
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, shell: opts.shell });
    const timer = setTimeout(() => {
      timedOut = true;
      // Через shell kill() завершил бы только cmd.exe, а Maven и JVM остались бы висеть.
      if (opts.shell && process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), exitCode: null, timedOut, durationMs: performance.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut, durationMs: performance.now() - started });
    });
    child.stdin.on('error', () => {}); // программа могла не читать stdin
    child.stdin.end(opts.stdin ?? '', 'utf8');
  });
}

export async function checkJava(): Promise<{ ok: boolean; version: string }> {
  const r = await exec(javaBin('javac'), ['-version'], { cwd: tmpdir(), timeoutMs: 10_000 });
  const version = (r.stdout + r.stderr).trim();
  return { ok: r.exitCode === 0, version };
}

let javacMajor: Promise<number> | null = null;
/** Мажорная версия javac: "javac 23" → 23, "javac 17.0.2" → 17. */
export function javaMajor(): Promise<number> {
  javacMajor ??= checkJava().then((j) => Number(j.version.match(/javac\s+(\d+)/)?.[1] ?? 0));
  return javacMajor;
}

export const isJava = (f: SourceFile) => f.path.endsWith('.java');
const MAIN_RE = /static\s+void\s+main\s*\(/;

/** Файл main-класса по его имени (с пакетом или без). */
function mainFile(files: SourceFile[], mainClass: string): SourceFile | undefined {
  const simple = mainClass.split('.').pop();
  return files.find((f) => isJava(f) && path.basename(f.path, '.java') === simple && MAIN_RE.test(f.content));
}

/**
 * Spring Boot-сервис стартует веб-сервер и ждёт БД, брокер и конфигурацию —
 * сравнение по stdin к нему неприменимо, поэтому для него проверяется только компиляция.
 */
function runSkipReason(files: SourceFile[], mainClass: string | null): string | undefined {
  const main = mainClass ? mainFile(files, mainClass) : undefined;
  if (main && /\bextends\s+Application\b/.test(main.content) && usesJavaFx(files)) {
    return `${path.basename(main.path, '.java')} — приложение JavaFX: оно открывает окно, а сравнение по stdin к нему неприменимо`;
  }
  if (!main || !/@SpringBootApplication\b/.test(main.content)) return undefined;
  return `${path.basename(main.path, '.java')} — Spring Boot-сервис: для запуска ему нужны БД, брокер сообщений и конфигурация, а сравнение по stdin к нему неприменимо`;
}

/** Класс с main: по `public static void main`, предпочитая заданный. */
export function findMainClass(files: SourceFile[], preferred?: string): string | null {
  if (preferred) return preferred;
  for (const f of files.filter(isJava)) {
    if (!/static\s+void\s+main\s*\(/.test(f.content)) continue;
    const pkg = f.content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
    const cls = path.basename(f.path, '.java');
    return pkg ? `${pkg}.${cls}` : cls;
  }
  return null;
}

export class Workspace {
  /** Корневой pom.xml: сборка через Maven, который сам скачивает зависимости. */
  readonly maven: boolean;
  /** Модуль Maven с main-классом: "finder" или "" для одномодульного проекта. */
  private readonly mainModule: string;
  private classpath = '';
  /** Библиотеки проекта без pom.xml, скачанные Maven по импортам. */
  private libs = '';

  private constructor(readonly dir: string, readonly mainClass: string | null, files: SourceFile[]) {
    this.maven = files.some((f) => f.path === 'pom.xml');
    const main = mainClass ? mainFile(files, mainClass) : undefined;
    const i = main?.path.search(/(^|\/)src\//) ?? -1;
    this.mainModule = main && i > 0 ? main.path.slice(0, i) : '';
  }

  static async create(files: SourceFile[], mainClass?: string): Promise<Workspace> {
    const dir = await mkdtemp(path.join(tmpdir(), 'jbp-'));
    const src = path.join(dir, 'src');
    for (const f of files) {
      const target = path.join(src, path.normalize(f.path).replace(/^(\.\.[/\\])+/, ''));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.content, 'utf8');
    }
    return new Workspace(dir, findMainClass(files, mainClass), files);
  }

  /** Убирает путь временного каталога из сообщений компилятора. */
  private relative(text: string): string {
    const src = path.join(this.dir, 'src') + path.sep;
    const slashed = src.replace(/\\/g, '/');
    return [src, slashed, `/${slashed}`].reduce((t, v) => t.split(v).join(''), text);
  }

  async compile(files: SourceFile[]): Promise<CompileResult> {
    if (this.maven) return this.compileMaven();
    const sources = files.filter(isJava).map((f) => path.join('src', path.normalize(f.path)));
    const { artifacts, unknown } = librariesFor(files.filter(isJava));
    let durationMs = 0;
    const args = ['-encoding', 'UTF-8', '-d', 'out'];
    if (artifacts.length) {
      const started = performance.now();
      const libs = await resolveLibraries(artifacts, exec, MAVEN_CMD, MAVEN_TIMEOUT_MS);
      durationMs += performance.now() - started;
      if (libs.error) return { ok: false, errors: libs.error, durationMs };
      this.libs = libs.classpath;
      args.push('-cp', this.libs);
      // Lombok — annotation processor: с JDK 23 javac без -proc:full его не запускает.
      if (artifacts.some((a) => a.startsWith('org.projectlombok:')) && (await javaMajor()) >= 21) args.push('-proc:full');
    }
    const r = await exec(javaBin('javac'), [...args, ...sources], { cwd: this.dir, timeoutMs: COMPILE_TIMEOUT_MS });
    let errors = r.stderr + r.stdout;
    if (r.exitCode !== 0 && unknown.length && /package [\w.]+ does not exist/.test(errors)) {
      errors += `\nПроект без pom.xml, и эти библиотеки не удалось узнать по импортам: ${unknown.join(', ')}. Добавьте pom.xml с зависимостями — тогда их скачает Maven.`;
    }
    return { ok: r.exitCode === 0, errors, durationMs: durationMs + r.durationMs };
  }

  /**
   * Сборка реактором Maven: зависимости из pom.xml скачиваются в ~/.m2, модули собираются по порядку.
   * В том же запуске — classpath каждого модуля (cp.txt), чтобы потом запустить main без Maven.
   */
  private async compileMaven(): Promise<CompileResult> {
    const args = ['-q', '-B', '-DskipTests', 'compile', 'dependency:build-classpath', '-Dmdep.outputFile=cp.txt', '-Dmdep.includeScope=runtime'];
    // С JDK 23 javac не запускает annotation processors из classpath без явного -proc:full,
    // и Lombok молча не генерирует геттеры и логгеры. -proc:full javac понимает с версии 21.
    if ((await javaMajor()) >= 21) args.push('-Dmaven.compiler.proc=full');
    const root = path.join(this.dir, 'src');
    const r = await exec(MAVEN_CMD, args, { cwd: root, timeoutMs: MAVEN_TIMEOUT_MS, shell: true });
    if (r.exitCode === 0) {
      const cp = await readFile(path.join(root, this.mainModule, 'cp.txt'), 'utf8').catch((e) => {
        console.warn(`classpath модуля "${this.mainModule}" не прочитан: ${e}`);
        return '';
      });
      this.classpath = [path.join(root, this.mainModule, 'target', 'classes'), cp.trim()].filter(Boolean).join(path.delimiter);
    }
    let errors = this.relative(r.stdout + r.stderr);
    if (r.timedOut) errors += `\nСборка Maven не уложилась в ${MAVEN_TIMEOUT_MS / 1000} с (MAVEN_TIMEOUT_MS).`;
    else if (r.exitCode !== 0 && /not recognized|not found|не является/i.test(r.stderr)) errors += '\nMaven не найден: установите его или укажите команду в MAVEN_CMD.';
    return { ok: r.exitCode === 0, errors, durationMs: r.durationMs };
  }

  /** Classpath скомпилированного кода модуля, в котором лежит файл. */
  async classpathFor(file: string): Promise<string> {
    if (!this.maven) return [path.join(this.dir, 'out'), this.libs].filter(Boolean).join(path.delimiter);
    const root = path.join(this.dir, 'src');
    const i = file.search(/(^|\/)src\//);
    const module = i > 0 ? file.slice(0, i) : '';
    const cp = await readFile(path.join(root, module, 'cp.txt'), 'utf8').catch((e) => {
      console.warn(`classpath модуля "${module}" не прочитан: ${e}`);
      return '';
    });
    return [path.join(root, module, 'target', 'classes'), cp.trim()].filter(Boolean).join(path.delimiter);
  }

  run(stdin: string): Promise<RunResult> {
    if (!this.mainClass) {
      return Promise.resolve({ stdout: '', stderr: 'Не найден класс с main()', exitCode: null, timedOut: false, durationMs: 0 });
    }
    return exec(
      javaBin('java'),
      ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Xmx256m', '-cp', this.maven ? this.classpath : ['out', this.libs].filter(Boolean).join(path.delimiter), this.mainClass],
      { cwd: this.dir, stdin, timeoutMs: RUN_TIMEOUT_MS },
    );
  }

  dispose(): Promise<void> {
    return rm(this.dir, { recursive: true, force: true });
  }
}

export async function compileAndRun(files: SourceFile[], stdin: string, mainClass?: string) {
  const ws = await Workspace.create(files, mainClass);
  try {
    const compile = await ws.compile(files);
    const skipped = runSkipReason(files, ws.mainClass);
    const run = compile.ok && !skipped ? await ws.run(stdin) : null;
    return { compile, run, mainClass: ws.mainClass, skipped };
  } finally {
    await ws.dispose();
  }
}

/** Нормализация, чтобы не ловить ложные расхождения из-за \r\n. */
const norm = (s: string) => s.replace(/\r\n/g, '\n');

function diff(a: RunResult, b: RunResult): string[] {
  const out: string[] = [];
  if (norm(a.stdout) !== norm(b.stdout)) out.push('stdout');
  if (norm(a.stderr) !== norm(b.stderr)) out.push('stderr');
  if (a.exitCode !== b.exitCode) out.push('exitCode');
  if (a.timedOut || b.timedOut) out.push('timeout');
  return out;
}

/**
 * Дифференциальная проверка: обе версии запускаются на одинаковом stdin,
 * stdout, stderr и код выхода должны совпасть побайтно.
 *
 * Если в коде есть источники недетерминизма (время, потоки, случайность, сеть —
 * всё это вне рамок кейса), эталон запускается дважды: когда он расходится сам
 * с собой, тест помечается как недетерминированный, а не как нарушение поведения.
 */
export async function compareBehavior(
  original: SourceFile[],
  modified: SourceFile[],
  tests: TestCase[],
  mainClass?: string,
  unitCases: UnitCase[] = [],
): Promise<CompareResult> {
  const [a, b] = await Promise.all([Workspace.create(original, mainClass), Workspace.create(modified, mainClass)]);
  try {
    // Два реактора Maven параллельно писали бы в один ~/.m2 — собираем по очереди.
    const [originalCompile, modifiedCompile] = a.maven || b.maven
      ? [await a.compile(original), await b.compile(modified)]
      : await Promise.all([a.compile(original), b.compile(modified)]);
    const runSkipped = runSkipReason(original, a.mainClass) ?? runSkipReason(modified, b.mainClass);
    const nondeterministic = [...new Set([...nondeterministicIn(original.filter(isJava)), ...nondeterministicIn(modified.filter(isJava))])];
    const cases: CompareCase[] = [];
    if (originalCompile.ok && modifiedCompile.ok && !runSkipped) {
      for (const t of tests) {
        const [ro, rm, again] = await Promise.all([
          a.run(t.stdin),
          b.run(t.stdin),
          nondeterministic.length ? a.run(t.stdin) : Promise.resolve(null),
        ]);
        const mismatches = diff(ro, rm);
        const flaky = !!again && diff(ro, again).some((m) => m !== 'timeout');
        cases.push({ name: t.name, passed: !flaky && mismatches.length === 0, original: ro, modified: rm, mismatches, flaky });
      }
    }
    // Тест-кейсы классов не требуют запуска приложения — работают и для Spring Boot-сервисов.
    const units = originalCompile.ok && modifiedCompile.ok && unitCases.length
      ? await compareUnits({ ws: a, files: original }, { ws: b, files: modified }, unitCases, nondeterministic.length > 0)
      : [];
    return {
      originalCompile,
      modifiedCompile,
      cases,
      units,
      passed: cases.filter((c) => c.passed).length + units.filter((u) => u.passed).length,
      total: (runSkipped ? 0 : tests.length) + units.length,
      nondeterministic,
      flaky: cases.filter((c) => c.flaky).length + units.filter((u) => u.flaky).length,
      runSkipped,
    };
  } finally {
    await Promise.all([a.dispose(), b.dispose()]);
  }
}
