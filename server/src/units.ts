import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceFile, UnitCase, UnitCaseResult, UnitOutcome } from '../../shared/types.ts';
import { parseJava } from './parser.ts';
import { exec, javaBin, javaMajor, MAVEN_CMD, type Workspace } from './runner.ts';

/*
 * Исполнение тест-кейсов класса. Для каждого пакета генерируется драйвер JbpCases:
 * аргументы и ответы заглушек — выражения Java из кейса, объект и заглушки создаёт
 * JbpRuntime (Mockito). Кейс, который не компилируется, выбывает с ошибкой, остальные идут дальше.
 */

const UNIT_TIMEOUT_MS = Number(process.env.UNIT_TIMEOUT_MS ?? 30_000);
const MOCKITO_VERSION = process.env.MOCKITO_VERSION ?? '5.17.0';
const RUNTIME_SOURCE = fileURLToPath(new URL('./harness/JbpRuntime.java', import.meta.url));

let mockitoCp: Promise<string> | null = null;

/** Classpath Mockito: Maven скачивает его один раз в ~/.m2, дальше — из кэша. */
function mockitoClasspath(): Promise<string> {
  mockitoCp ??= (async () => {
    const dir = path.join(tmpdir(), `jbp-mockito-${MOCKITO_VERSION}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'pom.xml'),
      `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>
<groupId>jbp</groupId><artifactId>harness</artifactId><version>1</version>
<dependencies><dependency><groupId>org.mockito</groupId><artifactId>mockito-core</artifactId><version>${MOCKITO_VERSION}</version></dependency></dependencies>
</project>`,
    );
    const r = await exec(MAVEN_CMD, ['-q', '-B', 'dependency:build-classpath', '-Dmdep.outputFile=cp.txt'], { cwd: dir, timeoutMs: 300_000, shell: true });
    if (r.exitCode !== 0) throw new Error(`Mockito не получен через Maven: ${(r.stdout + r.stderr).slice(0, 500)}`);
    return (await readFile(path.join(dir, 'cp.txt'), 'utf8')).trim();
  })();
  // Неудачу не кэшируем: после установки Maven или появления сети следующая попытка пройдёт.
  mockitoCp.catch(() => (mockitoCp = null));
  return mockitoCp;
}

const json = (s: string) => JSON.stringify(s);
const erasure = (type: string) => type.replace(/<.*>/s, '').replace(/\.\.\.$/, '[]').split('.').pop()!.trim();

/**
 * Тип локальной переменной для аргумента. Объявленный тип даёт выражению целевой тип
 * (List.of() → List<Long>); параметры типа (T, K, V — по соглашению одна буква) стираются до Object.
 */
function localType(type: string): string {
  const t = type.replace(/\.\.\.$/, '[]');
  return t.split(/[^\w$]+/).some((id) => /^[A-Z]\d?$/.test(id)) ? 'Object' : t;
}

/** Ответ заглушки: выражение или блок `{ ...; return x; }`. */
const supplier = (value: string) => (value.trim().startsWith('{') ? `() -> ${value.trim()}` : `() -> (${value})`);

/** Аргумент: выражение или блок `{ Category c = new Category(); c.setName("x"); return c; }`. */
const argument = (value: string, type: string) =>
  value.trim().startsWith('{') ? `((java.util.function.Supplier<${type}>) () -> ${value.trim()}).get()` : value;

interface CaseLines {
  id: string;
  from: number;
  to: number;
}

function harnessSource(pkg: string, cases: UnitCase[], files: Map<string, string>) {
  const imports = new Set<string>(['import java.util.*;']);
  for (const c of cases) {
    const src = files.get(c.file) ?? '';
    for (const m of src.matchAll(/^\s*import\s+(static\s+)?([\w.]+)\.(\w+|\*)\s*;/gm)) {
      const [line, isStatic, owner] = m;
      imports.add(line.trim());
      // Пакет целиком: импортирован Page — в кейсе доступен и PageImpl из того же пакета.
      if (!isStatic && owner !== 'java.awt') imports.add(`import ${owner}.*;`);
    }
    // Вложенные типы проверяемого класса доступны по простому имени.
    const top = c.binaryName.slice(pkg ? pkg.length + 1 : 0).split('$')[0];
    imports.add(`import ${pkg ? `${pkg}.` : ''}${top}.*;`);
  }
  const lines: string[] = [];
  if (pkg) lines.push(`package ${pkg};`);
  lines.push(...imports, '', 'public class JbpCases {', '  public static void main(String[] jbpArgs) {');
  const ranges: CaseLines[] = [];
  for (const c of cases) {
    const locals = c.params
      .map((p, i) => {
        const type = localType(p.type);
        // Supplier<int> невозможен — для блока у примитива берём обёртку.
        const boxed = { int: 'Integer', long: 'Long', double: 'Double', float: 'Float', boolean: 'Boolean', char: 'Character', short: 'Short', byte: 'Byte' }[type] ?? type;
        return `${type} a${i} = ${argument(c.args[i] ?? 'null', boxed)};`;
      })
      .join(' ');
    const stubs = c.stubs
      .map((s) => `, jbp.JbpRuntime.${s.kind === 'throws' ? 'throwing' : 'returns'}(${json(s.field)}, ${json(s.method)}, ${supplier(s.value)})`)
      .join('');
    const call =
      `    jbp.JbpRuntime.run(${json(c.id)}, ${json(c.binaryName)}, ${json(c.method)}, new String[]{${c.params.map((p) => json(erasure(p.type))).join(', ')}}, ` +
      `() -> { ${locals} return new Object[]{${c.params.map((_, i) => `a${i}`).join(', ')}}; }${stubs});`;
    const from = lines.length + 1;
    lines.push(...call.split('\n'));
    ranges.push({ id: c.id, from, to: lines.length });
  }
  lines.push('  }', '}', '');
  return { source: lines.join('\n'), ranges };
}

const errorOutcome = (value: string): UnitOutcome => ({ kind: 'error', value, calls: [], warnings: [] });

const parses = (statement: string) => {
  const tree = parseJava(`class JbpCheck { void f() { ${statement} } }`);
  const ok = !tree.rootNode.hasError;
  tree.delete();
  return ok;
};

/**
 * Синтаксис аргументов и ответов заглушек — до javac. Синтаксическая ошибка в одном кейсе
 * даёт у javac каскад ошибок в следующих строках, и по ним уже не понять, какой кейс виноват.
 */
function syntaxError(c: UnitCase): string | null {
  for (let i = 0; i < c.params.length; i++) {
    if (!parses(`Object a = ${argument(c.args[i] ?? 'null', 'Object')};`)) return `синтаксическая ошибка в аргументе ${c.params[i].name}`;
  }
  for (const s of c.stubs) {
    if (!parses(`java.util.function.Supplier<Object> s = ${supplier(s.value)};`)) return `синтаксическая ошибка в заглушке ${s.field}.${s.method}`;
  }
  return null;
}

/** Прогон кейсов на одной версии: id кейса → результат. */
export async function runUnits(ws: Workspace, files: SourceFile[], cases: UnitCase[]): Promise<Map<string, UnitOutcome>> {
  const out = new Map<string, UnitOutcome>();
  if (!cases.length) return out;
  let mockito: string;
  try {
    mockito = await mockitoClasspath();
  } catch (e) {
    console.warn(String(e));
    for (const c of cases) out.set(c.id, errorOutcome(String(e)));
    return out;
  }
  const sources = new Map(files.map((f) => [f.path, f.content]));
  const runtime = await readFile(RUNTIME_SOURCE, 'utf8');
  const major = await javaMajor();

  // Драйвер — в пакете проверяемого класса (доступ к package-private), classpath — его модуля.
  const groups = new Map<string, UnitCase[]>();
  for (const c of cases) {
    if (!sources.has(c.file)) {
      out.set(c.id, errorOutcome(`файл ${c.file} отсутствует в этой версии`));
      continue;
    }
    const syntax = syntaxError(c);
    if (syntax) {
      out.set(c.id, errorOutcome(syntax));
      continue;
    }
    const pkg = c.binaryName.includes('.') ? c.binaryName.slice(0, c.binaryName.lastIndexOf('.')) : '';
    const key = `${await ws.classpathFor(c.file)}\n${pkg}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  let n = 0;
  for (const [key, group] of groups) {
    const [projectCp, pkg] = key.split('\n');
    // Mockito первым: его Byte Buddy новее, чем у Hibernate в classpath проекта.
    const cp = [mockito, projectCp].join(path.delimiter);
    const dir = path.join(ws.dir, 'units', `g${n++}`);
    const pkgDir = path.join(dir, 'src', ...pkg.split('.').filter(Boolean));
    await mkdir(pkgDir, { recursive: true });
    await mkdir(path.join(dir, 'src', 'jbp'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'jbp', 'JbpRuntime.java'), runtime, 'utf8');

    let pending = group;
    for (let attempt = 0; attempt < 6 && pending.length; attempt++) {
      const { source, ranges } = harnessSource(pkg, pending, sources);
      const harness = path.join(pkgDir, 'JbpCases.java');
      await writeFile(harness, source, 'utf8');
      const c = await exec(
        javaBin('javac'),
        ['-encoding', 'UTF-8', '-proc:none', '-nowarn', '-d', path.join(dir, 'out'), '-cp', cp, path.join(dir, 'src', 'jbp', 'JbpRuntime.java'), harness],
        { cwd: dir, timeoutMs: 120_000 },
      );
      if (c.exitCode === 0) break;
      // Ошибки по строкам драйвера → кейсы, которые их содержат.
      const text = c.stderr + c.stdout;
      const broken = new Map<string, string>();
      for (const m of text.matchAll(/JbpCases\.java:(\d+): error: (.+)/g)) {
        const r = ranges.find((x) => Number(m[1]) >= x.from && Number(m[1]) <= x.to);
        if (r && !broken.has(r.id)) broken.set(r.id, `не компилируется: ${m[2]}`);
      }
      if (!broken.size) {
        for (const p of pending) out.set(p.id, errorOutcome(`драйвер не компилируется: ${text.slice(0, 600)}`));
        pending = [];
        break;
      }
      for (const [id, msg] of broken) out.set(id, errorOutcome(msg));
      pending = pending.filter((p) => !broken.has(p.id));
    }
    if (!pending.length) continue;

    const vmArgs = ['-Dnet.bytebuddy.experimental=true', '-Xshare:off', '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Xmx512m'];
    if (major >= 21) vmArgs.unshift('-XX:+EnableDynamicAgentLoading'); // Mockito подключает агент Byte Buddy на лету
    const r = await exec(javaBin('java'), [...vmArgs, '-cp', [path.join(dir, 'out'), cp].join(path.delimiter), pkg ? `${pkg}.JbpCases` : 'JbpCases'], {
      cwd: dir,
      timeoutMs: UNIT_TIMEOUT_MS,
    });
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!line.startsWith('JBP\t')) continue;
      try {
        const o = JSON.parse(line.slice(4)) as UnitOutcome & { id: string };
        out.set(o.id, { kind: o.kind, value: o.value, calls: o.calls, warnings: o.warnings });
      } catch (e) {
        console.warn(`строка драйвера не разобрана: ${e}`);
      }
    }
    const reason = r.timedOut ? `таймаут ${UNIT_TIMEOUT_MS / 1000} с` : `драйвер завершился с кодом ${r.exitCode}: ${r.stderr.slice(0, 400)}`;
    for (const p of pending) if (!out.has(p.id)) out.set(p.id, errorOutcome(`не выполнился: ${reason}`));
  }
  return out;
}

const sameOutcome = (a: UnitOutcome, b: UnitOutcome) => a.kind === b.kind && a.value === b.value;
const sameCalls = (a: UnitOutcome, b: UnitOutcome) => a.calls.join('\n') === b.calls.join('\n');

/**
 * Дифференциальная проверка кейсов: результат (значение или исключение) и вызовы
 * зависимостей должны совпасть. При недетерминизме эталон прогоняется дважды.
 */
export async function compareUnits(
  original: { ws: Workspace; files: SourceFile[] },
  modified: { ws: Workspace; files: SourceFile[] },
  cases: UnitCase[],
  twice: boolean,
): Promise<UnitCaseResult[]> {
  const a = await runUnits(original.ws, original.files, cases);
  const b = await runUnits(modified.ws, modified.files, cases);
  const again = twice ? await runUnits(original.ws, original.files, cases) : null;
  return cases.map((c) => {
    const o = a.get(c.id) ?? errorOutcome('нет результата');
    const m = b.get(c.id) ?? errorOutcome('нет результата');
    const mismatches: string[] = [];
    if (!sameOutcome(o, m)) mismatches.push(o.kind !== m.kind ? 'исход' : o.kind === 'throw' ? 'исключение' : 'результат');
    if (!sameCalls(o, m)) mismatches.push('вызовы зависимостей');
    const second = again?.get(c.id);
    const flaky = !!second && (!sameOutcome(o, second) || !sameCalls(o, second));
    // Кейс, не выполнившийся на эталоне, ничего не доказывает — это не «совпадение».
    const passed = !flaky && !mismatches.length && o.kind !== 'error';
    return { id: c.id, name: c.name, label: c.label, passed, flaky, mismatches, original: o, modified: m };
  });
}
