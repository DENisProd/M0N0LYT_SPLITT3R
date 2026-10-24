import type { Node } from 'web-tree-sitter';
import type { Diagnostic, TypeInfo } from '../../shared/types.ts';
import { declaredTypes, loopDepth } from './analyzer.ts';
import type { MethodNode } from './model.ts';
import { descendants, rangeOf } from './parser.ts';

// Проверки, характерные для Spring/JPA-приложений: обращения к БД и сети в цикле (N+1),
// выборка всей таблицы ради фильтра в памяти, транзакции вокруг сетевых вызовов,
// аннотации, которые не срабатывают из-за вызова мимо прокси. Это типичные узкие места монолита под нагрузкой.

export type PerfDiagnostic = Omit<Diagnostic, 'id'>;

/** Типы, вызов которых — запрос к БД. */
const DB_TYPES = new Set(['EntityManager', 'JdbcTemplate', 'NamedParameterJdbcTemplate', 'MongoTemplate', 'Session', 'JdbcClient', 'R2dbcEntityTemplate']);
/** Типы, вызов которых — сетевой запрос. */
const REMOTE_TYPES = new Set(['RestTemplate', 'WebClient', 'RestClient', 'HttpClient', 'OkHttpClient', 'AsyncHttpClient', 'CloseableHttpClient']);
/** Аннотации, которые Spring исполняет через прокси: при вызове this.method() они не работают. */
const PROXY_ANNOTATIONS = ['Transactional', 'Async', 'Cacheable', 'CacheEvict', 'CachePut', 'Retryable'];
const BEAN_ANNOTATION = /@(Service|Component|RestController|Controller|Repository)\b/;
/** Стадии, после которых ясно, что из всей выборки нужна только часть. */
const NARROWING = new Set(['filter', 'anyMatch', 'allMatch', 'noneMatch', 'findFirst', 'findAny', 'count', 'size', 'max', 'min', 'limit', 'isEmpty']);

const baseType = (t: string | undefined) => t?.replace(/<[\s\S]*$/, '').replace(/\[\]$/, '').split('.').pop()?.trim() ?? '';
const modifiersOf = (n: Node | null | undefined) => n?.namedChildren.find((c) => c?.type === 'modifiers')?.text ?? '';
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Объявление класса, в котором лежит метод. */
function ownerDecl(n: Node): Node | null {
  for (let p = n.parent; p; p = p.parent) {
    if (['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'].includes(p.type)) return p;
  }
  return null;
}

/** Цепочка вызовов a.b().c().d(): корень (a) и первый вызов на нём (b). Для вызова без объекта корня нет. */
function chain(inv: Node): { root: string; first: Node; names: string[] } | null {
  const names: string[] = [];
  let cur: Node = inv;
  for (;;) {
    names.unshift(cur.childForFieldName('name')?.text ?? '');
    const obj = cur.childForFieldName('object');
    if (!obj) return null;
    if (obj.type === 'method_invocation') {
      cur = obj;
      continue;
    }
    const root = obj.text.replace(/^this\./, '');
    return /^\w+$/.test(root) ? { root, first: cur, names } : null;
  }
}

/** Вызов — внешний в цепочке: a.b().c() считается один раз, а не на каждом звене. */
const isOutermost = (inv: Node) => !(inv.parent?.type === 'method_invocation' && inv.parent.childForFieldName('object')?.id === inv.id);

