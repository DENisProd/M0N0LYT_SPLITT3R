import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SourceFile } from '../../shared/types.ts';

// Проект без pom.xml (IntelliJ, Eclipse, учебный) собирается голым javac, и любой import библиотеки вне JDK —
// ошибка «package … does not exist». Известные библиотеки узнаём по пакету импорта и скачиваем через Maven.

interface Lib {
  /** Префикс пакета импорта. Проверяется сверху вниз: первым — самый длинный. */
  prefix: string;
  artifact: string;
}

const JAVAFX = '21.0.5';
const LIBS: Lib[] = [
  // JavaFX убрали из JDK в 11. javafx-controls тянет graphics и base, остальные модули отдельно.
  { prefix: 'javafx.fxml', artifact: `org.openjfx:javafx-fxml:${JAVAFX}` },
  { prefix: 'javafx.scene.media', artifact: `org.openjfx:javafx-media:${JAVAFX}` },
  { prefix: 'javafx.scene.web', artifact: `org.openjfx:javafx-web:${JAVAFX}` },
  { prefix: 'javafx.embed.swing', artifact: `org.openjfx:javafx-swing:${JAVAFX}` },
  { prefix: 'javafx.', artifact: `org.openjfx:javafx-controls:${JAVAFX}` },
  { prefix: 'com.google.gson.', artifact: 'com.google.code.gson:gson:2.11.0' },
  { prefix: 'com.google.common.', artifact: 'com.google.guava:guava:33.3.1-jre' },
  { prefix: 'com.fasterxml.jackson.databind.', artifact: 'com.fasterxml.jackson.core:jackson-databind:2.18.1' },
  { prefix: 'com.fasterxml.jackson.core.', artifact: 'com.fasterxml.jackson.core:jackson-core:2.18.1' },
  { prefix: 'com.fasterxml.jackson.annotation.', artifact: 'com.fasterxml.jackson.core:jackson-annotations:2.18.1' },
  { prefix: 'org.json.', artifact: 'org.json:json:20240303' },
  { prefix: 'org.apache.commons.lang3.', artifact: 'org.apache.commons:commons-lang3:3.17.0' },
  { prefix: 'org.apache.commons.io.', artifact: 'commons-io:commons-io:2.17.0' },
  { prefix: 'org.slf4j.', artifact: 'org.slf4j:slf4j-api:2.0.16' },
  { prefix: 'lombok.', artifact: 'org.projectlombok:lombok:1.18.36' },
  { prefix: 'org.junit.jupiter.', artifact: 'org.junit.jupiter:junit-jupiter-api:5.11.3' },
  { prefix: 'org.junit.', artifact: 'junit:junit:4.13.2' },
  { prefix: 'com.formdev.flatlaf.', artifact: 'com.formdev:flatlaf:3.5.2' },
];

const IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+)/gm;

/** Пакеты импортов, которые не из JDK и не из самого проекта. */
function foreignImports(files: SourceFile[]): string[] {
  const own = new Set(files.map((f) => f.content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1]).filter((p): p is string => !!p));
  const out = new Set<string>();
  for (const f of files) {
    for (const m of f.content.matchAll(IMPORT_RE)) {
      const name = m[1];
      if (/^(java|javax|jdk|sun|com\.sun|org\.w3c|org\.xml|org\.ietf)\./.test(name)) continue;
      if ([...own].some((p) => name.startsWith(`${p}.`))) continue;
      out.add(name);
    }
  }
  return [...out];
}

/** Артефакты Maven для импортов проекта и импорты, которые узнать не удалось. */
export function librariesFor(files: SourceFile[]): { artifacts: string[]; unknown: string[] } {
  const artifacts = new Set<string>();
  const unknown = new Set<string>();
  for (const name of foreignImports(files)) {
    const lib = LIBS.find((l) => name.startsWith(l.prefix));
    if (lib) artifacts.add(lib.artifact);
    else unknown.add(name.split('.').slice(0, 3).join('.'));
  }
  return { artifacts: [...artifacts].sort(), unknown: [...unknown].sort() };
}

export const usesJavaFx = (files: SourceFile[]) => librariesFor(files).artifacts.some((a) => a.startsWith('org.openjfx:'));

const pom = (artifacts: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>jbp</groupId>
  <artifactId>libs</artifactId>
  <version>1</version>
  <dependencies>
${artifacts.map((a) => {
  const [g, n, v] = a.split(':');
  return `    <dependency><groupId>${g}</groupId><artifactId>${n}</artifactId><version>${v}</version></dependency>`;
}).join('\n')}
  </dependencies>
</project>
`;

type Exec = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; shell?: boolean }) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;

// Эталон и правка собираются параллельно с одним набором библиотек — скачиваем один раз.
const cache = new Map<string, Promise<{ classpath: string; error?: string }>>();

/** Classpath библиотек: Maven скачивает их в ~/.m2 (один раз) и печатает пути к jar. */
export function resolveLibraries(artifacts: string[], exec: Exec, maven: string, timeoutMs: number): Promise<{ classpath: string; error?: string }> {
  const key = artifacts.join(' ');
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'jbp-libs-'));
      try {
        await writeFile(path.join(dir, 'pom.xml'), pom(artifacts), 'utf8');
        const r = await exec(maven, ['-q', '-B', 'dependency:build-classpath', '-Dmdep.outputFile=cp.txt'], { cwd: dir, timeoutMs, shell: true });
        if (r.exitCode !== 0) {
          const why = r.timedOut ? `не уложилось в ${timeoutMs / 1000} с` : (r.stdout + r.stderr).trim().split('\n').slice(-15).join('\n');
          return { classpath: '', error: `Не удалось скачать библиотеки через Maven (${artifacts.join(', ')}):\n${why}` };
        }
        return { classpath: (await readFile(path.join(dir, 'cp.txt'), 'utf8')).trim() };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    })();
    cache.set(key, p);
    // Неудачу не кэшируем: сеть могла появиться, Maven — установиться.
    p.then((r) => r.error && cache.delete(key), () => cache.delete(key));
  }
  return p;
}
