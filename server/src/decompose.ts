import type {
  AnalyzeResult,
  CrossJoin,
  DataAccess,
  DataSplit,
  DataStore,
  DecompositionMetrics,
  DecompositionResult,
  DecompositionStrategy,
  DecompositionType,
  DecompositionVariant,
  ProposedService,
  ServiceDependency,
  ServiceStore,
  SharedTable,
  SourceFile,
  TypeInfo,
  TypeRole,
} from '../../shared/types.ts';
import { findBottlenecks, stronglyConnected, type TransactionSpan } from './bottlenecks.ts';

// Разделение приложения на микросервисы: граф зависимостей классов и несколько способов его разрезать.
// Каждый способ — эвристика; варианты сравниваются одними и теми же метриками.

const typeKey = (t: Pick<TypeInfo, 'file' | 'name'>) => `${t.file}:${t.name}`;

/** Вес связи: поле (внедрённая зависимость) и наследование держат классы вместе сильнее вызова. */
const W = { header: 4, field: 3, call: 1, signature: 1 } as const;
/** Меньше классов (без конфигурации) — приложение уже размером с микросервис. */
const MIN_DOMAIN = 8;

const ROLE_SUFFIX = /(RestController|Controller|ServiceImpl|Service|Impl|Repository|Repo|Dao|Mapper|Converter|Dto|DTO|Request|Response|Entity|Model|Facade|Client|Handler|Listener|Consumer|Producer|Publisher|Validator|Exception|Factory|Helper|Resource|Endpoint|Api|View|Form|Event|Command|Query|Specification|Spec)$/;
const LAYER_PACKAGES = new Set([
  'controller', 'controllers', 'web', 'rest', 'api', 'service', 'services', 'impl', 'repository', 'repositories', 'repo', 'dao',
  'model', 'models', 'entity', 'entities', 'domain', 'dto', 'dtos', 'config', 'configuration', 'mapper', 'mappers', 'util', 'utils',
  'exception', 'exceptions', 'listener', 'listeners', 'client', 'clients', 'security', 'common', 'core',
]);

/** Доменный корень имени: OrderController, OrderServiceImpl, OrderDto → Order. */
function stem(name: string): string {
  let s = name;
  for (let i = 0; i < 3; i++) {
    const next = s.replace(ROLE_SUFFIX, '');
    if (!next || next === s) break;
    s = next;
  }
  return s || name;
}

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const identifiers = (text: string) => text.match(/\b[A-Z]\w*/g) ?? [];

function roleOf(t: TypeInfo, header: string, body: string): TypeRole {
  if (/@(Entity|Document|Table)\b/.test(header)) return 'entity';
  if (/@Repository\b/.test(header) || /\b\w*Repository\s*</.test(header)) return 'repository';
  if (/@(Rest)?Controller\b/.test(header)) return 'controller';
  if (/@(KafkaListener|RabbitListener|JmsListener|StreamListener)\b/.test(body)) return 'listener';
  if (/@(Configuration|SpringBootApplication|ConfigurationProperties|EnableAutoConfiguration)\b/.test(header) || t.methods.some((m) => m.name === 'main' && m.isStatic)) return 'config';
  if (/@(Service|Component)\b/.test(header)) return 'service';
  if (t.kind === 'record' || t.kind === 'enum' || /(Dto|DTO|Request|Response|Exception|Event)$/.test(t.name)) return 'dto';
  return 'other';
}

interface Graph {
  nodes: string[];
  /** Направленные веса: кто от кого зависит. */
  out: Map<string, Map<string, number>>;
  /** Неориентированные веса (сумма обоих направлений). */
  und: Map<string, Map<string, number>>;
  /** Вызовы методов между классами: from → to → подписи. */
  calls: Map<string, Map<string, string[]>>;
}

const bump = (m: Map<string, Map<string, number>>, a: string, b: string, w: number) => {
  const row = m.get(a) ?? new Map<string, number>();
  row.set(b, (row.get(b) ?? 0) + w);
  m.set(a, row);
};

// ---------- Разбиения ----------

type Assignment = Map<string, string>;

/** Достраивает разбиение: свободный класс уходит в группу, с которой связан сильнее всего. */
function grow(seed: Assignment, g: Graph, candidates: string[]): Assignment {
  const assign = new Map(seed);
  for (;;) {
    let best: { node: string; group: string; w: number } | null = null;
    for (const n of candidates) {
      if (assign.has(n)) continue;
      const aff = new Map<string, number>();
      for (const [m, w] of g.und.get(n) ?? []) {
        const grp = assign.get(m);
        if (grp) aff.set(grp, (aff.get(grp) ?? 0) + w);
      }
      for (const [grp, w] of aff) if (!best || w > best.w) best = { node: n, group: grp, w };
    }
    if (!best) break;
    assign.set(best.node, best.group);
  }
  return assign;
}

