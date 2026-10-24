import type { AnalyzeResult, Bottleneck, BottleneckEvidence, DecompositionType, Endpoint, Range, Severity, TypeInfo, TypeRole } from '../../shared/types.ts';
import { plural } from './analyzer.ts';

// Узкие места монолита. Два вида:
// — структурные: мешают распилу (god-классы, центральные зависимости, общие таблицы, циклы, транзакции через агрегаты);
// — нагрузочные: эндпоинты, на пути которых найдены запросы в цикле, сетевые вызовы в транзакции и т. п.

export interface BottleneckInput {
  types: Map<string, DecompositionType>;
  /** TypeInfo верхнего уровня по ключу. */
  infos: Map<string, TypeInfo>;
  out: Map<string, Map<string, number>>;
  calls: Map<string, Map<string, string[]>>;
  stemOf: (key: string) => string;
  /** Сущность → корень её агрегата (сущность-владелец). */
  aggregateOf: Map<string, string>;
  /** Разрешение имён типов из текста в ключи классов. */
  refs: (text: string | undefined) => string[];
  sources: Map<string, string>;
  analysis: AnalyzeResult;
  /** id метода → ключ его класса. */
  methodType: Map<string, { key: string; label: string }>;
  endpoints: Endpoint[];
}

/** Транзакция, которая трогает данные нескольких агрегатов. */
export interface TransactionSpan {
  label: string;
  methodId: string;
  /** Корни агрегатов. */
  aggregates: string[];
}

/** Тяжёлые для производительности правила проверок кода. */
const PERF_RULES = new Set([
  'db-call-in-loop', 'remote-call-in-loop', 'lazy-collection-in-loop', 'find-all-in-memory', 'nested-loops', 'linear-search-in-loop',
  'string-concat-in-loop', 'transaction-remote-call', 'synchronized-bean', 'stream-sort-for-min', 'eager-collection',
]);
const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
/** Роли, у которых бывает «логика»: только они могут быть god-классом или центральной зависимостью. */
const LOGIC_ROLES: ReadonlySet<TypeRole> = new Set(['service', 'controller', 'listener', 'other']);

/** Сильно связные компоненты (Тарьян): группы узлов, достижимых друг из друга. Возвращает только компоненты из 2+ узлов. */
export function stronglyConnected(nodes: string[], next: (n: string) => string[]): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  let i = 0;
  const visit = (v: string) => {
    index.set(v, i);
    low.set(v, i++);
    stack.push(v);
    onStack.add(v);
    for (const w of next(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) out.push(scc.reverse());
    }
  };
  for (const n of nodes) if (!index.has(n)) visit(n);
  return out;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const list = (items: string[], max = 4) => (items.length > max ? `${items.slice(0, max).join(', ')} и ещё ${items.length - max}` : items.join(', '));

