import type { Node, Tree } from 'web-tree-sitter';
import type { AppLink, Architecture, DataAccess, DataStore, DataTable, Range, SourceFile, StoreKind, TypeInfo } from '../../shared/types.ts';
import { descendants, rangeOf } from './parser.ts';

/*
 * Хранилища данных, в которые ходит код: SQL-базы, MongoDB, Redis, Elasticsearch, Cassandra.
 *   Адрес — из application.properties/yml, persistence.xml или DriverManager.getConnection("jdbc:…").
 *   Одинаковый адрес у разных приложений — одно хранилище. Адреса нет — обращения одного вида сводятся
 *   к единственному известному хранилищу этого вида, а если известных нет — к одному «адрес не найден».
 *   Таблицы — из @Entity/@Table, @Document, репозиториев Spring Data и текста SQL/JPQL в коде.
 */

const TYPE_NODES = ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'];
const METHOD_NODES = ['method_declaration', 'constructor_declaration'];

const ENGINES: Record<string, string> = {
  postgresql: 'PostgreSQL', postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', oracle: 'Oracle', sqlserver: 'SQL Server',
  h2: 'H2', sqlite: 'SQLite', hsqldb: 'HSQLDB', derby: 'Derby', db2: 'DB2', clickhouse: 'ClickHouse', mongodb: 'MongoDB', 'mongodb+srv': 'MongoDB',
  redis: 'Redis', rediss: 'Redis',
};
const KIND_ENGINE: Record<StoreKind, string> = { sql: 'SQL', mongodb: 'MongoDB', redis: 'Redis', elasticsearch: 'Elasticsearch', cassandra: 'Cassandra' };

/** Ключи конфигурации с адресом хранилища, в порядке предпочтения. */
const CONFIG_KEYS: [StoreKind, RegExp][] = [
  ['sql', /^(spring\.datasource(\.hikari)?\.(jdbc-)?url|spring\.r2dbc\.url|quarkus\.datasource\.jdbc\.url|(javax|jakarta)\.persistence\.jdbc\.url|hibernate\.connection\.url)$/],
  ['mongodb', /^spring\.(data\.)?mongodb\.(uri|database|host)$/],
  ['redis', /^spring\.(data\.)?redis\.(url|host)$/],
  ['elasticsearch', /^spring\.elasticsearch\.(rest\.)?uris$/],
  ['cassandra', /^spring\.(data\.)?cassandra\.(keyspace-name|contact-points)$/],
];

const REPO_BASES: [RegExp, StoreKind][] = [
  [/^(Reactive)?MongoRepository$/, 'mongodb'],
  [/^(Reactive)?ElasticsearchRepository$/, 'elasticsearch'],
  [/^(Reactive)?CassandraRepository$/, 'cassandra'],
  [/^(Jpa|Crud|ListCrud|PagingAndSorting|ListPagingAndSorting|ReactiveCrud|ReactiveSorting|R2dbc|Revision)?Repository$/, 'sql'],
];

/** Тип поля или переменной → вид хранилища и как к нему обращаются. */
const CLIENTS: [RegExp, StoreKind, 'jdbc' | 'jpa' | 'mongo' | 'raw'][] = [
  [/^(JdbcTemplate|NamedParameterJdbcTemplate|JdbcClient|JdbcOperations|NamedParameterJdbcOperations|SimpleJdbcInsert|DSLContext)$/, 'sql', 'jdbc'],
  [/^(EntityManager|Session|StatelessSession)$/, 'sql', 'jpa'],
  [/^(Connection|Statement|PreparedStatement|CallableStatement)$/, 'sql', 'jdbc'],
  [/^(MongoTemplate|MongoOperations|ReactiveMongoTemplate|ReactiveMongoOperations)$/, 'mongodb', 'mongo'],
  [/^(MongoCollection|MongoDatabase|MongoClient)$/, 'mongodb', 'raw'],
  [/^(RedisTemplate|StringRedisTemplate|ReactiveRedisTemplate|ReactiveStringRedisTemplate|Jedis|JedisPool|RedissonClient|RedisClient|StatefulRedisConnection|ValueOperations|HashOperations|ListOperations|SetOperations)$/, 'redis', 'raw'],
  [/^(ElasticsearchOperations|ElasticsearchTemplate|ElasticsearchRestTemplate|RestHighLevelClient|ElasticsearchClient)$/, 'elasticsearch', 'raw'],
  [/^(CassandraTemplate|CassandraOperations|CqlSession)$/, 'cassandra', 'raw'],
];

