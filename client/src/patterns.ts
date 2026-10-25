import type { PatternId } from '../../shared/types.ts';

/** Справка по паттерну: зачем он, когда уместен, как выглядит до и после. */
export interface PatternHelp {
  name: string;
  /** Семейство по GoF. */
  family: 'Порождающий' | 'Структурный' | 'Поведенческий' | 'Рефакторинг';
  intent: string;
  when: string[];
  avoid: string;
  before: string;
  after: string;
}

export const PATTERNS: Record<PatternId, PatternHelp> = {
  singleton: {
    name: 'Singleton',
    family: 'Порождающий',
    intent: 'Гарантирует, что у класса один экземпляр, и даёт к нему глобальную точку доступа.',
    when: ['Объект действительно один на всю программу: конфигурация, реестр, пул соединений.', 'Создавать его дорого, и нужен он не всегда — ленивая инициализация.'],
    avoid: 'Это глобальное состояние: его трудно подменить в тестах. Если экземпляр можно передать параметром или через конструктор — лучше передать.',
    before: `static Registry get() {
    if (instance == null)        // два потока могут
        instance = new Registry(); // создать два объекта
    return instance;
}`,
    after: `private static class Holder {
    static final Registry INSTANCE = new Registry();
}
static Registry get() { return Holder.INSTANCE; }
// или: enum Registry { INSTANCE; … }`,
  },
  builder: {
    name: 'Builder',
    family: 'Порождающий',
    intent: 'Собирает сложный объект по шагам с именованными параметрами вместо длинного конструктора.',
    when: ['У конструктора 5+ параметров, часть необязательна.', 'Несколько перегруженных конструкторов для разных наборов полей.', 'Объект должен быть неизменяемым, но собирается постепенно.'],
    avoid: 'Для 2–3 обязательных параметров Builder — лишний код; хватит конструктора или record.',
    before: `new Order("A-1", "Ivan", 120.0, "Moscow", true, 3);
// что здесь true и 3?`,
    after: `Order.builder()
    .id("A-1").customer("Ivan").total(120.0)
    .city("Moscow").express(true).items(3)
    .build();`,
  },
  factory: {
    name: 'Factory Method',
    family: 'Порождающий',
    intent: 'Выносит выбор и создание конкретного класса в один метод; вызывающий код работает с общим интерфейсом.',
    when: ['В нескольких местах по условию создаётся один из родственных классов.', 'Набор вариантов будет расти, и добавлять их надо в одном месте.'],
    avoid: 'Если вариант всего один и не меняется — фабрика только добавит косвенность.',
    before: `Discount d;
if (code.equals("TEN")) d = new Percent(10);
else if (code.equals("VIP")) d = new Vip();
else d = new NoDiscount();`,
    after: `static Discount discountFor(String code) {
    return switch (code) {
        case "TEN" -> new Percent(10);
        case "VIP" -> new Vip();
        default -> new NoDiscount();
    };
}`,
  },
  strategy: {
    name: 'Strategy',
    family: 'Поведенческий',
    intent: 'Каждый вариант алгоритма — отдельный класс с общим интерфейсом; нужный выбирается или подставляется во время работы.',
    when: ['switch или цепочка if по типу/коду повторяется и разрастается.', 'Ветки длинные и независимы друг от друга.', 'Проверки instanceof — признак того, что поведение должно жить в самих типах.'],
    avoid: 'Короткое сопоставление «значение → значение» (код → название) проще оставить switch или Map.',
    before: `switch (kind) {
    case "air":  return 10 + w * 3;
    case "sea":  return 2 + w;
    case "road": return 5 + w * 1.5;
}`,
    after: `interface Shipping { double cost(double w); }
static final Map<String, Shipping> BY_KIND = Map.of(
    "air",  w -> 10 + w * 3,
    "sea",  w -> 2 + w,
    "road", w -> 5 + w * 1.5);
return BY_KIND.get(kind).cost(w);`,
  },
  observer: {
    name: 'Observer',
    family: 'Поведенческий',
    intent: 'Издатель хранит список подписчиков и уведомляет их о событиях, не зная их конкретных классов.',
    when: ['Одно событие должно запускать несколько независимых реакций.', 'Набор реакций меняется во время работы или расширяется модулями.'],
    avoid: 'Порядок уведомлений и исключения в подписчиках легко упустить; цепочка событий затрудняет отладку.',
    before: `void place(Order o) {
    save(o);
    mailer.send(o);
    stats.count(o);   // каждая реакция — правка place()
}`,
    after: `interface OrderListener { void onPlaced(Order o); }
private final List<OrderListener> listeners = new ArrayList<>();
void place(Order o) {
    save(o);
    for (OrderListener l : listeners) l.onPlaced(o);
}`,
  },
  decorator: {
    name: 'Decorator',
    family: 'Структурный',
    intent: 'Оборачивает объект тем же интерфейсом и добавляет поведение до или после вызова — без наследования.',
    when: ['Нужно комбинировать добавки: логирование, кеш, повтор, проверка прав.', 'Наследование дало бы взрыв подклассов на каждую комбинацию.'],
    avoid: 'Глубокие цепочки обёрток трудно читать в стектрейсе; одна добавка — может хватить простого метода.',
    before: `class LoggedCachedRepo extends CachedRepo { … }
class LoggedRepo extends Repo { … }`,
    after: `Repo repo = new Logged(new Cached(new DbRepo()));
class Logged implements Repo {
    private final Repo inner;
    public Item find(int id) { log(id); return inner.find(id); }
}`,
  },
  'template-method': {
    name: 'Template Method',
    family: 'Поведенческий',
    intent: 'Базовый класс задаёт порядок шагов алгоритма, а подклассы реализуют отдельные шаги.',
    when: ['Несколько классов выполняют один и тот же сценарий с разными деталями.', 'Порядок шагов важен и не должен нарушаться подклассами.'],
    avoid: 'Жёсткая связь через наследование; если шаги независимы — Strategy с композицией гибче.',
    before: `String pdf() { return head() + pdfBody() + foot(); }
String html() { return head() + htmlBody() + foot(); }`,
    after: `abstract class Report {
    final String render() { return head() + body() + foot(); }
    abstract String body();
}`,
  },
  command: {
    name: 'Command',
    family: 'Поведенческий',
    intent: 'Действие — объект: его можно передать, поставить в очередь, отложить, повторить или отменить.',
    when: ['Нужны отмена/повтор, очередь задач, журнал действий.', 'Вызывающий код не должен знать, что именно выполняется.'],
    avoid: 'Для одного прямого вызова команда — лишний класс; хватит лямбды или ссылки на метод.',
    before: `if (btn == SAVE) doc.save();
else if (btn == PRINT) printer.print(doc);`,
    after: `interface Command { void execute(); }
Map<Button, Command> actions = Map.of(
    SAVE,  doc::save,
    PRINT, () -> printer.print(doc));
actions.get(btn).execute();`,
  },
  'extract-class': {
    name: 'Extract Class',
    family: 'Рефакторинг',
    intent: 'Большой класс делится на несколько по обязанностям: каждая группа связанных полей и методов — свой класс.',
    when: ['Класс на сотни строк и десятки методов.', 'Группы методов работают с разными полями и почти не вызывают друг друга.', 'Изменения разных задач постоянно задевают один файл.'],
    avoid: 'Сильно связанные методы при разделении начнут обращаться друг к другу через объекты — сначала посмотрите план.',
    before: `class Main {          // 1000 строк
    // заказы, расчёт цен, уведомления, отчёты
}`,
    after: `class Main { final MainOrders orders = new MainOrders(this); … }
class MainOrders { … }
class MainPricing { … }
class MainNotifier { … }`,
  },
};
