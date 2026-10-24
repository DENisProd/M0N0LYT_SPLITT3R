import type { Node, Tree } from 'web-tree-sitter';
import type { AppInfo, AppLink, Architecture, Endpoint, ExternalNode, LinkCall, LinkKind, SourceFile, TypeInfo } from '../../shared/types.ts';
import { descendants, rangeOf } from './parser.ts';

/*
 * Архитектура микросервисного проекта статически, без конфигурации:
 * границы приложений — по модулям сборки, связи — по коду клиентов и обработчиков.
 *   HTTP:      @RestController/@*Mapping, JAX-RS ↔ @FeignClient, @HttpExchange, RestTemplate, WebClient/RestClient, HttpClient
 *   сообщения: KafkaTemplate/RabbitTemplate/JmsTemplate/StreamBridge ↔ @KafkaListener/@RabbitListener/@JmsListener
 *   код:       import классов из другого модуля (общая библиотека)
 * application.yml не читается, поэтому имя сервиса сверяется с именем модуля и main-класса.
 */

const TYPE_NODES = ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'];
const METHOD_NODES = ['method_declaration', 'constructor_declaration', 'compact_constructor_declaration'];

const packageOf = (content: string) => content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? '';
const hasMain = (content: string) => /static\s+void\s+main\s*\(/.test(content) || /@SpringBootApplication\b/.test(content);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- Границы приложений ----------

/** Корень модуля Maven/Gradle — всё до `src/`; null, если структуры сборки нет. */
function moduleRoot(path: string): string | null {
  const i = path.search(/(^|\/)src\//);
  return i < 0 ? null : path.slice(0, i);
}

interface Group {
  id: string;
  name: string;
  files: SourceFile[];
}

function groupFiles(files: SourceFile[]): Group[] {
  const roots = new Map<string, SourceFile[]>();
  for (const f of files) {
    const root = moduleRoot(f.path) ?? '';
    roots.set(root, [...(roots.get(root) ?? []), f]);
  }
  if (roots.size > 1) {
    return [...roots].map(([root, fs]) => ({ id: root || '.', name: root.split('/').pop() || 'корень проекта', files: fs }));
  }

  // Модулей нет: несколько main-классов в разных пакетах — несколько приложений,
  // файл относится к приложению с самым длинным общим префиксом пакета.
  const mains = files.filter((f) => hasMain(f.content)).map((f) => ({ pkg: packageOf(f.content), file: f }));
  const distinct = new Set(mains.map((m) => m.pkg));
  if (mains.length < 2 || distinct.size < mains.length) {
    const main = mains[0]?.file.path.split('/').pop()?.replace(/\.java$/, '');
    return [{ id: '.', name: main?.replace(/Application$/, '') || 'приложение', files }];
  }
  const groups = new Map<string, Group>(mains.map((m) => [m.pkg, { id: `pkg:${m.pkg}`, name: m.pkg.split('.').pop() || m.pkg, files: [] }]));
  const shared: Group = { id: 'pkg:shared', name: 'общий код', files: [] };
  for (const f of files) {
    const pkg = packageOf(f.content);
    const owner = mains
      .filter((m) => pkg === m.pkg || pkg.startsWith(`${m.pkg}.`))
      .sort((a, b) => b.pkg.length - a.pkg.length)[0];
    (owner ? groups.get(owner.pkg)! : shared).files.push(f);
  }
  return [...groups.values(), ...(shared.files.length ? [shared] : [])];
}

// ---------- Строковые значения ----------

type Consts = Map<string, string>;

/** Значение строкового выражения; неизвестные части (переменные, вызовы) — `{}`. */
function evalString(n: Node | null | undefined, consts: Consts): string | null {
  if (!n) return null;
  switch (n.type) {
    case 'string_literal':
      return n.text.startsWith('"""') ? n.text.slice(3, -3).trim() : n.text.slice(1, -1);
    case 'parenthesized_expression':
      return evalString(n.namedChildren[0], consts);
    case 'identifier':
      return consts.get(n.text) ?? null;
    case 'field_access':
      return consts.get(n.childForFieldName('field')?.text ?? '') ?? null;
    case 'binary_expression': {
      if (n.childForFieldName('operator')?.text !== '+') return null;
      const l = evalString(n.childForFieldName('left'), consts);
      const r = evalString(n.childForFieldName('right'), consts);
      return l === null && r === null ? null : (l ?? '{}') + (r ?? '{}');
    }
    default:
      return null;
  }
}

/** static final String-константы проекта: пути API и имена топиков часто вынесены в них. */
function collectConstants(trees: Tree[]): Consts {
  const consts: Consts = new Map();
  const decls = trees.flatMap((t) => descendants(t.rootNode, ['field_declaration', 'constant_declaration']));
  // Два прохода: константа может ссылаться на объявленную ниже или в другом файле.
  for (let pass = 0; pass < 2; pass++) {
    for (const d of decls) {
      const mods = d.children.find((c) => c?.type === 'modifiers')?.text ?? '';
      if (d.type === 'field_declaration' && !(/\bstatic\b/.test(mods) && /\bfinal\b/.test(mods))) continue;
      if (d.childForFieldName('type')?.text !== 'String') continue;
      for (const v of d.namedChildren.filter((c) => c?.type === 'variable_declarator') as Node[]) {
        const value = evalString(v.childForFieldName('value'), consts);
        const name = v.childForFieldName('name')?.text;
        if (name && value !== null) consts.set(name, value);
      }
    }
  }
  return consts;
}

// ---------- Аннотации ----------

interface Annotation {
  name: string;
  /** Аргументы по ключу; позиционный аргумент — `value`. Массивы раскрыты. */
  args: Map<string, Node[]>;
}

const flatten = (v: Node): Node[] =>
  v.type === 'element_value_array_initializer' ? (v.namedChildren.filter(Boolean) as Node[]).flatMap(flatten) : [v];

function annotationsOf(decl: Node): Annotation[] {
  const mods = decl.children.find((c) => c?.type === 'modifiers');
  if (!mods) return [];
  return (mods.namedChildren.filter((c) => c?.type === 'annotation' || c?.type === 'marker_annotation') as Node[]).map((a) => {
    const args = new Map<string, Node[]>();
    for (const c of a.childForFieldName('arguments')?.namedChildren ?? []) {
      if (!c) continue;
      if (c.type === 'element_value_pair') {
        const value = c.childForFieldName('value');
        if (value) args.set(c.childForFieldName('key')?.text ?? 'value', flatten(value));
      } else if (!c.type.endsWith('comment')) {
        args.set('value', flatten(c));
      }
    }
    return { name: a.childForFieldName('name')?.text.split('.').pop() ?? '', args };
  });
}

const strings = (a: Annotation, keys: string[], consts: Consts) =>
  keys.flatMap((k) => a.args.get(k) ?? []).map((v) => evalString(v, consts)).filter((s): s is string => s !== null);

/** Все строки аннотации, включая вложенные (@QueueBinding(value = @Queue("q"))), кроме служебных ключей. */
function allStrings(a: Annotation, skip: Set<string>, consts: Consts): string[] {
  const out: string[] = [];
  for (const [key, values] of a.args) {
    if (skip.has(key)) continue;
    for (const v of values) {
      const s = evalString(v, consts);
      if (s !== null) out.push(s);
      else out.push(...descendants(v, 'string_literal').map((l) => evalString(l, consts)!).filter((x) => x !== null));
    }
  }
  return out;
}

const SPRING_MAPPINGS: Record<string, string> = {
  RequestMapping: 'ANY', GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
};
const EXCHANGE_MAPPINGS: Record<string, string> = {
  HttpExchange: 'ANY', GetExchange: 'GET', PostExchange: 'POST', PutExchange: 'PUT', DeleteExchange: 'DELETE', PatchExchange: 'PATCH',
};
const JAXRS_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/** HTTP-метод и пути из аннотаций метода (Spring MVC, HTTP Interface, JAX-RS). */
function mappingOf(anns: Annotation[], consts: Consts): { method: string; paths: string[] } | null {
  for (const a of anns) {
    const verb = SPRING_MAPPINGS[a.name] ?? EXCHANGE_MAPPINGS[a.name];
    if (!verb) continue;
    const declared = a.args.get('method')?.[0]?.text.split('.').pop();
    const paths = strings(a, ['value', 'path', 'url'], consts);
    return { method: verb === 'ANY' && declared ? declared : verb, paths: paths.length ? paths : [''] };
  }
  const verb = anns.find((a) => JAXRS_VERBS.has(a.name));
  if (!verb) return null;
  const paths = anns.filter((a) => a.name === 'Path').flatMap((a) => strings(a, ['value'], consts));
  return { method: verb.name, paths: paths.length ? paths : [''] };
}

/** Префикс пути на уровне класса: @RequestMapping("/api"), @Path, @HttpExchange. */
function classPrefixes(anns: Annotation[], consts: Consts): string[] {
  const a = anns.find((x) => x.name === 'RequestMapping' || x.name === 'Path' || x.name === 'HttpExchange');
  const paths = a ? strings(a, ['value', 'path', 'url'], consts) : [];
  return paths.length ? paths : [''];
}

const joinPath = (...parts: string[]) => `/${parts.join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

// ---------- HTTP-адреса ----------

/** Хост и путь адреса; плейсхолдеры `${...}` и неизвестные части — `{}`. */
function splitUrl(url: string): { host: string | null; path: string } {
  const u = url.replace(/\$\{[^}]*\}/g, '{}');
  const m = u.match(/^(?:[a-z][\w+.-]*:)?\/\/([^/{}?#]+)(.*)$/i);
  if (m) return { host: m[1].replace(/:\d+$/, ''), path: (m[2] || '/').split('?')[0] };
  return { host: null, path: (u.startsWith('{}') ? u.slice(2) : u).split('?')[0] };
}

const segments = (path: string) => path.split('/').filter(Boolean);
const isVar = (s: string) => s.includes('{');

function pathMatches(endpoint: Endpoint, method: string, path: string): boolean {
  if (endpoint.method !== 'ANY' && method !== 'ANY' && endpoint.method !== method) return false;
  const a = segments(endpoint.path);
  const b = segments(path);
  return a.length === b.length && a.every((s, i) => s === b[i] || isVar(s) || isVar(b[i]));
}

/** Имя хоста или Feign-клиента — это приложение? order-service ≈ OrderServiceApplication ≈ orders. */
function sameService(name: string, app: AppInfo): boolean {
  const n = norm(name).replace(/service$/, '');
  if (!n) return false;
  const candidates = [app.name, app.mainClass?.replace(/(Application|App)$/, '') ?? ''].map((c) => norm(c).replace(/service$/, ''));
  return candidates.some((c) => !!c && (c === n || c === `${n}s` || `${c}s` === n));
}

// ---------- Построение ----------

interface HttpCall {
  app: string;
  method: string;
  host: string | null;
  path: string;
  call: Omit<LinkCall, 'detail'>;
}

interface Message {
  app: string;
  broker: string;
  keys: string[];
  call: Omit<LinkCall, 'detail'>;
}

const REST_TEMPLATE: Record<string, string> = {
  getForObject: 'GET', getForEntity: 'GET', postForObject: 'POST', postForEntity: 'POST', postForLocation: 'POST',
  put: 'PUT', delete: 'DELETE', patchForObject: 'PATCH', exchange: 'ANY',
};
const CHAIN_VERBS: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH' };
const LISTENERS: Record<string, string> = { KafkaListener: 'Kafka', RabbitListener: 'RabbitMQ', JmsListener: 'JMS', StreamListener: 'Stream' };
const LISTENER_SKIP = new Set(['id', 'groupId', 'containerFactory', 'concurrency', 'ackMode', 'errorHandler', 'autoStartup', 'clientIdPrefix', 'properties']);

/** Имя поля-получателя вызова: this.restTemplate.getForObject → restTemplate. */
const receiverOf = (inv: Node) => inv.childForFieldName('object')?.text.split('.').pop()?.replace(/\(.*$/s, '') ?? '';
const argsOf = (inv: Node) => (inv.childForFieldName('arguments')?.namedChildren.filter(Boolean) as Node[] | undefined) ?? [];

/** Аргумент uri(): строка, URI.create("…") или new URI("…"). */
function uriArg(n: Node | undefined, consts: Consts): string | null {
  if (!n) return null;
  if ((n.type === 'method_invocation' && n.childForFieldName('name')?.text === 'create') || n.type === 'object_creation_expression') {
    return evalString(argsOf(n)[0], consts);
  }
  return evalString(n, consts);
}

export function buildArchitecture(files: SourceFile[], trees: Tree[], types: TypeInfo[]): Architecture {
  const groups = groupFiles(files);
  const appOfFile = new Map<string, string>();
  for (const g of groups) for (const f of g.files) appOfFile.set(f.path, g.id);
  const apps: AppInfo[] = groups.map((g) => {
    const main = g.files.find((f) => hasMain(f.content));
    return {
      id: g.id,
      name: g.name,
      kind: main ? 'service' : 'library',
      files: g.files.map((f) => f.path),
      mainClass: main?.path.split('/').pop()?.replace(/\.java$/, ''),
      endpoints: [],
      listens: [],
    };
  });
  const appById = new Map(apps.map((a) => [a.id, a]));
  const consts = collectConstants(trees);

  // Узел дерева → тип и метод модели: у них общий стартовый offset в файле.
  const typeAt = new Map<string, string>();
  const methodAt = new Map<string, string>();
  for (const t of types) {
    typeAt.set(`${t.file}:${t.range.start}`, t.name);
    for (const m of t.methods) if (m.kind !== 'lambda') methodAt.set(`${m.range.file}:${m.range.start}`, m.id);
  }
  const typeOfMethod = new Map(types.flatMap((t) => t.methods.map((m) => [m.id, t.name] as const)));
  const owners = (n: Node, file: string) => {
    let fromMethodId: string | undefined;
    let fromType: string | undefined;
    for (let p: Node | null = n; p && !fromType; p = p.parent) {
      if (!fromMethodId && METHOD_NODES.includes(p.type)) fromMethodId = methodAt.get(`${file}:${p.startIndex}`);
      if (TYPE_NODES.includes(p.type)) fromType = typeAt.get(`${file}:${p.startIndex}`);
    }
    return { fromMethodId, fromType };
  };

  const httpCalls: HttpCall[] = [];
  const producers: Message[] = [];
  const consumers: Message[] = [];
  const imports: { app: string; qualified: string; call: Omit<LinkCall, 'detail'> }[] = [];

  trees.forEach((tree, i) => {
    const file = files[i].path;
    const app = appOfFile.get(file)!;

    for (const decl of descendants(tree.rootNode, TYPE_NODES)) {
      const typeName = typeAt.get(`${file}:${decl.startIndex}`);
      const anns = annotationsOf(decl);
      const feign = anns.find((a) => a.name === 'FeignClient');
      const isInterface = decl.type === 'interface_declaration';
      // Путь клиента: path у @FeignClient + @RequestMapping интерфейса; у @HttpExchange("http://host/api") — без хоста.
      const feignPaths = feign ? strings(feign, ['path'], consts) : [];
      const prefixes = (feignPaths.length ? feignPaths : ['']).flatMap((fp) => classPrefixes(anns, consts).map((cp) => joinPath(fp, splitUrl(cp).path)));
      const feignHost = feign
        ? strings(feign, ['name', 'value', 'serviceId'], consts)[0] ?? splitUrl(strings(feign, ['url'], consts)[0] ?? '').host
        : null;
      const exchangeHost = splitUrl(anns.find((a) => a.name === 'HttpExchange') ? classPrefixes(anns, consts)[0] : '').host;

      const classListener = anns.find((a) => LISTENERS[a.name]);
      if (classListener) {
        consumers.push({ app, broker: LISTENERS[classListener.name], keys: allStrings(classListener, LISTENER_SKIP, consts), call: { range: rangeOf(decl, file), toType: typeName } });
      }

      for (const m of decl.childForFieldName('body')?.namedChildren ?? []) {
        if (!m || m.type !== 'method_declaration') continue;
        const methodId = methodAt.get(`${file}:${m.startIndex}`);
        const methodAnns = annotationsOf(m);
        const listener = methodAnns.find((a) => LISTENERS[a.name]);
        if (listener) {
          consumers.push({ app, broker: LISTENERS[listener.name], keys: allStrings(listener, LISTENER_SKIP, consts), call: { range: rangeOf(m, file), toMethodId: methodId, toType: typeName } });
        }
        const mapping = mappingOf(methodAnns, consts);
        if (!mapping) continue;
        const paths = prefixes.flatMap((b) => mapping.paths.map((p) => joinPath(b, splitUrl(p).path)));
        if (feign || (isInterface && methodAnns.some((a) => EXCHANGE_MAPPINGS[a.name]))) {
          for (const path of paths) {
            httpCalls.push({ app, method: mapping.method, host: feignHost ?? exchangeHost, path, call: { range: rangeOf(m, file), fromMethodId: methodId, fromType: typeName } });
          }
        } else if (!isInterface) {
          for (const path of paths) appById.get(app)!.endpoints.push({ method: mapping.method, path, methodId, range: rangeOf(m, file) });
        }
      }
    }

    for (const inv of descendants(tree.rootNode, 'method_invocation')) {
      const name = inv.childForFieldName('name')?.text ?? '';
      const receiver = receiverOf(inv);
      const args = argsOf(inv);
      const at = () => ({ range: rangeOf(inv, file), ...owners(inv, file) });

      // HTTP-клиенты
      let url: string | null = null;
      let method = 'ANY';
      if (REST_TEMPLATE[name] && /resttemplate|^rest$|template$/i.test(receiver)) {
        url = evalString(args[0], consts);
        method = name === 'exchange' ? args[1]?.text.match(/HttpMethod\.(\w+)/)?.[1] ?? 'ANY' : REST_TEMPLATE[name];
      } else if (name === 'uri' && /client|web|rest|http|request/i.test(inv.childForFieldName('object')?.text ?? '')) {
        url = uriArg(args[0], consts);
        const prev = inv.childForFieldName('object');
        const verb = prev?.type === 'method_invocation' ? prev.childForFieldName('name')?.text ?? '' : '';
        method = CHAIN_VERBS[verb] ?? (verb === 'method' ? argsOf(prev!)[0]?.text.match(/HttpMethod\.(\w+)/)?.[1] ?? 'ANY' : 'ANY');
      }
      if (url !== null) {
        const { host, path } = splitUrl(url);
        httpCalls.push({ app, method, host, path, call: at() });
        continue;
      }

      // Отправители сообщений
      let broker: string | null = null;
      let keyArgs: Node[] = [];
      if (name === 'send' && /kafka/i.test(receiver)) [broker, keyArgs] = ['Kafka', args.slice(0, 1)];
      else if (name === 'send' && /bridge/i.test(receiver)) [broker, keyArgs] = ['Stream', args.slice(0, 1)];
      else if ((name === 'convertAndSend' || name === 'send') && /rabbit|amqp/i.test(receiver)) [broker, keyArgs] = ['RabbitMQ', args.slice(0, Math.max(1, args.length - 1))];
      else if (name === 'convertAndSend' && /jms/i.test(receiver)) [broker, keyArgs] = ['JMS', args.slice(0, 1)];
      if (broker) {
        const keys = keyArgs.map((a) => evalString(a, consts)).filter((k): k is string => k !== null);
        if (keys.length) producers.push({ app, broker, keys, call: at() });
      }
    }

    const fromType = types.find((t) => t.file === file && !t.outer)?.name;
    for (const imp of descendants(tree.rootNode, 'import_declaration')) {
      const qualified = imp.text.replace(/^import\s+(static\s+)?/, '').replace(/\s*;\s*$/, '').trim();
      imports.push({ app, qualified, call: { range: rangeOf(imp, file), fromType } });
    }
  });

  for (const consumer of consumers) appById.get(consumer.app)!.listens.push(...consumer.keys);

  // ---------- Сопоставление ----------

  const links = new Map<string, AppLink>();
  const externals = new Map<string, ExternalNode>();
  const link = (from: string, to: string, kind: LinkKind, call: LinkCall) => {
    if (from === to) return; // вызов внутри одного приложения — это уровень классов
    const id = `${kind}:${from}->${to}`;
    if (!links.has(id)) links.set(id, { id, from, to, kind, calls: [] });
    links.get(id)!.calls.push(call);
  };
  const external = (kind: ExternalNode['kind'], key: string, label: string) => {
    const id = `ext:${kind}:${key}`;
    if (!externals.has(id)) externals.set(id, { id, kind, label });
    return id;
  };

  for (const c of httpCalls) {
    const detail = `${c.method === 'ANY' ? 'HTTP' : c.method} ${c.path || '/'}`;
    const byHost = c.host ? apps.find((a) => sameService(c.host!, a)) : undefined;
    const candidates = (byHost ? [byHost] : apps.filter((a) => a.id !== c.app))
      .flatMap((a) => a.endpoints.filter((e) => pathMatches(e, c.method, c.path)).map((e) => ({ app: a, e })));
    const targetApps = new Set(candidates.map((x) => x.app.id));
    const target = byHost ?? (targetApps.size === 1 ? candidates[0].app : undefined);
    const handler = candidates.find((x) => x.app.id === target?.id)?.e;
    const to = target?.id ?? external('http', c.host ?? '?', c.host ?? 'HTTP: адрес не определён');
    link(c.app, to, 'http', { detail, ...c.call, toMethodId: handler?.methodId, toType: handler?.methodId ? typeOfMethod.get(handler.methodId) : undefined });
  }

  for (const p of producers) {
    const matched = consumers.filter((c) => c.keys.some((k) => p.keys.includes(k)));
    const key = p.keys.find((k) => matched.some((c) => c.keys.includes(k))) ?? p.keys[p.keys.length - 1];
    const detail = `${p.broker}: ${key}`;
    if (!matched.length) link(p.app, external('messaging', `${p.broker}:${key}`, `${p.broker}: ${key}`), 'messaging', { detail, ...p.call });
    for (const c of matched) link(p.app, c.app, 'messaging', { detail, ...p.call, toMethodId: c.call.toMethodId, toType: c.call.toType });
  }
  // Подписка без отправителя в проекте: сообщения приходят извне.
  for (const c of consumers) {
    for (const key of c.keys.filter((k) => !producers.some((p) => p.keys.includes(k)))) {
      link(external('messaging', `${c.broker}:${key}`, `${c.broker}: ${key}`), c.app, 'messaging', { detail: `${c.broker}: ${key}`, ...c.call });
    }
  }

  // Общий код: импорт класса или пакета, объявленного в другом модуле.
  const typeByQualified = new Map<string, { app: string; type: string }>();
  const appsByPackage = new Map<string, Set<string>>();
  const packageOfFile = new Map(files.map((f) => [f.path, packageOf(f.content)]));
  for (const t of types) {
    const pkg = packageOfFile.get(t.file) ?? '';
    const app = appOfFile.get(t.file)!;
    typeByQualified.set(pkg ? `${pkg}.${t.name}` : t.name, { app, type: t.name });
    appsByPackage.set(pkg, (appsByPackage.get(pkg) ?? new Set()).add(app));
  }
  for (const imp of imports) {
    if (imp.qualified.endsWith('.*')) {
      const pkgApps = [...(appsByPackage.get(imp.qualified.slice(0, -2)) ?? [])].filter((a) => a !== imp.app);
      if (pkgApps.length === 1) link(imp.app, pkgApps[0], 'library', { detail: `import ${imp.qualified}`, ...imp.call });
      continue;
    }
    // import static a.b.Type.CONST → a.b.Type
    const target = typeByQualified.get(imp.qualified) ?? typeByQualified.get(imp.qualified.replace(/\.[^.]+$/, ''));
    if (target) link(imp.app, target.app, 'library', { detail: `import ${imp.qualified}`, ...imp.call, toType: target.type });
  }

  return { apps, externals: [...externals.values()], links: [...links.values()] };
}

/** Вызов по имени допустим внутри приложения и в общую библиотеку — не в чужую JVM. */
export function callScope(architecture: Architecture): (fromFile: string, toFile: string) => boolean {
  const appOf = new Map<string, AppInfo>();
  for (const a of architecture.apps) for (const f of a.files) appOf.set(f, a);
  return (from, to) => {
    const a = appOf.get(from);
    const b = appOf.get(to);
    return !a || !b || a === b || b.kind === 'library';
  };
}
