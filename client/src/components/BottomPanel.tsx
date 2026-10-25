import { useEffect, useRef, type ReactNode } from 'react';
import { CircleCheck, CircleX, PanelBottomClose, Plus, TriangleAlert, X } from 'lucide-react';
import type { CompareResult, TestCase } from '../../../shared/types.ts';
import { SCOPE } from '../theme.ts';
import { UnitDiff } from './CasesPanel.tsx';

export interface LogLine {
  time: string;
  text: string;
  kind?: 'ok' | 'error';
}

export type BottomTab = 'console' | 'tests' | 'cases' | 'results' | 'history';

interface Props {
  hidden: boolean;
  onHide: () => void;
  tab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  logs: LogLine[];
  tests: TestCase[];
  onTestsChange: (tests: TestCase[]) => void;
  compare: CompareResult | null;
  hasBaseline: boolean;
  /** Вкладка тест-кейсов классов (CasesPanel) и их число. */
  casesPanel: ReactNode;
  casesCount: number;
  /** Вкладка версий (HistoryPanel) и число незафиксированных файлов. */
  historyPanel: ReactNode;
  changes: number;
}

const ms = (v: number) => `${Math.round(v)} мс`;

export function BottomPanel({ hidden, onHide, tab, onTabChange, logs, tests, onTestsChange, compare, hasBaseline, casesPanel, casesCount, historyPanel, changes }: Props) {
  const consoleEnd = useRef<HTMLDivElement>(null);
  const update = (i: number, patch: Partial<TestCase>) => onTestsChange(tests.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const compiled = !!compare && compare.originalCompile.ok && compare.modifiedCompile.ok;
  // Без запуска «0 из 0» ничего не доказывает — это отдельный вердикт, а не «сохранено».
  // Запуск по stdin пропущен и тест-кейсов классов нет — сравнивать было нечего.
  const compileOnly = compiled && !!compare!.runSkipped && compare!.total === 0;
  const allPassed = compiled && !compileOnly && compare!.passed === compare!.total;
  // Все непрошедшие тесты — нестабильные: настоящих расхождений не найдено, но и доказательства нет.
  const flakyOnly = compiled && !compileOnly && compare!.flaky > 0 && compare!.cases.every((c) => c.passed || c.flaky);

  useEffect(() => {
    if (tab === 'console') consoleEnd.current?.scrollIntoView({ block: 'end' });
  }, [logs, tab]);

  return (
    <section className="panel bottom" aria-label="Запуск и тесты" hidden={hidden}>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'console'} onClick={() => onTabChange('console')}>Консоль</button>
        <button role="tab" aria-selected={tab === 'tests'} onClick={() => onTabChange('tests')}>
          Входные данные <span className="count">{tests.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'cases'} onClick={() => onTabChange('cases')}>
          Тест-кейсы <span className="count">{casesCount}</span>
        </button>
        <button role="tab" aria-selected={tab === 'results'} onClick={() => onTabChange('results')}>
          Результат
          {compare && (
            <span className={`count ${allPassed ? 'is-ok' : flakyOnly || compileOnly ? 'is-warn' : 'is-bad'}`}>
              {compileOnly ? 'сборка' : `${compare.passed}/${compare.total}`}
            </span>
          )}
        </button>
        <button role="tab" aria-selected={tab === 'history'} onClick={() => onTabChange('history')}>
          Версии {changes > 0 && <span className="count is-warn" title="Незафиксированных файлов">{changes}</span>}
        </button>
        <button className="icon-btn neutral panel-hide" onClick={onHide} aria-label="Скрыть панель" title="Скрыть панель">
          <PanelBottomClose size={15} />
        </button>
      </div>

      {tab === 'console' && (
        <div className="scroll console mono" role="log">
          {logs.length === 0 && <p className="panel-empty">Вывод компиляции и запуска появится здесь.</p>}
          {logs.map((l, i) => (
            <div key={i} className={`log ${l.kind ?? ''}`}>
              <span className="log-time">{l.time}</span>
              <span className="log-text">{l.text}</span>
            </div>
          ))}
          <div ref={consoleEnd} />
        </div>
      )}

      {tab === 'cases' && casesPanel}

      {tab === 'history' && historyPanel}

      {tab === 'tests' && (
        <div className="scroll tests">
          <p className="hint">Каждый тест — это stdin программы. Эталон и текущая версия получают одинаковый ввод, и их вывод сравнивается побайтно.</p>
          {tests.map((t, i) => (
            <div key={i} className="test-case">
              <input aria-label="Название теста" value={t.name} onChange={(e) => update(i, { name: e.target.value })} />
              <textarea aria-label={`stdin теста ${t.name}`} value={t.stdin} rows={3} onChange={(e) => update(i, { stdin: e.target.value })} spellCheck={false} placeholder="пустой ввод" />
              <button className="icon-btn" aria-label={`Удалить тест ${t.name}`} onClick={() => onTestsChange(tests.filter((_, j) => j !== i))}>
                <X size={14} />
              </button>
            </div>
          ))}
          <button className="btn ghost" onClick={() => onTestsChange([...tests, { name: `test${tests.length + 1}`, stdin: '' }])}>
            <Plus size={14} /> Добавить тест
          </button>
        </div>
      )}

      {tab === 'results' && (
        <div className="scroll results">
          {!compare && (
            <p className="panel-empty">
              {hasBaseline
                ? 'Нажмите «Проверить поведение», чтобы сравнить текущую версию с эталоном на всех тестах.'
                : 'Сначала загрузите программу: исходная версия станет эталоном поведения.'}
            </p>
          )}
          {compare && (
            <>
              <div className={`verdict ${flakyOnly || compileOnly ? 'is-warn' : allPassed ? 'is-ok' : 'is-bad'}`} role="status">
                {flakyOnly || compileOnly ? <TriangleAlert size={18} /> : allPassed ? <CircleCheck size={18} /> : <CircleX size={18} />}
                <div>
                  <b>
                    {compileOnly ? 'Обе версии компилируются'
                      : flakyOnly ? 'Поведение не проверить однозначно'
                        : allPassed ? 'Поведение сохранено'
                          : compiled ? 'Поведение изменилось' : 'Сборка не прошла'}
                  </b>
                  <span>
                    {compileOnly
                      ? `Поведение не сравнивалось: ${compare.runSkipped}. Добавьте тест-кейсы классов во вкладке «Тест-кейсы».`
                      : !compiled
                      ? 'Одна из версий не компилируется'
                      : flakyOnly
                        ? `Эталон выдаёт разный вывод от запуска к запуску в ${compare.flaky} из ${compare.total} тестов, расхождения в остальных нет`
                        : `${compare.passed} из ${compare.total} тестов совпали`}
                  </span>
                </div>
              </div>
              {compare.nondeterministic.length > 0 && (
                <p className="hint">
                  В коде есть {compare.nondeterministic.map((c) => SCOPE[c].title.toLowerCase()).join(', ')}: вывод может меняться от запуска к запуску.
                  {' '}Эталон запускался дважды на каждом тесте; совпадение подтверждено на этих запусках, но не гарантировано.
                </p>
              )}
              {!compare.originalCompile.ok && <pre className="out is-bad">Эталон не компилируется{'\n'}{compare.originalCompile.errors}</pre>}
              {!compare.modifiedCompile.ok && <pre className="out is-bad">Текущая версия не компилируется{'\n'}{compare.modifiedCompile.errors}</pre>}
              {compare.cases.length > 0 && (
                <table className="data">
                  <thead><tr><th>Тест</th><th>Результат</th><th className="num">Эталон</th><th className="num">Текущая</th></tr></thead>
                  <tbody>
                    {compare.cases.map((c) => (
                      <tr key={c.name}>
                        <td className="mono">{c.name}</td>
                        <td className={c.passed ? 'is-ok' : c.flaky ? 'is-warn' : 'is-bad'}>
                          {c.passed ? 'Совпадает' : c.flaky ? 'Недетерминировано' : `Расхождение: ${c.mismatches.join(', ')}`}
                        </td>
                        <td className="num">{ms(c.original.durationMs)}</td>
                        <td className="num">{ms(c.modified.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {compare.units.length > 0 && (
                <table className="data">
                  <thead><tr><th>Тест-кейс класса</th><th>Метод</th><th>Результат</th></tr></thead>
                  <tbody>
                    {compare.units.map((u) => (
                      <tr key={u.id}>
                        <td>{u.name}</td>
                        <td className="mono">{u.label}</td>
                        <td className={u.passed ? 'is-ok' : u.flaky ? 'is-warn' : 'is-bad'}>
                          {u.passed ? 'Совпадает'
                            : u.flaky ? 'Недетерминировано'
                              : u.original.kind === 'error' ? 'Не выполнился'
                                : `Расхождение: ${u.mismatches.join(', ')}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {compare.units.filter((u) => !u.passed).map((u) => (
                <div key={u.id} className="diff">
                  <b>{u.name} <span className="muted mono">{u.label}</span></b>
                  <UnitDiff r={u} />
                </div>
              ))}
              {compare.cases.filter((c) => !c.passed).map((c) => (
                <div key={c.name} className="diff">
                  <b className="mono">{c.name}</b>
                  <div className="diff-cols">
                    <pre className="out">{`эталон · exit ${c.original.exitCode}\n${c.original.stdout}${c.original.stderr && '\n[stderr]\n' + c.original.stderr}`}</pre>
                    <pre className="out">{`текущая · exit ${c.modified.exitCode}\n${c.modified.stdout}${c.modified.stderr && '\n[stderr]\n' + c.modified.stderr}`}</pre>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