export function findBottlenecks(input: BottleneckInput): { bottlenecks: Bottleneck[]; transactions: TransactionSpan[] } {
  const { types, infos, out, stemOf, aggregateOf, refs, sources, analysis, methodType } = input;
  const role = (k: string) => types.get(k)?.role;
  const name = (k: string) => types.get(k)?.name ?? k.split(':').pop()!;
  const found: Omit<Bottleneck, 'id'>[] = [];

  // Входящие связи: кто зависит от класса.
  const users = new Map<string, Set<string>>();
  for (const [a, row] of out) for (const b of row.keys()) if (a !== b) users.set(b, (users.get(b) ?? new Set()).add(a));

  // Репозиторий → корень агрегата сущности из его generic-аргументов.
  const repoAggregate = new Map<string, string>();
  for (const [k] of types) {
    if (role(k) !== 'repository') continue;
    const entity = [...(out.get(k) ?? [])].sort((a, b) => b[1] - a[1]).map(([m]) => m).find((m) => aggregateOf.has(m));
    if (entity) repoAggregate.set(k, aggregateOf.get(entity)!);
  }
  const aggregateName = (root: string) => name(root);

  // Методы проекта: корень лямбды, исходник тела, к каким агрегатам метод обращается напрямую через поля-репозитории.
  const methods = new Map(analysis.types.flatMap((t) => t.methods.map((m) => [m.id, m] as const)));
  const rootMethod = (id: string) => {
    let m = methods.get(id);
    while (m?.parentId && methods.has(m.parentId)) m = methods.get(m.parentId);
    return m?.id ?? id;
  };
  const direct = new Map<string, Set<string>>();
  const fieldsByType = new Map<string, { name: string; key: string }[]>();
  for (const [k, t] of infos) fieldsByType.set(k, t.fields.flatMap((f) => refs(f.type).map((r) => ({ name: f.name, key: r }))));
  for (const t of analysis.types) {
    const k = methodType.get(t.methods[0]?.id ?? '')?.key;
    if (!k) continue;
    const fields = fieldsByType.get(k) ?? [];
    for (const m of t.methods) {
      if (m.kind === 'lambda' || !m.bodyRange) continue;
      const body = (sources.get(m.range.file) ?? '').slice(m.bodyRange.start, m.bodyRange.end);
      const aggs = new Set<string>();
      for (const f of fields) {
        const agg = repoAggregate.get(f.key);
        if (agg && new RegExp(`\\b${f.name}\\s*\\.`).test(body)) aggs.add(agg);
      }
      if (aggs.size) direct.set(m.id, aggs);
    }
  }
  const callees = new Map<string, Set<string>>();
  for (const e of analysis.callGraph) {
    const from = rootMethod(e.from);
    if (e.kind === 'lambda') continue;
    callees.set(from, (callees.get(from) ?? new Set()).add(rootMethod(e.to)));
  }
  /** Методы, достижимые из метода по графу вызовов (включая его самого). */
  const reach = (start: string, maxDepth: number) => {
    const seen = new Set([start]);
    let frontier = [start];
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const m of frontier) for (const c of callees.get(m) ?? []) if (!seen.has(c)) {
        seen.add(c);
        next.push(c);
      }
      frontier = next;
    }
    return seen;
  };
  const aggregatesOf = (ms: Iterable<string>) => {
    const s = new Set<string>();
    for (const m of ms) for (const a of direct.get(m) ?? []) s.add(a);
    return s;
  };

  // --- Места в коде: «к коду» выделяет объявление или вызов, а не весь класс ---
  const rangeAt = (file: string, start: number, end: number): Range => {
    const src = sources.get(file) ?? '';
    const lineOf = (o: number) => src.slice(0, o).split('\n').length;
    return { file, start, end, startLine: lineOf(start), endLine: lineOf(end) };
  };
  /** Заголовок до «{»: аннотации и объявление. */
  const head = (r: Range | undefined, bodyStart?: number): Range | undefined => {
    if (!r) return undefined;
    const src = sources.get(r.file) ?? '';
    const brace = bodyStart ?? src.indexOf('{', r.start);
    const end = brace > r.start && brace < r.end ? brace : r.end;
    return rangeAt(r.file, r.start, src.slice(r.start, end).trimEnd().length + r.start);
  };
  const typeHead = (k: string) => head(infos.get(k)?.range);
  const methodHead = (id: string) => {
    const m = methods.get(id);
    return m && head(m.range, m.bodyRange?.start);
  };
  /** Первый вызов из класса a в класс b: место вызова в теле метода, иначе заголовок вызывающего метода. */
  const callSite = (a: string, b: string): Range | undefined => {
    for (const e of analysis.callGraph) {
      if (e.kind === 'lambda' || methodType.get(e.from)?.key !== a || methodType.get(e.to)?.key !== b) continue;
      const from = methods.get(e.from);
      const to = methods.get(e.to);
      if (!from) continue;
      const body = from.bodyRange ?? from.range;
      const src = sources.get(body.file) ?? '';
      const re = new RegExp(`\\b${to?.name ?? ''}\\s*\\(`, 'g');
      re.lastIndex = body.start;
      const hit = to ? re.exec(src) : null;
      if (hit && hit.index < body.end) {
        // Выделяем строку с вызовом без отступа.
        const lineStart = src.lastIndexOf('\n', hit.index) + 1;
        const lineEnd = src.indexOf('\n', hit.index) < 0 ? src.length : src.indexOf('\n', hit.index);
        const line = src.slice(lineStart, lineEnd);
        const start = lineStart + line.length - line.trimStart().length;
        return rangeAt(body.file, start, lineStart + line.trimEnd().length);
      }
      return methodHead(e.from);
    }
    return undefined;
  };
  /** Первое упоминание типа b в теле класса a (поле, параметр, new) — строка без отступа. */
  const refSite = (a: string, b: string): Range | undefined => {
    const t = infos.get(a);
    const target = types.get(b)?.name;
    if (!t || !target) return undefined;
    const src = sources.get(t.file) ?? '';
    const re = new RegExp(`\\b${target}\\b`, 'g');
    re.lastIndex = Math.max(t.range.start, src.indexOf('{', t.range.start) + 1);
    const hit = re.exec(src);
    if (!hit || hit.index >= t.range.end) return undefined;
    const lineStart = src.lastIndexOf('\n', hit.index) + 1;
    const lineEnd = src.indexOf('\n', hit.index) < 0 ? src.length : src.indexOf('\n', hit.index);
    const line = src.slice(lineStart, lineEnd);
    return rangeAt(t.file, lineStart + line.length - line.trimStart().length, lineStart + line.trimEnd().length);
  };
  const siteOf = (a: string, b: string) => callSite(a, b) ?? refSite(a, b);

  // Домен — доменное имя, у которого есть данные или точка входа: Order (OrderController, Order), но не Minio или ImageProcessor.
  const domains = new Set([...types.keys()].filter((k) => ['entity', 'controller', 'listener'].includes(role(k)!)).map(stemOf));

  // --- God-классы: много кода и зависимостей от разных доменов ---
  for (const [k, t] of infos) {
    const r = role(k);
    if (!r || !LOGIC_ROLES.has(r)) continue;
    const own = stemOf(k);
    const depStems = new Set([...(out.get(k)?.keys() ?? [])].filter((m) => role(m) !== 'dto' && role(m) !== 'config').map(stemOf).filter((s) => s !== own));
    const methodCount = t.methods.filter((m) => m.kind === 'method').length;
    const lines = types.get(k)!.lines;
    const big = lines >= 300 || methodCount >= 20;
    const depDomains = [...depStems].filter((s) => domains.has(s));
    if (!(depDomains.length >= 4 || (depDomains.length >= 3 && (big || depStems.size >= 5)))) continue;
    const technical = depStems.size - depDomains.length;
    // Какие методы с каким доменом работают: по вызовам и полям, упомянутым в теле.
    const byStem = new Map<string, Set<string>>();
    const fields = fieldsByType.get(k) ?? [];
    for (const m of t.methods.filter((x) => x.kind === 'method')) {
      const stems = new Set<string>();
      for (const c of callees.get(m.id) ?? []) {
        const ck = methodType.get(c)?.key;
        if (ck && ck !== k) stems.add(stemOf(ck));
      }
      const body = m.bodyRange ? (sources.get(m.range.file) ?? '').slice(m.bodyRange.start, m.bodyRange.end) : '';
      for (const f of fields) if (new RegExp(`\\b${f.name}\\s*\\.`).test(body)) stems.add(stemOf(f.key));
      for (const s of stems) if (depStems.has(s)) byStem.set(s, (byStem.get(s) ?? new Set()).add(m.id));
    }
    found.push({
      kind: 'god-class',
      severity: depDomains.length >= 5 || (lines >= 500 && depDomains.length >= 3) ? 'high' : 'medium',
      title: `God-класс ${t.name}`,
      message: `${plural(lines, 'строка', 'строки', 'строк')}, ${plural(methodCount, 'метод', 'метода', 'методов')}, работает с ${plural(depDomains.length, 'доменом', 'доменами', 'доменами')}: ${list(depDomains, 6)}${technical ? ` и ещё ${plural(technical, 'технической зависимостью', 'техническими зависимостями', 'техническими зависимостями')}` : ''}. Его меняют по любому поводу, а при распиле класс некуда положить целиком.`,
      recommendation: 'Разделите по доменам: методы, работающие с одним доменом, — в отдельный класс рядом с ним. Тогда при распиле каждая часть уйдёт в свой сервис.',
      types: [k],
      evidence: [...byStem].sort((a, b) => b[1].size - a[1].size).map(([s, ms]) => ({
        text: `${s}: ${list([...new Set([...ms].map((id) => methods.get(id)?.name ?? id))], 5)}`,
        range: methodHead([...ms][0]),
      })),
      range: typeHead(k),
    });
  }

  // --- Центральные зависимости: класс с логикой, которым пользуются многие домены ---
  for (const [k, t] of infos) {
    const r = role(k);
    if (!r || !LOGIC_ROLES.has(r) || r === 'controller') continue;
    const own = stemOf(k);
    const from = [...(users.get(k) ?? [])].filter((u) => role(u) !== 'config' && stemOf(u) !== own);
    const stems = new Set(from.map(stemOf));
    if (stems.size < 3) continue;
    const stateless = t.fields.every((f) => f.isStatic);
    found.push({
      kind: 'hub',
      severity: stems.size >= 5 ? 'high' : 'medium',
      title: `Центральная зависимость ${t.name}`,
      message: `${t.name} используют ${plural(from.length, 'класс', 'класса', 'классов')} из ${plural(stems.size, 'модуля', 'модулей', 'модулей')} (${list([...stems], 6)}). После распила каждый из них будет ходить к нему по сети: общая точка отказа и узкое место по нагрузке.`,
      recommendation: stateless
        ? 'У класса нет состояния — вынесите его в общую библиотеку, которую подключит каждый сервис.'
        : 'Разделите обязанности по потребителям или выделите отдельный сервис с узким API и кэшем на стороне клиентов.',
      types: [k, ...from],
      evidence: from.slice(0, 12).map((u): BottleneckEvidence => ({
        text: input.calls.get(u)?.get(k)?.[0] ?? `${name(u)} → ${t.name}`,
        range: siteOf(u, k) ?? typeHead(u),
      })),
      range: typeHead(k),
    });
  }

  // --- Общие данные: агрегат, к которому обращаются классы чужих доменов ---
  const members = new Map<string, string[]>();
  for (const [e, root] of aggregateOf) members.set(root, [...(members.get(root) ?? []), e]);
  for (const [root, ents] of members) {
    const repos = [...repoAggregate].filter(([, a]) => a === root).map(([r]) => r);
    const ownStems = new Set([...ents, ...repos].map(stemOf));
    const inside = new Set([...ents, ...repos]);
    const byStem = new Map<string, Set<string>>();
    for (const target of inside) {
      for (const u of users.get(target) ?? []) {
        const r = role(u);
        if (inside.has(u) || r === 'config' || r === 'dto' || r === 'entity' || ownStems.has(stemOf(u))) continue;
        byStem.set(stemOf(u), (byStem.get(stemOf(u)) ?? new Set()).add(u));
      }
    }
    if (byStem.size < 2) continue;
    found.push({
      kind: 'shared-data',
      severity: byStem.size >= 4 ? 'high' : 'medium',
      title: `Общие данные ${aggregateName(root)}`,
      message: `С таблицами агрегата ${aggregateName(root)}${ents.length > 1 ? ` (${list(ents.map(name))})` : ''} работают ${plural(byStem.size, 'чужой домен', 'чужих домена', 'чужих доменов')}: ${list([...byStem.keys()], 6)}. При распиле это общая БД или синхронизация данных между сервисами.`,
      recommendation: `Назначьте ${aggregateName(root)} одного владельца. Остальные получают данные через его API или события и хранят у себя только нужные поля.`,
      types: [...inside, ...[...byStem.values()].flatMap((s) => [...s])],
      evidence: [...byStem].map(([s, us]) => {
        const first = [...us][0];
        const site = [...inside].map((x) => siteOf(first, x)).find((r) => r);
        return { text: `${s}: ${list([...us].map(name), 5)}`, range: site ?? typeHead(first) };
      }),
      range: typeHead(root),
    });
  }

  // --- Циклы между классами разных доменов ---
  const domainNodes = [...types.keys()].filter((k) => role(k) !== 'config');
  const structural = (k: string) => role(k) === 'entity' || role(k) === 'dto';
  const sccs = stronglyConnected(domainNodes, (n) => [...(out.get(n)?.keys() ?? [])].filter((m) => types.has(m) && role(m) !== 'config' && !(structural(n) && structural(m))));
  for (const scc of sccs) {
    const stems = new Set(scc.map(stemOf));
    if (stems.size < 2) continue;
    const inScc = new Set(scc);
    const evidence: BottleneckEvidence[] = [];
    for (const a of scc) for (const b of out.get(a)?.keys() ?? []) {
      if (!inScc.has(b) || stemOf(a) === stemOf(b)) continue;
      evidence.push({ text: input.calls.get(a)?.get(b)?.[0] ?? `${name(a)} → ${name(b)}`, range: siteOf(a, b) ?? typeHead(a) });
    }
    found.push({
      kind: 'class-cycle',
      severity: stems.size >= 3 ? 'high' : 'medium',
      title: `Цикл между доменами ${list([...stems], 3)}`,
      message: `${plural(scc.length, 'класс', 'класса', 'классов')} зависят друг от друга по кругу: ${list(scc.map(name), 6)}. Разрезать их на разные сервисы нельзя без вызовов в обе стороны.`,
      recommendation: 'Разорвите цикл: обратную зависимость замените событием или интерфейсом в нижнем модуле, либо оставьте эти классы в одном сервисе.',
      types: scc,
      evidence: evidence.slice(0, 10),
      // Главное место — вызов, который замыкает цикл в обратную сторону.
      range: evidence.find((e) => e.range)?.range,
    });
  }

  // --- Транзакции через агрегаты: после распила по данным — распределённая транзакция ---
  const transactions: TransactionSpan[] = [];
  for (const [k, t] of infos) {
    const src = sources.get(t.file) ?? '';
    const text = src.slice(t.range.start, t.range.end);
    const classTx = /@Transactional\b/.test(text.slice(0, Math.max(0, text.indexOf('{'))));
    for (const m of t.methods) {
      if (m.kind !== 'method' || !m.bodyRange) continue;
      if (!classTx && !/@Transactional\b/.test(src.slice(m.range.start, m.bodyRange.start))) continue;
      if (/readOnly\s*=\s*true/.test(src.slice(m.range.start, m.bodyRange.start))) continue;
      const reached = reach(m.id, 4);
      const aggs = [...aggregatesOf(reached)];
      if (aggs.length < 2) continue;
      const label = `${t.name}#${m.signature}`;
      transactions.push({ label, methodId: m.id, aggregates: aggs });
      found.push({
        kind: 'cross-aggregate-tx',
        severity: aggs.length >= 3 ? 'high' : 'medium',
        title: `Транзакция через ${plural(aggs.length, 'агрегат', 'агрегата', 'агрегатов')}`,
        message: `${label} в одной транзакции меняет данные ${list(aggs.map(aggregateName))}. Если эти агрегаты окажутся в разных сервисах, атомарность пропадёт.`,
        recommendation: 'Либо держите эти агрегаты в одном сервисе, либо переделайте на сагу: локальная транзакция + событие через outbox, компенсация при сбое.',
        types: [k, ...aggs],
        evidence: [...reached].filter((x) => direct.has(x)).map((x) => ({
          text: `${methodType.get(x)?.label ?? x}: ${[...direct.get(x)!].map(aggregateName).join(', ')}`,
          range: methodHead(x),
        })),
        range: methodHead(m.id),
        methodId: m.id,
      });
    }
  }

  // --- Тяжёлые эндпоинты: дефекты производительности на пути запроса ---
  const diagsByMethod = new Map<string, typeof analysis.diagnostics>();
  for (const d of analysis.diagnostics) {
    if (!d.methodId || !PERF_RULES.has(d.rule)) continue;
    diagsByMethod.set(d.methodId, [...(diagsByMethod.get(d.methodId) ?? []), d]);
  }
  const hot: (Omit<Bottleneck, 'id'> & { weight: number })[] = [];
  for (const e of input.endpoints) {
    if (!e.methodId) continue;
    const reached = reach(e.methodId, 6);
    const diags = [...reached].flatMap((m) => diagsByMethod.get(m) ?? []);
    const aggs = [...aggregatesOf(reached)];
    if (!diags.length && aggs.length < 3) continue;
    const classes = [...new Set([...reached].map((m) => methodType.get(m)?.key).filter((x): x is string => !!x))];
    const high = diags.filter((d) => d.severity === 'high');
    const byTitle = new Map<string, number>();
    for (const d of diags) byTitle.set(d.title, (byTitle.get(d.title) ?? 0) + 1);
    const summary = [...byTitle].map(([title, n]) => lower(n > 1 ? `${title} ×${n}` : title));
    if (aggs.length >= 3) summary.push(`данные ${plural(aggs.length, 'агрегата', 'агрегатов', 'агрегатов')} (${list(aggs.map(aggregateName))})`);
    hot.push({
      kind: 'hot-endpoint',
      severity: high.length ? 'high' : 'medium',
      title: `${e.method} ${e.path}`,
      message: `На пути запроса ${plural(reached.size, 'метод', 'метода', 'методов')} в ${plural(classes.length, 'классе', 'классах', 'классах')}: ${summary.join('; ')}. Время ответа растёт с объёмом данных.`,
      recommendation: high.length
        ? 'Исправьте запросы в цикле на пути эндпоинта — это главный кандидат на деградацию под нагрузкой. Подробности — в списке проблем на вкладке «Методы».'
        : 'Проверьте профилем под нагрузкой; при распиле этот эндпоинт будет собирать данные из нескольких сервисов — подумайте о проекции (CQRS) или кэше.',
      types: classes.filter((c) => types.has(c)),
      evidence: [
        ...diags.map((d) => ({ text: `${d.title} — ${methodType.get(d.methodId!)?.label ?? d.methodId}:${d.range.startLine}`, range: d.range })),
        ...(aggs.length >= 3
          ? [...reached].filter((x) => direct.has(x)).map((x) => ({ text: `${methodType.get(x)?.label ?? x}: данные ${[...direct.get(x)!].map(aggregateName).join(', ')}`, range: methodHead(x) }))
          : []),
      ],
      range: methodHead(e.methodId) ?? e.range,
      methodId: e.methodId,
      weight: high.length * 3 + diags.length + aggs.length,
    });
  }
  found.push(...hot.sort((a, b) => b.weight - a.weight).slice(0, 10).map(({ weight: _, ...b }) => b));

  const kindOrder = ['hot-endpoint', 'cross-aggregate-tx', 'god-class', 'shared-data', 'hub', 'class-cycle'];
  found.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind));
  return { bottlenecks: found.map((b, i) => ({ id: `b${i}`, ...b })), transactions };
}
