package jbp;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Supplier;

import org.mockito.ArgumentMatchers;
import org.mockito.Mockito;
import org.mockito.invocation.Invocation;
import org.mockito.stubbing.Answer;

/**
 * Драйвер тест-кейсов класса (Dark Secrets).
 * Создаёт объект с заглушками Mockito вместо зависимостей, настраивает их ответы,
 * вызывает метод и печатает результат одной строкой JSON с префиксом "JBP\t".
 * Вывод детерминирован: поля объектов и элементы множеств сортируются.
 */
public final class JbpRuntime {
    private JbpRuntime() {}

    public static final class Stub {
        final String field;
        final String method;
        final boolean throwing;
        final Supplier<Object> value;

        Stub(String field, String method, boolean throwing, Supplier<Object> value) {
            this.field = field;
            this.method = method;
            this.throwing = throwing;
            this.value = value;
        }
    }

    public static Stub returns(String field, String method, Supplier<Object> value) {
        return new Stub(field, method, false, value);
    }

    public static Stub throwing(String field, String method, Supplier<Object> value) {
        return new Stub(field, method, true, value);
    }

    public static void run(String id, String typeName, String methodName, String[] paramTypes,
                           Supplier<Object[]> args, Stub... stubs) {
        List<String> warnings = new ArrayList<>();
        Map<String, Object> mocks = new TreeMap<>();
        String kind;
        String value;
        try {
            Class<?> type = Class.forName(typeName);
            Method method = findMethod(type, methodName, paramTypes);
            method.setAccessible(true);
            Object target = Modifier.isStatic(method.getModifiers()) ? null : instantiate(type, mocks, warnings);
            for (Stub s : stubs) applyStub(s, mocks, warnings);
            for (Object m : mocks.values()) Mockito.clearInvocations(m);
            Object[] values = args.get();
            try {
                Object result = method.invoke(target, values);
                kind = "return";
                value = method.getReturnType() == void.class ? "void" : show(result);
            } catch (InvocationTargetException e) {
                Throwable cause = e.getCause();
                kind = "throw";
                value = cause.getClass().getName() + (cause.getMessage() != null ? ": " + cause.getMessage() : "");
            }
        } catch (Throwable e) {
            Throwable cause = e instanceof InvocationTargetException && e.getCause() != null ? e.getCause() : e;
            kind = "error";
            value = cause.getClass().getSimpleName() + (cause.getMessage() != null ? ": " + cause.getMessage() : "");
        }
        List<String> calls = new ArrayList<>();
        for (Map.Entry<String, Object> m : mocks.entrySet()) {
            for (Invocation inv : Mockito.mockingDetails(m.getValue()).getInvocations()) {
                StringBuilder sb = new StringBuilder(m.getKey()).append('.').append(inv.getMethod().getName()).append('(');
                Object[] a = inv.getArguments();
                for (int i = 0; i < a.length; i++) sb.append(i > 0 ? ", " : "").append(show(a[i]));
                calls.add(sb.append(')').toString());
            }
        }
        StringBuilder out = new StringBuilder("JBP\t{\"id\":").append(json(id))
                .append(",\"kind\":").append(json(kind))
                .append(",\"value\":").append(json(value))
                .append(",\"calls\":[");
        for (int i = 0; i < calls.size(); i++) out.append(i > 0 ? "," : "").append(json(calls.get(i)));
        out.append("],\"warnings\":[");
        for (int i = 0; i < warnings.size(); i++) out.append(i > 0 ? "," : "").append(json(warnings.get(i)));
        System.out.println(out.append("]}"));
    }

    // ---------- Объект с заглушками ----------