/** Louvain: локальные перемещения + агрегация, пока модулярность растёт. resolution < 1 даёт более крупные сообщества. */
function louvain(nodes: string[], und: Graph['und'], resolution: number): Assignment {
  let size = nodes.length;
  // Текущий граф супер-узлов: индексы, петли хранятся как w[i][i].
  let adj: Map<number, number>[] = nodes.map(() => new Map());
  nodes.forEach((n, i) => {
    for (const [m, w] of und.get(n) ?? []) {
      const j = nodes.indexOf(m);
      if (j >= 0 && j !== i) adj[i].set(j, w);
    }
  });
  let membership = nodes.map((_, i) => i); // исходный узел → супер-узел
  for (let level = 0; level < 20; level++) {
    const degree = adj.map((row, i) => [...row].reduce((s, [j, w]) => s + (j === i ? 2 * w : w), 0));
    const m2 = degree.reduce((a, b) => a + b, 0);
    if (m2 === 0) break;
    const comm = Array.from({ length: size }, (_, i) => i);
    const tot = [...degree];
    let moved = false;
    for (let pass = 0, improved = true; improved && pass < 50; pass++) {
      improved = false;
      for (let i = 0; i < size; i++) {
        const old = comm[i];
        tot[old] -= degree[i];
        const toComm = new Map<number, number>();
        for (const [j, w] of adj[i]) if (j !== i) toComm.set(comm[j], (toComm.get(comm[j]) ?? 0) + w);
        let best = old;
        let bestGain = (toComm.get(old) ?? 0) - (resolution * tot[old] * degree[i]) / m2;
        for (const [c, w] of toComm) {
          const gain = w - (resolution * tot[c] * degree[i]) / m2;
          if (gain > bestGain + 1e-12) {
            best = c;
            bestGain = gain;
          }
        }
        comm[i] = best;
        tot[best] += degree[i];
        if (best !== old) improved = moved = true;
      }
    }
    if (!moved) break;
    const ids = [...new Set(comm)];
    const renum = new Map(ids.map((c, k) => [c, k]));
    const next: Map<number, number>[] = ids.map(() => new Map());
    for (let i = 0; i < size; i++) {
      for (const [j, w] of adj[i]) {
        const a = renum.get(comm[i])!;
        const b = renum.get(comm[j])!;
        // Каждое внутреннее ребро встречается дважды (i→j и j→i), петля — один раз.
        const add = a === b ? (i === j ? w : w / 2) : w;
        next[a].set(b, (next[a].get(b) ?? 0) + add);
      }
    }
    membership = membership.map((s) => renum.get(comm[s])!);
    adj = next;
    size = ids.length;
  }
  return new Map(nodes.map((n, i) => [n, `c${membership[i]}`]));
}

/** Разбиение без сервисов-«пылинок»: одиночки и группы из одних DTO вливаются в самого связанного соседа. */
function absorbSmall(assign: Assignment, g: Graph, role: Map<string, TypeRole>): Assignment {
  const out = new Map(assign);
  const stuck = new Set<string>(); // группы без соседей вливать некуда
  for (let guard = 0; guard < 200; guard++) {
    const groups = new Map<string, string[]>();
    for (const [n, grp] of out) groups.set(grp, [...(groups.get(grp) ?? []), n]);
    const weak = [...groups].find(([grp, ms]) => groups.size > 1 && !stuck.has(grp) && (ms.length === 1 || ms.every((n) => role.get(n) === 'dto' || role.get(n) === 'other')));
    if (!weak) break;
    const [grp, members] = weak;
    const aff = new Map<string, number>();
    for (const n of members) for (const [m, w] of g.und.get(n) ?? []) {
      const og = out.get(m);
      if (og && og !== grp) aff.set(og, (aff.get(og) ?? 0) + w);
    }
    const target = [...aff].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!target) {
      stuck.add(grp);
      continue;
    }
    for (const n of members) out.set(n, target);
  }
  return out;
}

// ---------- Метрики ----------

