import { useMemo, useState } from 'react';
import { ChevronRight, LoaderCircle, Plus, Sparkles, Trash2, X } from 'lucide-react';
import type { MethodInfo, StubSpec, TypeInfo, UnitCase, UnitCaseResult } from '../../../shared/types.ts';

const SOURCE: Record<UnitCase['source'], string> = { heuristic: 'эвристика', llm: 'LLM', manual: 'вручную' };

export interface CasesTarget {
  type: TypeInfo;
  method?: MethodInfo;
}

interface Props {
  cases: UnitCase[];
  onChange: (cases: UnitCase[]) => void;
  /** Класс и метод, открытые на холсте: для них генерируются и добавляются кейсы. */
  target: CasesTarget | null;
  /** Зависимости класса кейса — варианты поля заглушки. */
  fieldsOf: (c: UnitCase) => string[];
  generating: boolean;
  onGenerate: (scope: 'method' | 'class', llm: boolean) => void;
  /** Последние результаты проверки по id кейса. */
  results: Map<string, UnitCaseResult>;
  /** Начальное состояние галочки LLM — из настроек. */
  llmDefault: boolean;
}

const newStub = (field = ''): StubSpec => ({ field, method: '', kind: 'returns', value: '' });

/** Тест-кейсы классов: генерация, правка аргументов и ответов заглушек, ручное добавление. */
export function CasesPanel({ cases, onChange, target, fieldsOf, generating, onGenerate, results, llmDefault }: Props) {
  const [llm, setLlm] = useState(llmDefault);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const map = new Map<string, UnitCase[]>();
    for (const c of cases) map.set(c.label, [...(map.get(c.label) ?? []), c]);
    return [...map];
  }, [cases]);

  const update = (id: string, patch: Partial<UnitCase>) => onChange(cases.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const updateStub = (c: UnitCase, i: number, patch: Partial<StubSpec>) => update(c.id, { stubs: c.stubs.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const toggle = (label: string) => setCollapsed((s) => {
    const next = new Set(s);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    return next;
  });

  const addManual = () => {
    const m = target?.method;
    if (!target || !m) return;
    onChange([
      ...cases,
      {
        id: crypto.randomUUID(),
        name: 'новый кейс',
        methodId: m.id,
        label: `${target.type.name.split('.').pop()}.${m.signature}`,
        binaryName: target.type.binaryName,
        file: target.type.file,
        method: m.name,
        params: m.params,
        args: m.params.map(() => 'null'),
        stubs: [],
        source: 'manual',
      },
    ]);
  };

  const methodTarget = target?.method && target.method.kind === 'method' ? target.method : undefined;
  const classTitle = target?.type.name.split('.').pop();

  return (
    <div className="scroll cases">
      <div className="cases-bar">
        <span className="cases-target">
          {target ? (
            <>Цель: <b className="mono">{classTitle}{methodTarget ? `.${methodTarget.signature}` : ''}</b></>
          ) : (
            'Откройте класс или метод на холсте, чтобы сгенерировать для него кейсы'
          )}
        </span>
        <button className="btn" disabled={!methodTarget || generating} onClick={() => onGenerate('method', llm)}>
          {generating ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />} Для метода
        </button>
        <button className="btn" disabled={!target || generating} onClick={() => onGenerate('class', llm)}>
          {generating ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />} Для класса
        </button>
        <label className="check" title="Локальная модель в Ollama дополняет эвристики осмысленными данными и ответами заглушек. Медленнее: до минуты на метод.">
          <input type="checkbox" checked={llm} onChange={(e) => setLlm(e.target.checked)} /> LLM
        </label>
        <button className="btn ghost" disabled={!methodTarget} onClick={addManual}><Plus size={14} /> Вручную</button>
        {cases.length > 0 && <button className="btn ghost danger" onClick={() => onChange([])}><Trash2 size={14} /> Очистить</button>}
      </div>

      {!cases.length && (
        <p className="hint">
          Тест-кейс — вызов метода класса с заданными аргументами. Зависимости класса (репозитории, клиенты) заменяются заглушками:
          по умолчанию они возвращают пустые значения, а в кейсе можно задать их ответ или исключение. «Проверить поведение»
          выполняет каждый кейс на эталоне и на текущей версии и сравнивает результат и вызовы зависимостей. Аргументы и ответы — код Java.
        </p>
      )}

      {groups.map(([label, group]) => {
        const open = !collapsed.has(label);
        const failed = group.filter((c) => results.get(c.id) && !results.get(c.id)!.passed).length;
        return (
          <section key={label} className="case-group">
            <button className="case-group-head" aria-expanded={open} onClick={() => toggle(label)}>
              <ChevronRight size={14} className={open ? 'is-open' : ''} />
              <span className="mono">{label}</span>
              <span className="count">{group.length}</span>
              {failed > 0 && <span className="count is-bad">{failed} не совпали</span>}
            </button>
            {open && group.map((c) => {
              const r = results.get(c.id);
              const fields = fieldsOf(c);
              return (
                <div key={c.id} className="case">
                  <div className="case-head">
                    <input className="case-name" aria-label="Название кейса" value={c.name} onChange={(e) => update(c.id, { name: e.target.value })} />
                    <span className="case-source">{SOURCE[c.source]}</span>
                    {r && (
                      <span className={`count ${r.passed ? 'is-ok' : r.flaky ? 'is-warn' : 'is-bad'}`} title={r.mismatches.join(', ') || undefined}>
                        {r.passed ? 'совпал' : r.flaky ? 'нестабилен' : r.original.kind === 'error' ? 'не выполнился' : 'расхождение'}
                      </span>
                    )}
                    <button className="icon-btn" aria-label={`Удалить кейс ${c.name}`} onClick={() => onChange(cases.filter((x) => x.id !== c.id))}><X size={14} /></button>
                  </div>
                  {c.params.map((p, i) => (
                    <label key={i} className="case-row">
                      <span className="case-param mono" title={p.type}><span className="muted">{p.type}</span> {p.name}</span>
                      <textarea
                        className="mono"
                        rows={1}
                        spellCheck={false}
                        value={c.args[i] ?? ''}
                        onChange={(e) => update(c.id, { args: c.args.map((a, j) => (j === i ? e.target.value : a)) })}
                      />
                    </label>
                  ))}
                  {c.stubs.map((s, i) => (
                    <div key={i} className="case-stub">
                      <select aria-label="Зависимость" value={s.field} onChange={(e) => updateStub(c, i, { field: e.target.value })}>
                        {!fields.includes(s.field) && <option value={s.field}>{s.field || '—'}</option>}
                        {fields.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                      <input className="mono" aria-label="Метод зависимости" placeholder="метод" value={s.method} onChange={(e) => updateStub(c, i, { method: e.target.value })} />
                      <select aria-label="Ответ" value={s.kind} onChange={(e) => updateStub(c, i, { kind: e.target.value as StubSpec['kind'] })}>
                        <option value="returns">возвращает</option>
                        <option value="throws">бросает</option>
                      </select>
                      <textarea className="mono" rows={1} spellCheck={false} aria-label="Значение" value={s.value} onChange={(e) => updateStub(c, i, { value: e.target.value })} />
                      <button className="icon-btn" aria-label="Удалить заглушку" onClick={() => update(c.id, { stubs: c.stubs.filter((_, j) => j !== i) })}><X size={13} /></button>
                    </div>
                  ))}
                  <button className="btn ghost small" disabled={!fields.length} onClick={() => update(c.id, { stubs: [...c.stubs, newStub(fields[0])] })}
                    title={fields.length ? undefined : 'У класса нет зависимостей'}>
                    <Plus size={13} /> Ответ зависимости
                  </button>
                  {r && !r.passed && <UnitDiff r={r} />}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

const outcome = (o: UnitCaseResult['original']) =>
  `${o.kind === 'return' ? '→ ' : o.kind === 'throw' ? 'исключение ' : 'ошибка: '}${o.value}` +
  (o.calls.length ? `\n\nвызовы:\n${o.calls.join('\n')}` : '') +
  (o.warnings.length ? `\n\n⚠ ${o.warnings.join('\n⚠ ')}` : '');

/** Эталон и текущая версия рядом — что именно разошлось. */
export function UnitDiff({ r }: { r: UnitCaseResult }) {
  if (r.original.kind === 'error') return <pre className="out is-bad">{outcome(r.original)}</pre>;
  return (
    <div className="diff-cols">
      <pre className="out">{`эталон\n${outcome(r.original)}`}</pre>
      <pre className="out">{`текущая\n${outcome(r.modified)}`}</pre>
    </div>
  );
}