    private static Object instantiate(Class<?> type, Map<String, Object> mocks, List<String> warnings) throws Exception {
        if (type.isInterface() || Modifier.isAbstract(type.getModifiers())) {
            throw new IllegalStateException("нельзя создать объект: " + type.getSimpleName() + " абстрактный");
        }
        Constructor<?>[] ctors = type.getDeclaredConstructors();
        // Конструктор с наибольшим числом параметров — обычно тот, через который внедряются зависимости.
        Arrays.sort(ctors, (a, b) -> b.getParameterCount() - a.getParameterCount());
        Exception last = null;
        Object instance = null;
        for (Constructor<?> c : ctors) {
            try {
                c.setAccessible(true);
                Class<?>[] ps = c.getParameterTypes();
                Object[] values = new Object[ps.length];
                for (int i = 0; i < ps.length; i++) values[i] = dependency(ps[i]);
                instance = c.newInstance(values);
                break;
            } catch (Exception e) {
                last = e;
            }
        }
        if (instance == null) throw last != null ? last : new IllegalStateException("нет конструктора");
        // Зависимости из конструктора и @Autowired-поля: заглушки находим и создаём по полям.
        for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
            for (Field f : c.getDeclaredFields()) {
                if (Modifier.isStatic(f.getModifiers())) continue;
                try {
                    f.setAccessible(true);
                    Object v = f.get(instance);
                    if (v == null && mockable(f.getType())) {
                        v = mock(f.getType());
                        f.set(instance, v);
                    }
                    if (v != null && Mockito.mockingDetails(v).isMock()) mocks.putIfAbsent(f.getName(), v);
                } catch (Exception e) {
                    warnings.add("поле " + f.getName() + ": " + e.getMessage());
                }
            }
        }
        return instance;
    }

    private static boolean mockable(Class<?> t) {
        return !t.isPrimitive() && !t.isArray() && !t.isEnum() && t != String.class
                && !Number.class.isAssignableFrom(t) && t != Boolean.class && t != Character.class
                && !Modifier.isFinal(t.getModifiers());
    }

    private static Object dependency(Class<?> t) {
        if (t.isPrimitive()) return primitiveDefault(t);
        if (t == String.class) return "";
        return mockable(t) ? mock(t) : null;
    }

    /**
     * Ответ незаглушённого метода: как у Mockito (null, 0, пустые коллекции, Optional.empty),
     * но Page/Slice Spring Data — пустая страница. Иначе метод падает с NPE на page.map(...)
     * раньше, чем доходит до своей логики, и кейс ничего не проверяет.
     */
    private static final Answer<Object> DEFAULTS = invocation -> {
        Class<?> rt = invocation.getMethod().getReturnType();
        String name = rt.getName();
        if (name.equals("org.springframework.data.domain.Page") || name.equals("org.springframework.data.domain.Slice")) {
            try {
                return Class.forName("org.springframework.data.domain.PageImpl").getConstructor(List.class).newInstance(List.of());
            } catch (ReflectiveOperationException e) {
                System.err.println("JbpRuntime: пустая страница не создана: " + e);
            }
        }
        return Mockito.RETURNS_DEFAULTS.answer(invocation);
    };

    private static Object mock(Class<?> t) {
        return Mockito.mock(t, Mockito.withSettings().defaultAnswer(DEFAULTS));
    }

    private static Object primitiveDefault(Class<?> t) {
        if (t == boolean.class) return false;
        if (t == char.class) return '\0';
        if (t == long.class) return 0L;
        if (t == double.class) return 0d;
        if (t == float.class) return 0f;
        if (t == short.class) return (short) 0;
        if (t == byte.class) return (byte) 0;
        return 0;
    }

    private static Object anyOf(Class<?> t) {
        if (!t.isPrimitive()) return ArgumentMatchers.any();
        if (t == boolean.class) return ArgumentMatchers.anyBoolean();
        if (t == char.class) return ArgumentMatchers.anyChar();
        if (t == long.class) return ArgumentMatchers.anyLong();
        if (t == double.class) return ArgumentMatchers.anyDouble();
        if (t == float.class) return ArgumentMatchers.anyFloat();
        if (t == short.class) return ArgumentMatchers.anyShort();
        if (t == byte.class) return ArgumentMatchers.anyByte();
        return ArgumentMatchers.anyInt();
    }

    /** Ответ заглушки — для всех перегрузок метода с этим именем, с любыми аргументами. */
    private static void applyStub(Stub s, Map<String, Object> mocks, List<String> warnings) {
        Object mock = mocks.get(s.field);
        if (mock == null) {
            warnings.add("заглушка " + s.field + "." + s.method + ": у класса нет такой зависимости");
            return;
        }
        Object answer;
        try {
            answer = s.value.get();
        } catch (Throwable e) {
            warnings.add("заглушка " + s.field + "." + s.method + ": " + e);
            return;
        }
        int applied = 0;
        String lastError = null;
        for (Method m : mock.getClass().getMethods()) {
            if (!m.getName().equals(s.method) || m.isBridge() || Modifier.isStatic(m.getModifiers())) continue;
            try {
                Object when = s.throwing ? Mockito.doThrow((Throwable) answer).when(mock) : Mockito.doReturn(answer).when(mock);
                Class<?>[] ps = m.getParameterTypes();
                Object[] matchers = new Object[ps.length];
                for (int i = 0; i < ps.length; i++) matchers[i] = anyOf(ps[i]);
                m.invoke(when, matchers);
                applied++;
            } catch (Throwable e) {
                Throwable cause = e instanceof InvocationTargetException && e.getCause() != null ? e.getCause() : e;
                lastError = cause.getClass().getSimpleName() + ": " + String.valueOf(cause.getMessage()).split("\n")[0];
                // Незавершённая настройка сломала бы следующие; validateMockitoUsage сбрасывает её, бросив ту же ошибку.
                try {
                    Mockito.validateMockitoUsage();
                } catch (Throwable pending) {
                    lastError += " (" + pending.getClass().getSimpleName() + ")";
                }
            }
        }
        if (applied == 0) {
            warnings.add("заглушка " + s.field + "." + s.method + " не применилась" + (lastError != null ? ": " + lastError : ""));
        }
    }

    private static Method findMethod(Class<?> type, String name, String[] paramTypes) throws NoSuchMethodException {
        for (Class<?> c = type; c != null; c = c.getSuperclass()) {
            for (Method m : c.getDeclaredMethods()) {
                if (!m.getName().equals(name) || m.getParameterCount() != paramTypes.length || m.isBridge()) continue;
                Class<?>[] ps = m.getParameterTypes();
                boolean same = true;
                for (int i = 0; i < ps.length && same; i++) same = ps[i].getSimpleName().equals(paramTypes[i]);
                if (same) return m;
            }
        }
        throw new NoSuchMethodException(type.getSimpleName() + "." + name + "(" + String.join(", ", paramTypes) + ")");
    }

    // ---------- Детерминированное представление значений ----------

    public static String show(Object v) {
        return show(v, 0, new IdentityHashMap<>());
    }

    private static String show(Object v, int depth, IdentityHashMap<Object, Boolean> seen) {
        if (v == null) return "null";
        if (v instanceof String s) return json(s);
        if (v instanceof Character c) return "'" + c + "'";
        if (v instanceof Number || v instanceof Boolean) return v.toString();
        if (v instanceof Enum<?> e) return e.getDeclaringClass().getSimpleName() + "." + e.name();
        if (v instanceof Class<?> c) return c.getName();
        if (Mockito.mockingDetails(v).isMock()) return "заглушка " + Mockito.mockingDetails(v).getMockCreationSettings().getTypeToMock().getSimpleName();
        if (depth > 5) return "…";
        if (seen.containsKey(v)) return "<цикл>";
        seen.put(v, true);
        try {
            if (v instanceof Optional<?> o) return o.map(x -> "Optional[" + show(x, depth + 1, seen) + "]").orElse("Optional.empty");
            if (v.getClass().isArray()) {
                List<String> items = new ArrayList<>();
                int n = java.lang.reflect.Array.getLength(v);
                for (int i = 0; i < n; i++) items.add(show(java.lang.reflect.Array.get(v, i), depth + 1, seen));
                return "[" + String.join(", ", items) + "]";
            }
            if (v instanceof Map<?, ?> m) {
                TreeMap<String, String> sorted = new TreeMap<>();
                for (Map.Entry<?, ?> e : m.entrySet()) sorted.put(show(e.getKey(), depth + 1, seen), show(e.getValue(), depth + 1, seen));
                return sorted.toString();
            }
            if (v instanceof Iterable<?> it) {
                List<String> items = new ArrayList<>();
                for (Object x : it) items.add(show(x, depth + 1, seen));
                if (v instanceof Set<?>) items.sort(null); // порядок HashSet не определён
                String size = v instanceof Collection<?> ? "" : v.getClass().getSimpleName();
                return size + "[" + String.join(", ", items) + "]";
            }
            if (v instanceof Throwable t) return t.getClass().getName() + ": " + t.getMessage();
            String pkg = v.getClass().getPackageName();
            if (pkg.startsWith("java.") || pkg.startsWith("javax.") || pkg.startsWith("jakarta.")) return v.toString();
            TreeMap<String, String> fields = new TreeMap<>();
            for (Class<?> c = v.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
                for (Field f : c.getDeclaredFields()) {
                    if (Modifier.isStatic(f.getModifiers()) || f.isSynthetic()) continue;
                    try {
                        f.setAccessible(true);
                        fields.putIfAbsent(f.getName(), show(f.get(v), depth + 1, seen));
                    } catch (Exception e) {
                        fields.putIfAbsent(f.getName(), "<недоступно>");
                    }
                }
            }
            StringBuilder sb = new StringBuilder(v.getClass().getSimpleName()).append('{');
            int i = 0;
            for (Map.Entry<String, String> e : fields.entrySet()) sb.append(i++ > 0 ? ", " : "").append(e.getKey()).append('=').append(e.getValue());
            return sb.append('}').toString();
        } finally {
            seen.remove(v);
        }
    }

    private static String json(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.append('"').toString();
    }
}