export function perfDiagnostics(methods: MethodNode[], types: TypeInfo[], sources: Map<string, string>): PerfDiagnostic[] {
  const out: PerfDiagnostic[] = [];
  const typeByName = new Map(types.map((t) => [t.name, t]));
  const headerOf = (t: TypeInfo) => {
    const text = (sources.get(t.file) ?? '').slice(t.range.start, t.range.end);
    return text.slice(0, Math.max(0, text.indexOf('{')) || text.length);
  };

  // Репозитории проекта: Spring Data-интерфейсы и классы-DAO.
  const repoTypes = new Set(DB_TYPES);
  for (const t of types) {
    const parents = [t.extends ?? '', ...t.implements].join(' ');
    if (/(Repository|Dao|DAO)$/.test(t.name) || /\b\w*Repository\b/.test(parents) || /@Repository\b/.test(headerOf(t))) repoTypes.add(t.name);
  }
  // Сетевые клиенты: Feign/HttpExchange-интерфейсы и обёртки над RestTemplate/WebClient.
  const remoteTypes = new Set(REMOTE_TYPES);
  for (const t of types) {
    if (/@(FeignClient|HttpExchange)\b/.test(headerOf(t)) || /@(GetExchange|PostExchange|PutExchange|DeleteExchange)\b/.test((sources.get(t.file) ?? '').slice(t.range.start, t.range.end))) remoteTypes.add(t.name);
    else if (t.fields.some((f) => REMOTE_TYPES.has(baseType(f.type)))) remoteTypes.add(t.name);
  }

  // Ленивые коллекции сущностей: order.getItems() в цикле — отдельный SELECT на каждый элемент.
  const lazyGetters = new Map<string, string>();
  for (const t of types) {
    const src = sources.get(t.file) ?? '';
    if (!/@Entity\b/.test(headerOf(t))) continue;
    for (const f of t.fields) {
      const decl = src.slice(f.range.start, f.range.end);
      if (/@(OneToMany|ManyToMany|ElementCollection)\b/.test(decl) && !/FetchType\.EAGER/.test(decl)) lazyGetters.set(`get${capitalize(f.name)}`, `${t.name}.${f.name}`);
      if (/@(OneToMany|ManyToMany)\b/.test(decl) && /FetchType\.EAGER/.test(decl)) {
        out.push({
          rule: 'eager-collection',
          severity: 'medium',
          title: 'Жадная загрузка коллекции',
          message: `${t.name}.${f.name} загружается вместе с каждой ${t.name} (FetchType.EAGER): любой запрос тянет связанные строки, даже если они не нужны.`,
          recommendation: 'Оставьте LAZY (по умолчанию для коллекций) и подгружайте связь там, где она нужна: JOIN FETCH в запросе или @EntityGraph.',
          range: f.range,
        });
      }
    }
  }

  // Методы с аннотациями прокси — по классу.
  const proxied = new Map<string, Map<string, string[]>>();
  for (const m of methods) {
    if (m.info.kind !== 'method') continue;
    const anns = PROXY_ANNOTATIONS.filter((a) => new RegExp(`@${a}\\b`).test(modifiersOf(m.node)));
    if (!anns.length) continue;
    const row = proxied.get(m.info.className) ?? new Map<string, string[]>();
    row.set(m.info.name, anns);
    proxied.set(m.info.className, row);
  }

  for (const m of methods) {
    if (m.info.kind === 'lambda') continue; // тело лямбды проверяется в составе метода
    const { info } = m;
    const file = info.range.file;
    const root = m.body;
    if (!root) continue;
    const vars = declaredTypes(m, typeByName.get(info.className));
    const typeOfVar = (name: string) => baseType(vars.get(name));
    const decl = ownerDecl(m.node);
    const classMods = modifiersOf(decl);
    const methodMods = modifiersOf(m.node);
    const transactional = /@Transactional\b/.test(methodMods) || /@Transactional\b/.test(classMods);
    const report = (d: Omit<PerfDiagnostic, 'methodId'>) => out.push({ ...d, methodId: info.id });
    let remoteCall: string | null = null;

    for (const inv of descendants(root, 'method_invocation')) {
      const name = inv.childForFieldName('name')?.text ?? '';
      const depth = loopDepth(inv, root);

      // Ленивая коллекция в цикле (геттер вне самой сущности).
      if (depth > 0 && lazyGetters.has(name) && inv.childForFieldName('object') && inv.childForFieldName('object')?.text !== 'this') {
        report({
          rule: 'lazy-collection-in-loop',
          severity: 'medium',
          title: 'Ленивая коллекция в цикле',
          message: `${inv.text.replace(/\s+/g, ' ')} в цикле: ${lazyGetters.get(name)} подгружается отдельным SELECT для каждого элемента — классическое N+1.`,
          recommendation: 'Загрузите связь одним запросом: JOIN FETCH, @EntityGraph или @BatchSize на коллекции.',
          range: rangeOf(inv, file),
        });
      }

      if (!isOutermost(inv)) continue;
      const c = chain(inv);
      if (!c) continue;
      const rootType = typeOfVar(c.root);
      const firstName = c.first.childForFieldName('name')?.text ?? '';
      const call = `${c.root}.${firstName}(…)`;
      const isDb = repoTypes.has(rootType);
      const isRemote = remoteTypes.has(rootType);
      if (isRemote) remoteCall ??= call;

      if (depth > 0 && isDb) {
        const recommendation = /^(save|delete|persist|merge|update|insert)/.test(firstName)
          ? `Соберите элементы и сохраните одним вызовом: ${firstName.startsWith('delete') ? 'deleteAll(…)/deleteAllById(…)' : 'saveAll(…)'} — с batch_size в Hibernate это один пакет запросов.`
          : /^(findById|getById|getReferenceById|getOne|findOne)$/.test(firstName)
            ? 'Загрузите всё сразу: findAllById(ids) и Map по id, затем берите из неё в цикле.'
            : 'Один запрос вместо N: условие IN (…), JOIN FETCH или агрегат в SQL.';
        report({
          rule: 'db-call-in-loop',
          severity: 'high',
          title: 'Запрос к БД в цикле (N+1)',
          message: `${call} выполняется на каждой итерации: N запросов к БД вместо одного, время растёт вместе с данными и задержкой сети до БД.`,
          recommendation,
          range: rangeOf(inv, file),
        });
      } else if (depth > 0 && isRemote) {
        report({
          rule: 'remote-call-in-loop',
          severity: 'high',
          title: 'Сетевой вызов в цикле',
          message: `${call} — HTTP-запрос на каждой итерации: задержки складываются, а сбой одного запроса обрывает весь цикл.`,
          recommendation: 'Запросите данные пачкой (эндпоинт со списком id), кэшируйте ответы или выполняйте запросы параллельно с ограничением.',
          range: rangeOf(inv, file),
        });
      }

      // Вся таблица в память ради фильтра или подсчёта.
      if (isDb && firstName === 'findAll' && !c.first.childForFieldName('arguments')?.namedChildCount) {
        const after = c.names.slice(c.names.indexOf('findAll') + 1);
        const narrowed = after.find((x) => NARROWING.has(x));
        const forLoop = inv.parent?.type === 'enhanced_for_statement' && descendants(inv.parent, 'if_statement').length > 0;
        if (narrowed || forLoop) {
          report({
            rule: 'find-all-in-memory',
            severity: 'medium',
            title: 'Вся таблица ради части строк',
            message: `${c.root}.findAll() загружает все строки в память, а затем ${narrowed ? `${narrowed}(…) оставляет` : 'цикл с условием отбирает'} только часть — на больших данных это память и время на каждый запрос.`,
            recommendation: narrowed === 'count' || narrowed === 'size'
              ? 'Считайте в БД: repository.count() или производный запрос countBy…'
              : 'Перенесите условие в запрос: производный метод findBy…/existsBy…, @Query с WHERE или Specification; для списков — Pageable.',
            range: rangeOf(inv, file),
          });
        }
      }

      // Регулярное выражение компилируется на каждой итерации.
      if (depth > 0 && ((c.root === 'Pattern' && firstName === 'compile') || (['matches', 'replaceAll', 'replaceFirst'].includes(firstName) && typeOfVar(c.root) === 'String'))) {
        report({
          rule: 'regex-in-loop',
          severity: 'low',
          title: 'Регулярное выражение в цикле',
          message: `${call} компилирует шаблон заново на каждой итерации.`,
          recommendation: 'Скомпилируйте Pattern один раз в static final поле и используйте pattern.matcher(…).',
          range: rangeOf(inv, file),
        });
      }
    }

    // Самовызов метода с прокси-аннотацией: Spring её не применит.
    const own = proxied.get(info.className);
    if (own) {
      for (const inv of descendants(root, 'method_invocation')) {
        const obj = inv.childForFieldName('object')?.text;
        const name = inv.childForFieldName('name')?.text ?? '';
        const anns = own.get(name);
        if ((obj && obj !== 'this') || !anns || name === info.name) continue;
        const missing = anns.filter((a) => !new RegExp(`@${a}\\b`).test(methodMods));
        if (!missing.length) continue;
        report({
          rule: 'proxy-self-invocation',
          severity: 'medium',
          title: 'Аннотация не сработает',
          message: `${name}(…) помечен @${missing.join(', @')}, но вызывается изнутри класса — мимо прокси Spring, поэтому ${missing.includes('Transactional') ? 'транзакция не откроется' : 'аннотация будет проигнорирована'}.`,
          recommendation: 'Вынесите метод в отдельный бин и вызывайте через него, либо поставьте аннотацию на внешний метод.',
          range: rangeOf(inv, file),
        });
      }
    }

    if (transactional && remoteCall) {
      report({
        rule: 'transaction-remote-call',
        severity: 'medium',
        title: 'Сетевой вызов внутри транзакции',
        message: `${info.name} выполняется в @Transactional и вызывает ${remoteCall}: соединение с БД и блокировки удерживаются всё время, пока идёт HTTP-запрос. Под нагрузкой это исчерпывает пул соединений.`,
        recommendation: 'Сделайте сетевой вызов до или после транзакции, либо отправьте событие после коммита (@TransactionalEventListener, outbox).',
        range: info.range,
      });
    }

    if (/\bsynchronized\b/.test(methodMods) && BEAN_ANNOTATION.test(classMods)) {
      report({
        rule: 'synchronized-bean',
        severity: 'medium',
        title: 'synchronized в бине',
        message: `Бин ${info.className} один на приложение: synchronized ${info.name} выстраивает все параллельные запросы в очередь, и он становится узким местом. С несколькими экземплярами сервиса блокировка к тому же ничего не защищает.`,
        recommendation: 'Уберите общее изменяемое состояние из бина; для данных — блокировка в БД (@Version, SELECT … FOR UPDATE), для счётчиков — атомарные типы.',
        range: info.range,
      });
    }

    for (const creation of descendants(root, 'object_creation_expression')) {
      const type = baseType(creation.childForFieldName('type')?.text);
      if (!['ObjectMapper', 'Gson', 'XmlMapper', 'JAXBContext'].includes(type)) continue;
      const inLoop = loopDepth(creation, root) > 0;
      report({
        rule: 'heavy-object-per-call',
        severity: inLoop ? 'medium' : 'low',
        title: `new ${type}() на каждый вызов`,
        message: `${type} дорого создавать (кэши сериализаторов, рефлексия), а здесь он создаётся ${inLoop ? 'на каждой итерации цикла' : 'при каждом вызове метода'}.`,
        recommendation: `${type} потокобезопасен после настройки: внедрите бин или храните в static final поле.`,
        range: rangeOf(creation, file),
      });
    }

    for (const c of descendants(root, 'catch_clause')) {
      const stmts = c.childForFieldName('body')?.namedChildren.filter((x) => x && !x.type.endsWith('comment')) ?? [];
      const printed = stmts.some((x) => /^\w+\.printStackTrace\(\)\s*;$/.test(x!.text));
      if (!printed || stmts.some((x) => x!.type === 'throw_statement')) continue;
      report({
        rule: 'print-stack-trace',
        severity: 'low',
        title: 'Исключение только печатается',
        message: 'printStackTrace() пишет в stderr мимо логов: в проде ошибку не найти, а выполнение продолжается как ни в чём не бывало.',
        recommendation: 'Залогируйте через логгер с контекстом (log.error("…", e)) и пробросьте или верните понятную ошибку.',
        range: rangeOf(c, file),
      });
    }
  }
  return out;
}