const WRITE = /^(save|insert|update|delete|remove|persist|merge|batchUpdate|executeUpdate|upsert|put|set|hset|lpush|rpush|sadd|incr|decr|expire|flush|drop|create|bulk|index|replace)/i;
const READ = /^(find|get|query|select|read|exists|count|search|load|stream|aggregate|scan|keys|hget|lrange|smembers|opsFor)/i;
const opOf = (method: string, sql?: string): DataAccess['op'] => {
  if (sql) return /^\s*(with\b[\s\S]*?\bselect|select)\b/i.test(sql) ? 'read' : /^\s*(insert|update|delete|merge|create|alter|drop|truncate)\b/i.test(sql) ? 'write' : 'unknown';
  return WRITE.test(method) ? 'write' : READ.test(method) ? 'read' : 'unknown';
};

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const baseName = (t: string) => t.replace(/<[\s\S]*$/, '').replace(/\[\]/g, '').trim().split('.').pop() ?? t;
const typeArgs = (t: string) => (t.match(/<([\s\S]*)>/)?.[1] ?? '').split(',').map((x) => baseName(x.trim())).filter(Boolean);
const short = (s: string, max = 70) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

// ---------- Конфигурация ----------

interface ConfigValue {
  value: string;
  file: string;
  line: number;
}

/** application.properties / .yml / persistence.xml → плоские ключи (a.b.c). */
function parseConfig(f: SourceFile): Map<string, ConfigValue> {
  const out = new Map<string, ConfigValue>();
  const lines = f.content.split('\n');
  const set = (key: string, value: string, i: number) => {
    const v = value.trim().replace(/^["']|["']$/g, '');
    if (key && v && !out.has(key)) out.set(key, { value: v, file: f.path, line: i + 1 });
  };
  if (f.path.endsWith('.properties')) {
    lines.forEach((l, i) => {
      const m = l.match(/^\s*([\w.\-[\]]+)\s*[=:]\s*(.*)$/);
      if (m && !l.trim().startsWith('#')) set(m[1], m[2], i);
    });
  } else if (/\.ya?ml$/.test(f.path)) {
    const stack: { indent: number; key: string }[] = [];
    lines.forEach((l, i) => {
      if (!l.trim() || /^\s*#/.test(l) || /^\s*-/.test(l) || l.startsWith('---')) return;
      const m = l.match(/^(\s*)([\w.\-]+)\s*:\s*(.*)$/);
      if (!m) return;
      const indent = m[1].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const key = [...stack.map((s) => s.key), m[2]].join('.');
      const value = m[3].replace(/\s+#.*$/, '');
      if (value && value !== '|' && value !== '>') set(key, value, i);
      else stack.push({ indent, key: m[2] });
    });
  } else if (f.path.endsWith('.xml')) {
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/<property\s+name="([^"]+)"\s+value="([^"]*)"/g)) set(m[1], m[2], i);
    });
  }
  return out;
}

export const isConfigFile = (path: string) => /(^|\/)(application|bootstrap)[\w-]*\.(properties|ya?ml)$|(^|\/)persistence\.xml$|(^|\/)hibernate\.cfg\.xml$/.test(path);

/** ${DB_URL:jdbc:postgresql://localhost/shop} → значение по умолчанию; без него — сама подстановка. */
const resolve = (v: string) => v.replace(/\$\{([^:}]+):([^}]*)\}/g, '$2');

interface Address {
  kind: StoreKind;
  engine: string;
  name: string;
  /** Ключ сравнения: один и тот же адрес в разных приложениях — одно хранилище. */
  key: string;
  url: string;
}

