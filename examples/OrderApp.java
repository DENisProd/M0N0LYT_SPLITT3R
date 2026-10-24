import java.util.*;
import java.util.function.*;
import java.util.stream.*;

/**
 * Демо-монолит: читает заказы из stdin, валидирует, объединяет дубликаты
 * и печатает отчёт со статистикой. Содержит намеренные дефекты для диагностики
 * и использует record, enum, дженерики, лямбды и Stream API.
 *
 * Формат ввода: первая строка N, затем N строк "id;customer;amount".
 */
public class OrderApp {

    static class InvalidOrderException extends Exception {
        InvalidOrderException(String message) {
            super(message);
        }
    }

    static class Order {
        final int id;
        final String customer;
        double amount;

        Order(int id, String customer, double amount) {
            this.id = id;
            this.customer = customer;
            this.amount = amount;
        }

        int id() {
            return id;
        }
    }

    interface Formatter {
        String format(Order order);
    }

    enum Category {
        EMPTY("пусто"), SMALL("мелкий"), MEDIUM("средний"), LARGE("крупный");

        private final String title;

        Category(String title) {
            this.title = title;
        }

        String title() {
            return title;
        }

        static Category of(double amount) {
            if (amount <= 0) {
                return EMPTY;
            }
            if (amount < 100) {
                return SMALL;
            }
            return amount < 1000 ? MEDIUM : LARGE;
        }
    }

    record CustomerTotal(String customer, double total, Category category) {
    }

    record Range<T extends Comparable<T>>(T min, T max) {
        Range {
            if (min.compareTo(max) > 0) {
                throw new IllegalArgumentException("min > max");
            }
        }

        boolean contains(T value) {
            return value.compareTo(min) >= 0 && value.compareTo(max) < 0;
        }
    }

    static <T extends Comparable<T>> T maxOf(List<T> items) {
        T best = null;
        for (T item : items) {
            if (best == null || item.compareTo(best) > 0) {
                best = item;
            }
        }
        return best;
    }

    static <T, R> List<R> mapAll(List<T> items, Function<? super T, ? extends R> mapper) {
        List<R> out = new ArrayList<>();
        for (T item : items) {
            out.add(mapper.apply(item));
        }
        return out;
    }

    static List<Order> select(List<Order> orders, Predicate<Order> rule) {
        List<Order> out = new ArrayList<>();
        orders.stream().filter(rule).forEach(o -> out.add(o));
        return out;
    }

    static Optional<Order> cheapest(List<Order> orders) {
        return orders.stream()
                .sorted(Comparator.comparingDouble(o -> o.amount))
                .findFirst();
    }

    static boolean hasLarge(List<Order> orders) {
        return orders.stream().filter(o -> Category.of(o.amount) == Category.LARGE).count() > 0;
    }

    static long repeatCustomers(List<Order> orders) {
        return orders.stream()
                .filter(a -> orders.stream().filter(b -> b.customer.equals(a.customer)).count() > 1)
                .map(o -> o.customer)
                .distinct()
                .count();
    }

    static List<CustomerTotal> totals(List<Order> orders) {
        Map<String, Double> sums = orders.stream()
                .collect(Collectors.groupingBy(o -> o.customer, TreeMap::new, Collectors.summingDouble(o -> o.amount)));
        return sums.entrySet().stream()
                .map(e -> new CustomerTotal(e.getKey(), e.getValue(), Category.of(e.getValue())))
                .collect(Collectors.toList());
    }

    static Order parseLine(String line) throws InvalidOrderException {
        String[] parts = line.split(";");
        if (parts.length != 3) {
            throw new InvalidOrderException("Неверный формат: " + line);
        }
        try {
            int id = Integer.parseInt(parts[0].trim());
            double amount = Double.parseDouble(parts[2].trim());
            return new Order(id, parts[1].trim(), amount);
        } catch (NumberFormatException e) {
            throw new InvalidOrderException("Не число: " + line);
        }
    }

    static List<Order> mergeDuplicates(List<Order> items) {
        List<Order> result = new ArrayList<>();
        List<Integer> seen = new ArrayList<>();
        for (Order a : items) {
            if (seen.contains(a.id())) {
                continue;
            }
            Order merged = new Order(a.id, a.customer, 0);
            for (Order b : items) {
                if (a.id() == b.id()) {
                    merged.amount += b.amount;
                }
            }
            seen.add(a.id());
            result.add(merged);
        }
        return result;
    }

    static String buildReport(List<Order> orders, Formatter formatter) {
        String report = "";
        for (Order o : orders) {
            report += formatter.format(o) + "\n";
        }
        return report;
    }

    static String category(double amount) {
        if (amount < 0) {
            return "ошибка";
        } else if (amount == 0) {
            return "пусто";
        } else if (amount < 100) {
            return "мелкий";
        } else if (amount < 1000) {
            return "средний";
        }
        return "крупный";
    }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in, "UTF-8");
        if (!in.hasNextLine()) {
            System.out.println("Нет данных");
            return;
        }
        int n;
        try {
            n = Integer.parseInt(in.nextLine().trim());
        } catch (NumberFormatException e) {
            System.err.println("Первая строка должна быть числом");
            System.exit(1);
            return;
        }

        List<Order> orders = new ArrayList<>();
        int errors = 0;
        for (int i = 0; i < n && in.hasNextLine(); i++) {
            try {
                orders.add(parseLine(in.nextLine()));
            } catch (InvalidOrderException e) {
                errors++;
                System.err.println(e.getMessage());
            }
        }

        List<Order> merged = mergeDuplicates(orders);
        merged.sort(Comparator.comparingInt(Order::id));

        Map<String, Double> byCustomer = new TreeMap<>();
        for (Order o : merged) {
            byCustomer.merge(o.customer, o.amount, Double::sum);
        }

        System.out.print(buildReport(merged, o -> String.format("#%d %s %.2f (%s)", o.id, o.customer, o.amount, category(o.amount))));
        System.out.println("--- по клиентам ---");
        for (Map.Entry<String, Double> e : byCustomer.entrySet()) {
            System.out.printf("%s: %.2f%n", e.getKey(), e.getValue());
        }
        System.out.println("Ошибок: " + errors);

        Supplier<String> header = () -> "--- статистика ---";
        BiFunction<String, Double, String> line = (name, value) -> String.format("%s: %.2f", name, value);
        UnaryOperator<String> upper = String::toUpperCase;
        System.out.println(header.get());
        cheapest(merged).ifPresent(o -> System.out.println(line.apply("Самый дешёвый #" + o.id, o.amount)));
        System.out.println("Есть крупные: " + hasLarge(merged));
        System.out.println("Повторные клиенты: " + repeatCustomers(orders));
        System.out.println("От 100 и больше: " + select(merged, o -> o.amount >= 100).size());
        Range<Double> medium = new Range<>(100.0, 1000.0);
        System.out.println("Средних: " + merged.stream().filter(o -> medium.contains(o.amount)).count());
        for (CustomerTotal t : totals(merged)) {
            System.out.println(upper.apply(t.customer()) + " — " + t.category().title() + String.format(" (%.2f)", t.total()));
        }
        List<Double> amounts = mapAll(merged, o -> o.amount);
        if (!amounts.isEmpty()) {
            System.out.println(line.apply("Максимум", maxOf(amounts)));
        }

        switch (merged.size()) {
            case 0:
                System.out.println("Заказов нет");
                break;
            case 1:
                System.out.println("Один заказ");
                break;
            default:
                System.out.println("Заказов: " + merged.size());
        }
    }
}