/** Циклические зависимости между сервисами. */
function cycles(nodes: string[], edges: ServiceDependency[]): string[][] {
  return stronglyConnected(nodes, (n) => edges.filter((e) => e.from === n).map((e) => e.to));
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

interface Context {
  g: Graph;
  types: Map<string, DecompositionType>;
  endpointsOf: Map<string, string[]>;
  /** Транзакции, которые трогают несколько агрегатов. */
  transactions: TransactionSpan[];
  /** Обращения к хранилищам из классов приложения и сами хранилища. */
  access: DataAccess[];
  stores: DataStore[];
}

/** Класс обращения → ключ класса верхнего уровня, как в графе зависимостей классов. */
const accessKey = (a: DataAccess) => `${a.file}:${a.type.split('.')[0]}`;

/**
 * Database per service: таблица достаётся сервису, в котором её сущность, а без сущности — тому, кто больше пишет
 * (затем — больше обращается). Остальные сервисы, которые к ней ходят, — общие таблицы; запрос, соединяющий
 * таблицы разных владельцев, — JOIN через границу. Хранилища без таблиц (Redis) не делятся.
 */
function splitData(services: ProposedService[], serviceOf: Map<string, string>, ctx: Context): DataSplit {
  const result: DataSplit = { services: Object.fromEntries(services.map((s) => [s.id, []])), shared: [], joins: [] };
  const key = (store: string, table: string) => `${store}\u0000${table.toLowerCase()}`;
  type Usage = { reads: number; writes: number; access: DataAccess[] };
  const usage = new Map<string, Map<string, Usage>>();
  for (const a of ctx.access) {
    const svc = serviceOf.get(accessKey(a));
    if (!svc) continue;
    for (const t of a.tables?.length ? a.tables : a.table ? [a.table] : []) {
      const row = usage.get(key(a.store, t)) ?? new Map<string, Usage>();
      const u = row.get(svc) ?? { reads: 0, writes: 0, access: [] };
      if (a.op === 'write') u.writes++;
      else u.reads++;
      if (!u.access.includes(a)) u.access.push(a);
      row.set(svc, u);
      usage.set(key(a.store, t), row);
    }
  }
  const owner = new Map<string, string>();
  const base = (name: string) => name.replace(/-service(-\d+)?$/, '');
  for (const store of ctx.stores.filter((s) => ctx.access.some((a) => a.store === s.id) || s.tables.some((t) => t.entityFile && serviceOf.has(`${t.entityFile}:${t.entity}`)))) {
    if (!store.tables.length) {
      // Кэш или поиск без известных таблиц: им пользуются вместе.
      const users = new Set(ctx.access.filter((a) => a.store === store.id).map((a) => serviceOf.get(accessKey(a))).filter((x): x is string => !!x));
      for (const svc of users) result.services[svc].push({ store: store.id, kind: store.kind, engine: store.engine, name: store.name, tables: [], shared: users.size > 1 });
      continue;
    }
    const own = new Map<string, ServiceStore>();
    for (const t of store.tables) {
      const row = usage.get(key(store.id, t.name)) ?? new Map<string, Usage>();
      const byEntity = t.entity && t.entityFile ? serviceOf.get(`${t.entityFile}:${t.entity}`) : undefined;
      const ranked = [...row].sort((a, b) => b[1].writes - a[1].writes || b[1].reads + b[1].writes - (a[1].reads + a[1].writes));
      const svc = byEntity ?? ranked[0]?.[0];
      if (!svc) continue;
      const reason = byEntity ? `сущность ${t.entity} в коде сервиса` : ranked[0][1].writes ? 'больше всего записей' : 'больше всего обращений';
      owner.set(key(store.id, t.name), svc);
      const ss = own.get(svc) ?? { store: store.id, kind: store.kind, engine: store.engine, name: `${base(svc)}-db`, tables: [] };
      ss.tables.push(t.name);
      own.set(svc, ss);
      const users = [...row].filter(([s]) => s !== svc);
      if (users.length) {
        result.shared.push({
          store: store.id, table: t.name, owner: svc, ownerReason: reason,
          users: users.map(([service, u]) => ({ service, reads: u.reads, writes: u.writes, access: u.access.slice(0, 8).map((a) => ({ detail: a.detail, type: a.type, range: a.range })) })),
        });
      }
    }
    for (const [svc, ss] of own) result.services[svc].push(ss);
  }
  const seen = new Set<string>();
  for (const a of ctx.access) {
    if ((a.tables?.length ?? 0) < 2 || seen.has(`${a.file}:${a.range.start}`)) continue;
    const owners = [...new Set(a.tables!.map((t) => owner.get(key(a.store, t))).filter((x): x is string => !!x))];
    if (owners.length < 2) continue;
    seen.add(`${a.file}:${a.range.start}`);
    result.joins.push({ detail: a.detail, tables: a.tables!, services: owners, type: a.type, range: a.range } satisfies CrossJoin);
  }
  result.shared.sort((a, b) => b.users.reduce((n, u) => n + u.writes, 0) - a.users.reduce((n, u) => n + u.writes, 0));
  return result;
}

/** Из разбиения классов — сервисы, общий модуль, зависимости, метрики и оценка. */
function buildVariant(id: DecompositionStrategy, title: string, description: string, raw: Assignment, ctx: Context, nameOf: (members: string[], group: string) => string): DecompositionVariant | null {
  const { g, types } = ctx;
  const role = (n: string) => types.get(n)!.role;

  // Общий модуль: DTO и прочие «листья», которыми пользуются классы двух и более групп.
  const shared: string[] = [];
  const assign = new Map(raw);
  for (const [n] of raw) {
    const r = role(n);
    if (r !== 'dto' && r !== 'other') continue;
    const outDeg = [...(g.out.get(n) ?? [])].filter(([m]) => role(m) !== 'dto').length;
    if (outDeg > 0) continue;
    const users = new Set<string>();
    for (const [m, row] of g.out) if (row.has(n) && raw.has(m) && m !== n) users.add(raw.get(m)!);
    if (users.size >= 2) {
      shared.push(n);
      assign.delete(n);
    }
  }

  const groups = new Map<string, string[]>();
  for (const [n, grp] of assign) groups.set(grp, [...(groups.get(grp) ?? []), n]);
  if (groups.size < 2) return null;

  // Имена сервисов уникальны: при совпадении добавляется номер.
  const used = new Map<string, number>();
  const services: ProposedService[] = [...groups].map(([group, members]) => {
    members.sort((a, b) => types.get(a)!.name.localeCompare(types.get(b)!.name));
    let name = `${kebab(nameOf(members, group))}-service`;
    const k = used.get(name) ?? 0;
    used.set(name, k + 1);
    if (k) name = `${name}-${k + 1}`;
    return {
      id: name,
      name,
      types: members,
      entities: members.filter((n) => role(n) === 'entity').map((n) => types.get(n)!.name),
      endpoints: members.flatMap((n) => ctx.endpointsOf.get(n) ?? []),
      lines: members.reduce((s, n) => s + types.get(n)!.lines, 0),
    };
  }).sort((a, b) => b.lines - a.lines);
  const serviceOf = new Map(services.flatMap((s) => s.types.map((n) => [n, s.id] as const)));

  // Зависимости между сервисами и метрики разреза.
  const deps = new Map<string, ServiceDependency>();
  let internal = 0;
  let cross = 0;
  for (const [a, row] of g.out) {
    for (const [b, w] of row) {
      const sa = serviceOf.get(a);
      const sb = serviceOf.get(b);
      if (!sa || !sb) continue;
      if (sa === sb) {
        internal += w;
        continue;
      }
      cross += w;
      const key = `${sa}->${sb}`;
      const d = deps.get(key) ?? { from: sa, to: sb, weight: 0, calls: [] };
      d.weight += w;
      for (const c of g.calls.get(a)?.get(b) ?? []) if (d.calls.length < 30 && !d.calls.includes(c)) d.calls.push(c);
      deps.set(key, d);
    }
  }
  const dependencies = [...deps.values()].sort((a, b) => b.weight - a.weight);

  // Модулярность по неориентированному графу назначенных классов.
  let m2 = 0;
  const degree = new Map<string, number>();
  for (const [a, row] of g.und) {
    if (!serviceOf.has(a)) continue;
    for (const [b, w] of row) {
      if (!serviceOf.has(b)) continue;
      m2 += w;
      degree.set(a, (degree.get(a) ?? 0) + w);
    }
  }
  let modularity = 0;
  if (m2 > 0) {
    for (const s of services) {
      let inner = 0;
      let deg = 0;
      for (const a of s.types) {
        deg += degree.get(a) ?? 0;
        for (const [b, w] of g.und.get(a) ?? []) if (serviceOf.get(b) === s.id) inner += w;
      }
      modularity += inner / m2 - (deg / m2) ** 2;
    }
  }

  const sharedEntities: DecompositionMetrics['sharedEntities'] = [];
  for (const s of services) {
    for (const n of s.types.filter((x) => role(x) === 'entity')) {
      const usedBy = new Set<string>();
      for (const [m, row] of g.out) {
        const sm = serviceOf.get(m);
        if (row.has(n) && sm && sm !== s.id) usedBy.add(sm);
      }
      if (usedBy.size) sharedEntities.push({ entity: types.get(n)!.name, owner: s.id, usedBy: [...usedBy] });
    }
  }

  // Транзакции, агрегаты которых разошлись по разным сервисам, становятся распределёнными.
  const distributed = ctx.transactions
    .map((t) => ({ t, services: [...new Set(t.aggregates.map((a) => serviceOf.get(a)).filter((x): x is string => !!x))] }))
    .filter((x) => x.services.length >= 2);

  const data = splitData(services, serviceOf, ctx);
  const foreignWrites = data.shared.filter((t) => t.users.some((u) => u.writes > 0));

  const totalLines = services.reduce((s, x) => s + x.lines, 0) || 1;
  const metrics: DecompositionMetrics = {
    services: services.length,
    cohesion: internal + cross ? internal / (internal + cross) : 1,
    modularity,
    crossWeight: cross,
    cycles: cycles(services.map((s) => s.id), dependencies),
    sharedEntities,
    largestShare: services[0].lines / totalLines,
    distributedTransactions: distributed.length,
    sharedTables: data.shared.length,
  };

  const score = Math.max(0, Math.min(100, Math.round(
    50 * metrics.cohesion + 50 * Math.min(1, Math.max(0, modularity) / 0.6)
    - 12 * metrics.cycles.length - 5 * sharedEntities.length - (metrics.largestShare > 0.7 ? 20 : 0)
    - Math.min(18, 6 * distributed.length) - Math.min(12, 4 * foreignWrites.length) - Math.min(12, 4 * data.joins.length),
  )));

  const pros: string[] = [];
  const cons: string[] = [];
  if (!metrics.cycles.length) pros.push('Нет циклических зависимостей между сервисами: их можно выкатывать по очереди');
  for (const c of metrics.cycles) cons.push(`Цикл ${c.join(' → ')} → ${c[0]}: вызовы в обе стороны, сервисы придётся менять и выкатывать вместе`);
  if (metrics.cohesion >= 0.8) pros.push(`${pct(metrics.cohesion)} связей остаются внутри сервисов`);
  else if (metrics.cohesion < 0.6) cons.push(`Через границы проходит ${pct(1 - metrics.cohesion)} связей — много сетевых вызовов`);
  if (!sharedEntities.length && services.some((s) => s.entities.length)) pros.push('Каждая сущность принадлежит одному сервису — отдельная БД на сервис без общих таблиц');
  for (const e of sharedEntities.slice(0, 4)) cons.push(`Сущность ${e.entity} (${e.owner}) нужна ещё ${e.usedBy.join(', ')} — понадобится API, событие или копия данных`);
  if (sharedEntities.length > 4) cons.push(`…и ещё ${sharedEntities.length - 4} общих сущностей`);
  for (const d of distributed.slice(0, 3)) cons.push(`Транзакция ${d.t.label} разойдётся по ${d.services.join(', ')} — понадобится сага или outbox`);
  if (distributed.length > 3) cons.push(`…и ещё ${distributed.length - 3} распределённых транзакций`);
  if (!distributed.length && ctx.transactions.length) pros.push('Транзакции через несколько агрегатов остаются внутри одного сервиса');
  const hasTables = Object.values(data.services).some((ss) => ss.some((x) => x.tables.length));
  if (hasTables && !data.shared.length && !data.joins.length) pros.push('Таблицы делятся без пересечений: у каждого сервиса своя база, чужие таблицы никто не читает');
  for (const t of data.shared.slice(0, 4)) {
    const who = t.users.map((u) => `${u.service} (${u.writes ? `запись ${u.writes}` : `чтение ${u.reads}`})`).join(', ');
    cons.push(`Таблица ${t.table} уходит в ${t.owner}, но с ней работают ${who} — ${t.users.some((u) => u.writes) ? 'записи нужно перевести на API владельца' : 'нужен API владельца или копия данных по событиям'}`);
  }
  if (data.shared.length > 4) cons.push(`…и ещё ${data.shared.length - 4} общих таблиц`);
  for (const j of data.joins.slice(0, 3)) cons.push(`${j.type}: запрос соединяет ${j.tables.join(', ')} из ${j.services.join(' и ')} — одним SQL после разделения не выполнить`);
  if (data.joins.length > 3) cons.push(`…и ещё ${data.joins.length - 3} запросов через границы`);
  if (metrics.largestShare > 0.7) cons.push(`${services[0].name} содержит ${pct(metrics.largestShare)} кода — разделение почти ничего не отделяет`);
  else if (services.length >= 2 && metrics.largestShare < 0.5) pros.push('Сервисы сопоставимы по размеру');
  if (shared.length) cons.push(`Общий модуль из ${shared.length} классов (DTO, исключения) — его версии придётся согласовывать между сервисами`);
  const tiny = services.filter((s) => s.types.length <= 2);
  if (tiny.length) cons.push(`Слишком мелкие сервисы: ${tiny.map((s) => s.name).join(', ')} — накладные расходы на деплой больше пользы`);

  return { id, title, description, services, shared, dependencies, metrics, data, score, pros, cons, recommended: false };
}

// ---------- Точка входа ----------

export function decompose(files: SourceFile[], analysis: AnalyzeResult, appId: string | null): DecompositionResult {
  const { apps } = analysis.architecture;
  const services = apps.filter((a) => a.kind === 'service');
  // По умолчанию — самое крупное запускаемое приложение (монолит, который режем).
  const app = appId ? apps.find((a) => a.id === appId) : apps.length > 1 ? [...(services.length ? services : apps)].sort((a, b) => b.files.length - a.files.length)[0] : undefined;
  const scopeFiles = app ? new Set(app.files) : null;
  const sources = new Map(files.map((f) => [f.path, f.content]));
  const notes: string[] = [];

  // Вложенные типы считаются частью внешнего: делятся только файлы верхнего уровня.
  const all = analysis.types.filter((t) => !scopeFiles || scopeFiles.has(t.file));
  const topOf = (t: TypeInfo): TypeInfo => {
    let cur = t;
    while (cur.outer) cur = all.find((x) => x.file === cur.file && x.name === cur.outer) ?? { ...cur, outer: undefined };
    return cur;
  };
  const top = all.filter((t) => !t.outer);
  const keyOf = new Map(all.map((t) => [t, typeKey(topOf(t))] as const));

  const types = new Map<string, DecompositionType>();
  for (const t of top) {
    const src = sources.get(t.file) ?? '';
    const text = src.slice(t.range.start, t.range.end);
    const header = text.slice(0, Math.max(0, text.indexOf('{')) || text.length);
    types.set(typeKey(t), { key: typeKey(t), name: t.name, file: t.file, role: roleOf(t, header, text), lines: t.range.endLine - t.range.startLine + 1 });
  }

  // Разрешение простого имени типа внутри приложения.
  const byName = new Map<string, string>();
  for (const t of all) byName.set(t.name.split('.').pop()!, keyOf.get(t)!);
  const refs = (text: string | undefined) => [...new Set(identifiers(text ?? '').map((n) => byName.get(n)).filter((k): k is string => !!k))];

  const g: Graph = { nodes: [...types.keys()], out: new Map(), und: new Map(), calls: new Map() };
  const link = (a: string, b: string, w: number) => {
    if (a === b) return;
    bump(g.out, a, b, w);
    bump(g.und, a, b, w);
    bump(g.und, b, a, w);
  };
  const methodType = new Map<string, { key: string; label: string }>();
  for (const t of all) {
    const k = keyOf.get(t)!;
    const src = sources.get(t.file) ?? '';
    const text = src.slice(t.range.start, t.range.end);
    const header = text.slice(0, Math.max(0, text.indexOf('{')) || text.length).replace(/^[\s\S]*?\b(class|interface|enum|record)\b/, '');
    for (const r of refs(header)) link(k, r, W.header);
    for (const f of t.fields) for (const r of refs(f.type)) link(k, r, W.field);
    for (const m of t.methods) {
      // Вызов из лямбды подписываем её методом: границу пересекает именно он.
      let owner = m;
      while (owner.parentId) owner = t.methods.find((x) => x.id === owner.parentId) ?? { ...owner, parentId: undefined };
      methodType.set(m.id, { key: k, label: `${t.name}#${owner.signature}` });
      for (const r of refs([m.returnType, ...m.params.map((p) => p.type)].join(' '))) link(k, r, W.signature);
    }
  }
  for (const c of analysis.callGraph) {
    if (c.kind === 'lambda') continue;
    const a = methodType.get(c.from);
    const b = methodType.get(c.to);
    if (!a || !b || a.key === b.key) continue;
    link(a.key, b.key, W.call);
    const row = g.calls.get(a.key) ?? new Map<string, string[]>();
    row.set(b.key, [...(row.get(b.key) ?? []), `${a.label} → ${b.label}`]);
    g.calls.set(a.key, row);
  }

  const role = new Map([...types].map(([k, t]) => [k, t.role]));
  const infra = g.nodes.filter((n) => role.get(n) === 'config');
  const isolated = g.nodes.filter((n) => role.get(n) !== 'config' && !(g.und.get(n)?.size));
  const domain = g.nodes.filter((n) => role.get(n) !== 'config' && g.und.get(n)?.size);

  const endpointsOf = new Map<string, string[]>();
  for (const a of app ? [app] : apps) {
    for (const e of a.endpoints) {
      const k = e.methodId ? methodType.get(e.methodId)?.key : undefined;
      if (k) endpointsOf.set(k, [...(endpointsOf.get(k) ?? []), `${e.method} ${e.path}`]);
    }
  }
  // Агрегаты: сущность и то, чем она владеет (@OneToMany, @OneToOne, @Embedded, @ElementCollection).
  const entities = domain.filter((n) => role.get(n) === 'entity');
  const parent = new Map(entities.map((e) => [e, e]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const t of top.filter((x) => parent.has(typeKey(x)))) {
    const src = sources.get(t.file) ?? '';
    for (const f of t.fields) {
      if (!/@(OneToMany|OneToOne|Embedded|ElementCollection)\b/.test(src.slice(f.range.start, f.range.end))) continue;
      for (const r of refs(f.type)) if (parent.has(r)) parent.set(find(r), find(typeKey(t)));
    }
  }
  const aggregateOf = new Map(entities.map((e) => [e, find(e)]));

  const { bottlenecks, transactions } = findBottlenecks({
    types, infos: new Map(top.map((t) => [typeKey(t), t])), out: g.out, calls: g.calls, stemOf: (k) => stem(types.get(k)?.name ?? k),
    aggregateOf, refs, sources, analysis, methodType, endpoints: (app ? [app] : apps).flatMap((a) => a.endpoints),
  });
  const access = analysis.architecture.access.filter((a) => !scopeFiles || scopeFiles.has(a.file));
  const ctx: Context = { g, types, endpointsOf, transactions, access, stores: analysis.architecture.stores };
  const nameOfType = (n: string) => types.get(n)!.name;
  // Имя сервиса — по главному классу: сущность, затем контроллер, сервис, прочие.
  const rank: Record<TypeRole, number> = { entity: 6, controller: 5, listener: 4, service: 4, repository: 3, other: 2, dto: 1, config: 0 };
  const dominantStem = (members: string[]) => {
    const score = new Map<string, number>();
    for (const n of members) {
      const s = stem(nameOfType(n));
      score.set(s, (score.get(s) ?? 0) + rank[role.get(n)!] + (g.und.get(n)?.size ?? 0) * 0.1);
    }
    return [...score].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'part';
  };
  const variants: DecompositionVariant[] = [];
  const push = (v: DecompositionVariant | null, reason: string) => {
    if (v) variants.push(v);
    else notes.push(reason);
  };

  if (domain.length < MIN_DOMAIN) {
    notes.push(`В ${app?.name ?? 'проекте'} связанных классов ${domain.length} (без конфигурации) — приложение уже размером с микросервис, делить нечего.`);
    return { appId: app?.id ?? null, appName: app?.name ?? 'Проект', types: [...types.values()], edges: [], access: [], infra, isolated, variants, bottlenecks, notes };
  }

  // 1. По сущностям: агрегат = сущность и то, чем она владеет (@OneToMany, @Embedded, @ElementCollection).
  if (entities.length >= 2) {
    const seed: Assignment = new Map(aggregateOf);
    const entityByStem = new Map(entities.map((e) => [nameOfType(e), find(e)]));
    for (const n of domain) {
      if (seed.has(n)) continue;
      const r = role.get(n);
      // Репозиторий принадлежит сущности из своих generic-аргументов, остальные — по доменному имени.
      const owner = r === 'repository'
        ? [...(g.out.get(n) ?? [])].map(([m]) => m).find((m) => seed.has(m) && role.get(m) === 'entity')
        : undefined;
      const byStem = entityByStem.get(stem(nameOfType(n)));
      const grp = owner ? seed.get(owner) : byStem;
      if (grp) seed.set(n, grp);
    }
    push(
      buildVariant('entities', 'По сущностям', 'Сервис на агрегат данных: сущность, её репозиторий и логика вокруг неё. Классический Database per service.', grow(seed, g, domain), ctx,
        (_, root) => nameOfType(root)),
      'Вариант «по сущностям» не дал двух сервисов: все сущности связаны владением.',
    );
  } else notes.push(`Вариант «по сущностям» не предложен: сущностей @Entity в коде ${entities.length}, нужно хотя бы 2.`);

  // 2. По точкам входа: контроллеры и слушатели с общим доменным именем — один сервис.
  const entries = domain.filter((n) => role.get(n) === 'controller' || role.get(n) === 'listener');
  const entrySeed: Assignment = new Map(entries.map((n) => [n, stem(nameOfType(n))]));
  if (new Set(entrySeed.values()).size >= 2) {
    push(
      buildVariant('api', 'По API', 'Сервис на группу эндпоинтов и слушателей с общим доменным именем; остальной код уходит туда, откуда его чаще вызывают.', grow(entrySeed, g, domain), ctx,
        (_, group) => group),
      'Вариант «по API» не дал двух сервисов.',
    );
  } else notes.push('Вариант «по API» не предложен: нужно хотя бы две группы контроллеров или слушателей с разными именами.');

  // Классы с общим доменным именем (UserProfile, UserProfileController, UserProfileService…) кластеризуются как одно целое:
  // иначе алгоритм режет по слоям — контроллер в одном сервисе, его сервис и репозиторий в другом.
  const louvainByStem = (nodes: string[], res: number): Assignment => {
    const stemOf = new Map(nodes.map((n) => [n, stem(nameOfType(n))]));
    const und: Graph['und'] = new Map();
    for (const n of nodes) for (const [m, w] of g.und.get(n) ?? []) {
      const a = stemOf.get(n);
      const b = stemOf.get(m);
      if (a && b && a !== b) bump(und, a, b, w);
    }
    const byStem = louvain([...new Set(stemOf.values())], und, res);
    return new Map(nodes.map((n) => [n, byStem.get(stemOf.get(n)!)!]));
  };

  // 3–4. По связности: сообщества графа зависимостей (Louvain) с обычным и пониженным разрешением.
  for (const [id, title, res, desc] of [
    ['cohesion', 'По связности', 1, 'Кластеры графа зависимостей (алгоритм Louvain): внутри сервиса классы связаны плотно, между сервисами — слабо.'],
    ['cohesion-coarse', 'Крупные сервисы', 0.5, 'Тот же алгоритм с пониженным разрешением: меньше сервисов, меньше сетевых вызовов.'],
  ] as const) {
    push(
      buildVariant(id, title, desc, absorbSmall(louvainByStem(domain, res), g, role), ctx, dominantStem),
      `Вариант «${title.toLowerCase()}» не дал двух сервисов: граф связан слишком плотно.`,
    );
  }

  // 5. По пакетам — только если пакеты разбиты по функциям, а не по слоям.
  const pkgOf = (n: string) => {
    const t = top.find((x) => typeKey(x) === n)!;
    return t.binaryName.slice(0, Math.max(0, t.binaryName.length - t.name.length - 1)).split('.');
  };
  const pkgs = domain.map(pkgOf);
  let prefix = 0;
  while (pkgs.every((p) => p.length > prefix && p[prefix] === pkgs[0][prefix])) prefix++;
  const segments = new Set(pkgs.map((p) => p[prefix]).filter(Boolean));
  if (segments.size < 2) notes.push('Вариант «по пакетам» не предложен: классы лежат в одном пакете.');
  else if ([...segments].filter((s) => LAYER_PACKAGES.has(s)).length >= segments.size / 2) {
    notes.push(`Вариант «по пакетам» не предложен: пакеты разбиты по слоям (${[...segments].join(', ')}). Такое разделение даёт распределённый монолит — каждый запрос проходит через все сервисы.`);
  } else {
    const seed: Assignment = new Map(domain.map((n, i) => [n, pkgs[i][prefix] ?? '']).filter(([, s]) => s && !LAYER_PACKAGES.has(s)) as [string, string][]);
    push(
      buildVariant('packages', 'По пакетам', 'Сервис на функциональный пакет — так, как код уже разложен разработчиками.', grow(seed, g, domain), ctx,
        (_, segment) => segment),
      'Вариант «по пакетам» не дал двух сервисов.',
    );
  }

  // Одинаковые разбиения разными способами показываем один раз.
  const signature = (v: DecompositionVariant) => v.services.map((s) => [...s.types].sort().join(',')).sort().join('|');
  const unique = variants.filter((v, i) => {
    const dup = variants.findIndex((x) => signature(x) === signature(v));
    if (dup !== i) notes.push(`Вариант «${v.title}» совпал с «${variants[dup].title}».`);
    return dup === i;
  });
  unique.sort((a, b) => b.score - a.score);
  if (unique[0]) unique[0].recommended = true;

  const edges = [...g.out].flatMap(([source, row]) => [...row].map(([target, weight]) => ({ source, target, weight })));
  return { appId: app?.id ?? null, appName: app?.name ?? 'Проект', types: [...types.values()], edges, access, infra, isolated, variants: unique, bottlenecks, notes };
}