function parseAddress(kind: StoreKind, raw: string): Address {
  const url = resolve(raw);
  if (/^\$\{/.test(url)) return { kind, engine: KIND_ENGINE[kind], name: url, key: `${kind}|${url}`, url: raw };
  if (kind === 'sql') {
    const m = url.match(/^(?:jdbc:|r2dbc:)?(?:tc:)?([\w+]+):(.*)$/i);
    const scheme = m?.[1].toLowerCase() ?? 'sql';
    const rest = m?.[2] ?? url;
    let host = '';
    let db = '';
    const net = rest.match(/^\/\/([^/;?]+)[/:]?([^;?]*)/);
    if (net) [host, db] = [net[1], net[2].split('/').pop() ?? ''];
    else if (scheme === 'oracle') db = rest.split(/[:@/]/).filter(Boolean).pop() ?? '';
    else db = rest.replace(/^(mem|file|tcp):/, '').split(/[;?]/)[0].split('/').pop()?.replace(/\.(db|sqlite3?|mv\.db)$/, '') ?? '';
    // SQL Server: jdbc:sqlserver://host:1433;databaseName=shop
    db = url.match(/databaseName=([^;]+)/i)?.[1] ?? db;
    const engine = ENGINES[scheme] ?? scheme;
    return { kind, engine, name: db || host || engine, key: `${kind}|${engine}|${host.toLowerCase()}|${db.toLowerCase()}`, url: raw };
  }
  const net = url.match(/^[\w+]+:\/\/(?:[^@/]*@)?([^/?]+)\/?([^?]*)/);
  const host = net?.[1] ?? url.split(',')[0];
  const db = net?.[2] ?? '';
  return { kind, engine: KIND_ENGINE[kind], name: db || host, key: `${kind}|${host.toLowerCase()}|${db.toLowerCase()}`, url: raw };
}

/** Каталог модуля: всё до src/ (multi-module Maven) или корень. */
const moduleDir = (path: string) => {
  const i = path.lastIndexOf('src/');
  return i >= 0 ? path.slice(0, i) : path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
};

// ---------- SQL ----------

/** Таблицы запроса: FROM, JOIN, INTO, UPDATE, DELETE FROM. Для JPQL это имена сущностей. */
function tablesOf(sql: string): string[] {
  const out: string[] = [];
  const text = sql.replace(/'[^']*'/g, "''");
  for (const m of text.matchAll(/\b(?:from|join|into|update|merge\s+into)\s+([\w."`[\]]+)/gi)) {
    const name = m[1].replace(/["`[\]]/g, '').split('.').pop()!;
    if (!/^(select|set|values|where|lateral|unnest|dual)$/i.test(name) && !out.includes(name)) out.push(name);
  }
  // FROM a, b
  for (const m of text.matchAll(/\bfrom\s+([\w.]+(?:\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+\w+)?)+)/gi)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+/)[0].split('.').pop()!;
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Текст строкового аргумента: литерал, текстовый блок, конкатенация литералов, константа класса. */
function stringOf(n: Node | null | undefined, consts: Map<string, string>): string | null {
  if (!n) return null;
  if (n.type === 'string_literal') return n.text.replace(/^"""\s*\n?|"""$|^"|"$/g, '');
  if (n.type === 'identifier' || n.type === 'field_access') return consts.get(n.text.split('.').pop()!) ?? null;
  if (n.type === 'binary_expression') {
    const parts = [n.childForFieldName('left'), n.childForFieldName('right')].map((x) => stringOf(x, consts));
    return parts.some((p) => p !== null) ? parts.map((p) => p ?? ' ? ').join('') : null;
  }
  if (n.type === 'parenthesized_expression') return stringOf(n.namedChildren[0], consts);
  return null;
}

// ---------- Точка входа ----------

interface Use {
  kind: StoreKind;
  app: string;
  /** Адрес из кода (DriverManager.getConnection). */
  address?: Address & { range: Range };
  access?: Omit<DataAccess, 'store' | 'app'>;
}

export function findDataStores(all: SourceFile[], files: SourceFile[], trees: Tree[], types: TypeInfo[], arch: Architecture): void {
  const appOfFile = new Map<string, string>();
  for (const a of arch.apps) for (const f of a.files) appOfFile.set(f, a.id);
  const appDirs = arch.apps.map((a) => ({ id: a.id, dir: a.files.map(moduleDir).reduce(commonPrefix, a.files.length ? moduleDir(a.files[0]) : '') }));
  const appOfConfig = (path: string) => {
    if (arch.apps.length === 1) return arch.apps[0].id;
    const dir = moduleDir(path);
    return appDirs.filter((a) => dir.startsWith(a.dir)).sort((a, b) => b.dir.length - a.dir.length)[0]?.id;
  };

  // Адреса из конфигурации: базовый application.* важнее профилей (application-dev.yml).
  const configured = new Map<string, Map<StoreKind, Address & { range: Range }>>();
  const isProfile = (path: string) => /^(application|bootstrap)[-_]/.test(path.split('/').pop()!);
  const configs = all.filter((f) => isConfigFile(f.path)).sort((a, b) => Number(isProfile(a.path)) - Number(isProfile(b.path)));
  for (const f of configs) {
    const app = appOfConfig(f.path);
    if (!app) continue;
    const values = parseConfig(f);
    const byKind = configured.get(app) ?? new Map();
    for (const [kind, re] of CONFIG_KEYS) {
      if (byKind.has(kind)) continue;
      const hit = [...values].find(([k]) => re.test(k));
      if (!hit) continue;
      let raw = hit[1].value;
      // host + database (MongoDB) → адрес вида mongodb://host/db
      if (kind === 'mongodb' && /\.(host|database)$/.test(hit[0])) {
        const host = [...values].find(([k]) => /mongodb\.host$/.test(k))?.[1].value ?? 'localhost';
        const db = [...values].find(([k]) => /mongodb\.database$/.test(k))?.[1].value ?? '';
        raw = `mongodb://${host}/${db}`;
      }
      if (kind === 'cassandra') raw = `cassandra://${[...values].find(([k]) => /contact-points$/.test(k))?.[1].value ?? 'localhost'}/${[...values].find(([k]) => /keyspace-name$/.test(k))?.[1].value ?? ''}`;
      if (kind === 'redis' && /\.host$/.test(hit[0])) raw = `redis://${raw}`;
      const line = hit[1].line;
      const start = f.content.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
      const end = f.content.indexOf('\n', start);
      byKind.set(kind, { ...parseAddress(kind, raw), range: { file: f.path, start, end: end < 0 ? f.content.length : end, startLine: line, endLine: line } });
    }
    configured.set(app, byKind);
  }

  // ---------- Сущности и репозитории ----------

  const consts = new Map<string, string>();
  const typeAt = new Map<string, string>();
  for (const t of types) typeAt.set(`${t.file}:${t.range.start}`, t.name);
  const methodAt = new Map<string, string>();
  for (const t of types) for (const m of t.methods) if (m.kind !== 'lambda') methodAt.set(`${m.range.file}:${m.range.start}`, m.id);

  const entities = new Map<string, { table: string; kind: StoreKind; file: string }>();
  const repoDecls: { name: string; file: string; extendsText: string[]; node: Node }[] = [];
  trees.forEach((tree, i) => {
    const file = files[i].path;
    const imports = files[i].content;
    for (const d of descendants(tree.rootNode, 'field_declaration')) {
      const v = d.childForFieldName('declarator');
      const s = v?.childForFieldName('value');
      if (/\bfinal\b/.test(d.text) && s?.type === 'string_literal') consts.set(v!.childForFieldName('name')!.text, s.text.slice(1, -1));
    }
    for (const decl of descendants(tree.rootNode, TYPE_NODES)) {
      const name = decl.childForFieldName('name')?.text ?? '';
      const mods = decl.namedChildren.find((c) => c?.type === 'modifiers')?.text ?? '';
      const tableName = (ann: string, keys: string) => mods.match(new RegExp(`@${ann}\\s*\\(\\s*(?:(?:${keys})\\s*=\\s*)?"([^"]+)"`))?.[1];
      if (/@Entity\b/.test(mods)) entities.set(name, { table: tableName('Table', 'name') ?? snake(name), kind: 'sql', file });
      else if (/@Document\b/.test(mods)) {
        const es = /springframework\.data\.elasticsearch/.test(imports);
        entities.set(name, es ? { table: tableName('Document', 'indexName') ?? snake(name), kind: 'elasticsearch', file } : { table: tableName('Document', 'collection|value') ?? lowerFirst(name), kind: 'mongodb', file });
      } else if (/@Table\b/.test(mods) && /springframework\.data\.(cassandra|relational)/.test(imports)) {
        entities.set(name, { table: tableName('Table', 'value|name') ?? snake(name), kind: /cassandra/.test(imports) ? 'cassandra' : 'sql', file });
      }
      if (decl.type === 'interface_declaration') {
        const ext = decl.children.find((c) => c?.type === 'extends_interfaces');
        if (ext) repoDecls.push({ name, file, extendsText: descendants(ext, ['generic_type', 'type_identifier', 'scoped_type_identifier']).filter((t) => t.parent?.type === 'type_list').map((t) => t.text), node: decl });
      }
    }
  });

  // Репозиторий: наследник *Repository<Entity, Id> (или своего базового репозитория).
  const repos = new Map<string, { entity: string; kind: StoreKind; file: string }>();
  for (let pass = 0; pass < 4; pass++) {
    for (const r of repoDecls) {
      if (repos.has(r.name)) continue;
      for (const e of r.extendsText) {
        const base = baseName(e);
        const known = REPO_BASES.find(([re]) => re.test(base))?.[1];
        const parent = repos.get(base);
        const entity = typeArgs(e)[0] ?? parent?.entity;
        if ((known || parent) && entity) {
          repos.set(r.name, { entity, kind: entities.get(entity)?.kind ?? known ?? parent!.kind, file: r.file });
          break;
        }
      }
    }
  }
  const tableOfEntity = (name: string) => entities.get(name)?.table;
  /** JPQL называет сущности, SQL — таблицы: имя сущности переводится в таблицу. */
  const toTable = (name: string) => tableOfEntity(name) ?? name;

  // ---------- Обращения ----------

  const uses: Use[] = [];
  trees.forEach((tree, i) => {
    const file = files[i].path;
    const app = appOfFile.get(file);
    if (!app) return;
    const owners = (n: Node) => {
      let methodId: string | undefined;
      let type: string | undefined;
      for (let p: Node | null = n; p && !type; p = p.parent) {
        if (!methodId && METHOD_NODES.includes(p.type)) methodId = methodAt.get(`${file}:${p.startIndex}`);
        if (TYPE_NODES.includes(p.type)) type = typeAt.get(`${file}:${p.startIndex}`);
      }
      return { methodId, type: type ?? file.split('/').pop()!.replace(/\.java$/, '') };
    };
    /** Тип имени в точке вызова: локальная переменная, параметр, поле класса. */
    const typeOfName = (n: Node, name: string): string | null => {
      for (let p: Node | null = n.parent; p; p = p.parent) {
        if (METHOD_NODES.includes(p.type) || p.type === 'lambda_expression') {
          for (const d of [...descendants(p, 'local_variable_declaration'), ...descendants(p, 'formal_parameter'), ...descendants(p, 'resource')]) {
            const names = d.type === 'local_variable_declaration' ? d.namedChildren.filter((c) => c?.type === 'variable_declarator').map((c) => c!.childForFieldName('name')?.text) : [d.childForFieldName('name')?.text];
            if (names.includes(name)) return baseName(d.childForFieldName('type')?.text ?? '');
          }
        }
        if (TYPE_NODES.includes(p.type)) {
          for (const f of descendants(p.childForFieldName('body')!, 'field_declaration')) {
            if (f.namedChildren.some((c) => c?.type === 'variable_declarator' && c.childForFieldName('name')?.text === name)) return baseName(f.childForFieldName('type')?.text ?? '');
          }
          return null;
        }
      }
      return null;
    };
    const add = (kind: StoreKind, n: Node, a: Omit<DataAccess, 'store' | 'app' | 'type' | 'file' | 'methodId' | 'range'>) => {
      uses.push({ kind, app, access: { ...a, ...owners(n), file, range: rangeOf(n, file) } });
    };

    // Сам репозиторий и его @Query.
    for (const decl of descendants(tree.rootNode, 'interface_declaration')) {
      const repo = repos.get(decl.childForFieldName('name')?.text ?? '');
      if (!repo) continue;
      const table = tableOfEntity(repo.entity) ?? snake(repo.entity);
      for (const m of descendants(decl.childForFieldName('body')!, 'method_declaration')) {
        const q = m.namedChildren.find((c) => c?.type === 'modifiers')?.text.match(/@Query\s*\(\s*(?:value\s*=\s*)?("(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*|"""[\s\S]*?""")/)?.[1];
        if (!q) continue;
        const sql = q.replace(/"""|"\s*\+\s*"|^"|"$/g, ' ');
        const tables = tablesOf(sql).map(toTable);
        add(repo.kind, m, { table: tables[0] ?? table, tables, op: opOf('', sql) === 'unknown' ? opOf(m.childForFieldName('name')?.text ?? '') : opOf('', sql), detail: `@Query ${short(sql, 60)}` });
      }
    }

    for (const inv of descendants(tree.rootNode, 'method_invocation')) {
      const name = inv.childForFieldName('name')?.text ?? '';
      const obj = inv.childForFieldName('object');
      const args = inv.childForFieldName('arguments')?.namedChildren.filter((c): c is Node => !!c) ?? [];
      if (obj?.text === 'DriverManager' && name === 'getConnection') {
        const url = stringOf(args[0], consts);
        if (url) uses.push({ kind: 'sql', app, address: { ...parseAddress('sql', url), range: rangeOf(inv, file) } });
        continue;
      }
      if (!obj) continue;
      // Цепочки: jdbcTemplate.query(…), this.repo.save(…), jdbc.sql(…).query(…)
      let root = obj;
      while (root.type === 'method_invocation' && root.childForFieldName('object')) root = root.childForFieldName('object')!;
      const recv = root.type === 'field_access' ? root.childForFieldName('field')?.text ?? '' : root.text;
      if (!/^\w+$/.test(recv)) continue;
      const type = typeOfName(inv, recv) ?? '';
      const repo = repos.get(type);
      if (repo) {
        if (root !== obj) continue; // repo.findAll().stream()… — обращение одно, к самому repo
        const table = tableOfEntity(repo.entity) ?? snake(repo.entity);
        // Свои методы репозитория (findByStatus, byCustomer) почти всегда читают.
        add(repo.kind, inv, { table, tables: [table], op: opOf(name) === 'unknown' ? 'read' : opOf(name), detail: `${type}.${name}` });
        continue;
      }
      const client = CLIENTS.find(([re]) => re.test(type));
      if (!client || root !== obj && client[2] !== 'jdbc') continue;
      const [, kind, style] = client;
      if (style === 'jdbc') {
        const sql = args.map((a) => stringOf(a, consts)).find((s) => s && /\b(select|insert|update|delete|merge|from)\b/i.test(s));
        if (!sql && !/^(query|update|batchUpdate|execute|sql|prepareStatement|executeQuery|executeUpdate)/.test(name)) continue;
        // ps.executeQuery() без текста — тот же запрос, что в prepareStatement(…): уже учтён.
        if (!sql && (root !== obj || /^(PreparedStatement|CallableStatement)$/.test(type))) continue;
        const tables = sql ? tablesOf(sql) : [];
        add(kind, inv, { table: tables[0], tables, op: opOf(name, sql ?? undefined), detail: `${type}.${name}${sql ? `: ${short(sql, 60)}` : ''}` });
      } else if (style === 'jpa') {
        const q = /^create(Native)?Query$/.test(name) ? stringOf(args[0], consts) : null;
        const cls = args.map((a) => a.text.match(/^(\w+)\.class$/)?.[1]).find(Boolean);
        const tables = q ? tablesOf(q).map((t) => (name === 'createQuery' ? toTable(t) : t)) : cls ? [toTable(cls)] : [];
        add(kind, inv, { table: tables[0], tables, op: q ? opOf('', q) : opOf(name), detail: `${type}.${name}${q ? `: ${short(q, 60)}` : cls ? `(${cls})` : ''}` });
      } else if (style === 'mongo') {
        const cls = args.map((a) => a.text.match(/^(\w+)\.class$/)?.[1]).find(Boolean);
        const lit = args.map((a) => (a.type === 'string_literal' ? a.text.slice(1, -1) : null)).find(Boolean);
        const table = cls ? toTable(cls) : lit ?? undefined;
        add(kind, inv, { table, tables: table ? [table] : [], op: opOf(name), detail: `${type}.${name}${cls ? `(${cls})` : ''}` });
      } else {
        add(kind, inv, { op: opOf(name), detail: `${type}.${name}` });
      }
    }
  });

  // ---------- Сопоставление с хранилищами ----------

  const stores = new Map<string, DataStore>();
  const storeOf = new Map<string, string>(); // `${app}|${kind}` → store id
  const ensure = (a: Address & { range?: Range }) => {
    const id = `db:${a.key}`;
    if (!stores.has(id)) stores.set(id, { id, kind: a.kind, engine: a.engine, name: a.name, url: a.url, configRange: a.range, tables: [] });
    return id;
  };
  for (const [app, byKind] of configured) for (const [kind, a] of byKind) storeOf.set(`${app}|${kind}`, ensure(a));
  for (const u of uses) if (u.address && !storeOf.has(`${u.app}|sql`)) storeOf.set(`${u.app}|sql`, ensure(u.address));

  const appsUsing = new Map<StoreKind, Set<string>>();
  const note = (app: string, kind: StoreKind) => appsUsing.set(kind, (appsUsing.get(kind) ?? new Set()).add(app));
  for (const u of uses) if (u.access) note(u.app, u.kind);
  for (const e of entities.values()) {
    const app = appOfFile.get(e.file);
    if (app) note(app, e.kind);
  }
  const resolveStore = (app: string, kind: StoreKind) => {
    const own = storeOf.get(`${app}|${kind}`);
    if (own) return own;
    // Адреса нет: единственное известное хранилище этого вида, иначе общее «адрес не найден».
    const known = [...stores.values()].filter((s) => s.kind === kind);
    const id = known.length === 1 ? known[0].id : ensure({ kind, engine: KIND_ENGINE[kind], name: 'адрес не найден', key: `${kind}|?`, url: '' });
    storeOf.set(`${app}|${kind}`, id);
    return id;
  };
  for (const [kind, set] of appsUsing) for (const app of set) resolveStore(app, kind);

  const access: DataAccess[] = [];
  for (const u of uses) if (u.access) access.push({ ...u.access, store: resolveStore(u.app, u.kind), app: u.app });

  const addTable = (store: string, t: DataTable) => {
    const s = stores.get(store)!;
    const same = s.tables.find((x) => x.name.toLowerCase() === t.name.toLowerCase());
    if (same) Object.assign(same, { entity: same.entity ?? t.entity, entityFile: same.entityFile ?? t.entityFile });
    else s.tables.push(t);
  };
  for (const [name, e] of entities) {
    const app = appOfFile.get(e.file);
    if (app) addTable(resolveStore(app, e.kind), { name: e.table, entity: name, entityFile: e.file });
  }
  for (const a of access) for (const t of a.tables ?? (a.table ? [a.table] : [])) addTable(a.store, { name: t });
  for (const s of stores.values()) s.tables.sort((a, b) => a.name.localeCompare(b.name));

  const links = new Map<string, AppLink>();
  for (const a of access) {
    const id = `data:${a.app}->${a.store}`;
    if (!links.has(id)) links.set(id, { id, from: a.app, to: a.store, kind: 'data', calls: [] });
    links.get(id)!.calls.push({ detail: a.table ? `${a.table} · ${a.detail}` : a.detail, range: a.range, fromMethodId: a.methodId, fromType: a.type });
  }
  // Хранилище из конфигурации, к которому в коде обращений не нашлось, — тоже связь приложения.
  for (const [key, store] of storeOf) {
    const app = key.split('|')[0];
    const id = `data:${app}->${store}`;
    const cfg = stores.get(store)!.configRange;
    if (!links.has(id) && cfg) links.set(id, { id, from: app, to: store, kind: 'data', calls: [{ detail: `адрес в ${cfg.file.split('/').pop()}`, range: cfg }] });
  }

  arch.stores = [...stores.values()];
  arch.access = access;
  arch.links.push(...links.values());
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(0, a.lastIndexOf('/', i - 1) + 1);
}
