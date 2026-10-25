import { useState, type CSSProperties } from 'react';
import { ArrowRight, BookOpen, Bot, CircleCheck, Info, Lightbulb, LoaderCircle, OctagonAlert, PanelRightClose, Puzzle, Scissors, TriangleAlert, Wand, type LucideIcon } from 'lucide-react';
import { fixSourceOf, type AnalyzeResult, type Diagnostic, type PatternFinding, type PatternId, type Range, type ScopeCategory, type ScopeFinding, type Severity } from '../../../shared/types.ts';
import { PATTERNS, type PatternHelp } from '../patterns.ts';
import { SCOPE, SEVERITY } from '../theme.ts';

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const ICON: Record<Severity, LucideIcon> = { high: OctagonAlert, medium: TriangleAlert, low: Info };

/** Что значит конструкция для графа и проверки поведения. */
const SCOPE_EFFECT: Record<ScopeCategory, string> = {
  concurrency: 'Порядок выполнения потоков не моделируется: вывод может меняться между запусками, проверка поведения запускает эталон дважды и помечает нестабильные тесты.',
  time: 'Результат зависит от текущего времени: вывод может меняться между запусками, проверка поведения запускает эталон дважды и помечает нестабильные тесты.',
  random: 'Без фиксированного seed вывод меняется между запусками: проверка поведения запускает эталон дважды и помечает нестабильные тесты.',
  network: 'Сетевые обращения не моделируются и при проверке поведения не изолированы.',
  files: 'Работа с файлами не моделируется; при проверке поведения программа выполняется во временном каталоге без изоляции.',
  reflection: 'Вызовы через рефлексию не видны в графе вызовов.',
};

/** Находки одной категории в одном файле — один пункт списка, иначе они задавят дефекты. */
interface ScopeGroup {
  id: string;
  category: ScopeCategory;
  file: string;
  findings: ScopeFinding[];
}

function groupScope(findings: ScopeFinding[]): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  for (const f of findings) {
    const id = `${f.category}:${f.range.file}`;
    if (!groups.has(id)) groups.set(id, { id, category: f.category, file: f.range.file, findings: [] });
    groups.get(id)!.findings.push(f);
  }
  return [...groups.values()];
}

/** Метод или класс, до которого сужен список проблем. */
export interface ProblemFocus {
  label: string;
  kind: 'method' | 'class';
  test: (r: Range) => boolean;
}

interface Props {
  hidden: boolean;
  onHide: () => void;
  analysis: AnalyzeResult | null;
  selectedMethodId: string | null;
  focus: ProblemFocus | null;
  selectedDiagnosticId: string | null;
  onPick: (d: Diagnostic) => void;
  onPickScope: (f: ScopeFinding) => void;
  /** Предложить исправления: ids — конкретные проблемы, без них — все исправимые. */
  onFix: (ids: string[] | undefined, llm: boolean) => void;
  /** Проблемы, которые сейчас исправляются: 'all' — все исправимые, null — генерация не идёт. */
  fixingIds: string[] | 'all' | null;
  canFix: boolean;
  llmDefault: boolean;
  onPickPattern: (f: PatternFinding) => void;
  /** Применить паттерн через LLM (с проверкой и ревью). */
  onApplyPattern: (f: PatternFinding) => void;
  onSplit: (f: PatternFinding) => void;
  /** Находка, которая сейчас применяется. */
  applyingPatternId: string | null;
}

function Help({ help }: { help: PatternHelp }) {
  return (
    <div className="pattern-help">
      <p>{help.intent}</p>
      <b>Когда уместен</b>
      <ul>{help.when.map((w, i) => <li key={i}>{w}</li>)}</ul>
      <b>Когда не нужен</b>
      <p>{help.avoid}</p>
      <div className="pattern-code">
        <span className="muted">До</span>
        <pre className="mono">{help.before}</pre>
        <span className="muted">После</span>
        <pre className="mono">{help.after}</pre>
      </div>
    </div>
  );
}

function PatternCard({ f, selected, onPick, onApply, onSplit, applying, disabled }: {
  f: PatternFinding; selected: boolean; onPick: () => void; onApply: () => void; onSplit: () => void; applying: boolean; disabled: boolean;
}) {
  const help = PATTERNS[f.pattern];
  const found = f.kind === 'found';
  return (
    <div className={`diag pattern${selected ? ' is-selected' : ''}${applying ? ' is-fixing' : ''}${found ? ' is-found' : ' is-opportunity'}`}>
      <span className="diag-icon">{found ? <Puzzle size={15} strokeWidth={2.25} aria-label="Найден" /> : <Lightbulb size={15} strokeWidth={2.25} aria-label="Можно применить" />}</span>
      <span className="diag-body">
        <span className="diag-head">
          <button className="diag-open" onClick={onPick}><b>{f.title}</b></button>
          <span className="diag-loc mono">{f.range.file}:{f.range.startLine}</span>
        </span>
        <span className="diag-msg">{f.message}</span>
        {f.warning && <span className="pattern-warn"><TriangleAlert size={13} /> {f.warning}</span>}
        {f.roles.length > 0 && (
          <span className="pattern-roles">
            {f.roles.map((r, i) => <span key={i} className="pattern-role"><span className="muted">{r.role}</span> <span className="mono">{r.name}</span></span>)}
          </span>
        )}
        <details className="pattern-more">
          <summary><BookOpen size={12} /> {help.name} · {help.family.toLowerCase()}{found ? '' : ' — как применить'}</summary>
          <Help help={help} />
        </details>
        {f.action && (
          <span className="diag-actions">
            {f.action === 'split' ? (
              <button className="btn small" disabled={disabled} onClick={onSplit} title="Подобрать состав новых классов и разделить"><Scissors size={13} /> Разделить класс</button>
            ) : (
              <button className="btn small" disabled={disabled} onClick={onApply} title="Локальная LLM перепишет код; ответ проверяется компиляцией и тестами, затем — ревью">
                {applying ? <><LoaderCircle size={13} className="spin" /> Применяется…</> : <><Bot size={13} /> {f.warning ? 'Исправить' : 'Применить'}</>}
              </button>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

function PatternsTab({ findings, onPick, onApply, onSplit, applyingId, canApply }: {
  findings: PatternFinding[]; onPick: (f: PatternFinding) => void; onApply: (f: PatternFinding) => void; onSplit: (f: PatternFinding) => void; applyingId: string | null; canApply: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const found = findings.filter((f) => f.kind === 'found');
  const chances = findings.filter((f) => f.kind === 'opportunity');
  const card = (f: PatternFinding) => (
    <PatternCard
      key={f.id} f={f} selected={f.id === picked} applying={f.id === applyingId}
      disabled={!canApply || applyingId !== null}
      onPick={() => { setPicked(f.id); onPick(f); }} onApply={() => onApply(f)} onSplit={() => onSplit(f)}
    />
  );
  return (
    <div className="scroll diag-list">
      {chances.length > 0 && <h3 className="pattern-group">Можно применить <span className="count">{chances.length}</span></h3>}
      {chances.map(card)}
      {found.length > 0 && <h3 className="pattern-group">Уже в коде <span className="count">{found.length}</span></h3>}
      {found.map(card)}
      {!findings.length && <p className="panel-empty">Паттернов и мест для них не найдено.</p>}
      <details className="pattern-catalog">
        <summary><BookOpen size={13} /> Справочник паттернов</summary>
        {(Object.keys(PATTERNS) as PatternId[]).map((id) => (
          <details key={id} className="pattern-more">
            <summary>{PATTERNS[id].name} <span className="muted">· {PATTERNS[id].family.toLowerCase()}</span></summary>
            <Help help={PATTERNS[id]} />
          </details>
        ))}
      </details>
    </div>
  );
}

function Complexity({ from, to }: { from: string; to?: string }) {
  return (
    <span className="cx">
      <span className="cx-from">{from}</span>
      {to && (
        <>
          <ArrowRight size={12} aria-label="после исправления" />
          <span className="cx-to">{to}</span>
        </>
      )}
    </span>
  );
}

export function AnalysisPanel({ hidden, onHide, analysis, selectedMethodId, focus, selectedDiagnosticId, onPick, onPickScope, onFix, fixingIds, canFix, llmDefault, onPickPattern, onApplyPattern, onSplit, applyingPatternId }: Props) {
  const [tab, setTab] = useState<'problems' | 'patterns' | 'metrics'>('problems');
  const patterns = analysis?.patterns ?? [];
  const chances = patterns.filter((p) => p.kind === 'opportunity').length;
  const [llm, setLlm] = useState(llmDefault);
  // «Все» запоминается для конкретного метода/класса: выбрали другой — снова только его проблемы.
  const [allFor, setAllFor] = useState<string | null>(null);
  const filter = focus && allFor !== focus.label ? focus : null;
  const allDiagnostics = analysis?.diagnostics ?? [];
  const allScope = analysis?.scope ?? [];
  const diagnostics = allDiagnostics.filter((d) => !filter || filter.test(d.range)).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const metrics = analysis?.metrics ?? [];
  const current = metrics.find((m) => m.methodId === selectedMethodId);
  const improved = diagnostics.find((d) => d.methodId === selectedMethodId && d.improvedComplexity);
  const scope = groupScope(allScope.filter((f) => !filter || filter.test(f.range)));
  const counts = { high: 0, medium: 0, low: scope.length };
  for (const d of diagnostics) counts[d.severity]++;
  const total = diagnostics.length + scope.length;
  const projectTotal = allDiagnostics.length + groupScope(allScope).length;
  const fixing = fixingIds !== null;
  const fixable = diagnostics.filter((d) => {
    const src = fixSourceOf(d);
    return src === 'rule' || (src === 'llm' && llm);
  });

  return (
    <section className="panel analysis" aria-label="Анализ" hidden={hidden}>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'problems'} onClick={() => setTab('problems')}>
          Проблемы <span className="count">{total}</span>
        </button>
        <button role="tab" aria-selected={tab === 'patterns'} onClick={() => setTab('patterns')} title="Паттерны проектирования: найденные и где помогут">
          Паттерны {chances > 0 && <span className="count is-warn">{chances}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'metrics'} onClick={() => setTab('metrics')}>
          Метрики
        </button>
        {total > 0 && tab === 'problems' && (
          <span className="sev-summary">
            {(['high', 'medium', 'low'] as const).filter((s) => counts[s]).map((s) => (
              <span key={s} style={{ '--sev': SEVERITY[s].color } as CSSProperties} title={SEVERITY[s].label}>
                {counts[s]}
              </span>
            ))}
          </span>
        )}
        <button className="icon-btn neutral panel-hide" onClick={onHide} aria-label="Скрыть панель" title="Скрыть панель">
          <PanelRightClose size={15} />
        </button>
      </div>

      {analysis?.parseErrors.length ? (
        <div className="parse-errors" role="alert">
          <b>Код не разобран полностью</b>
          {analysis.parseErrors.slice(0, 5).map((e, i) => (
            <div key={i}>
              <span className="mono">{e.file}:{e.line}</span> {e.message}
            </div>
          ))}
        </div>
      ) : null}

      {tab === 'problems' && focus && analysis && (
        <div className="problem-focus">
          {filter ? (
            <>
              <span className="ellipsis">
                <span className="muted">{focus.kind === 'method' ? 'Метод' : 'Класс'}</span> <span className="mono">{focus.label}</span>
                <span className="muted"> · {total} из {projectTotal}</span>
              </span>
              <button className="link-btn" onClick={() => setAllFor(focus.label)}>Все</button>
            </>
          ) : (
            <>
              <span className="muted">Весь проект</span>
              <button className="link-btn ellipsis" onClick={() => setAllFor(null)}>Только <span className="mono">{focus.label}</span></button>
            </>
          )}
        </div>
      )}

      {tab === 'problems' && diagnostics.length > 0 && (
        <div className="fix-bar">
          <button className="btn" disabled={!canFix || fixing || !fixable.length} onClick={() => onFix(filter ? fixable.map((d) => d.id) : undefined, llm)} title="Предложить исправления: ничего не применится без вашего подтверждения">
            {fixingIds === 'all' ? <><LoaderCircle size={14} className="spin" /> Генерация…</> : <><Wand size={14} /> {filter ? `Исправить в ${filter.kind === 'method' ? 'методе' : 'классе'}` : 'Исправить всё'} ({fixable.length})</>}
          </button>
          <label className="check" title="Переписывать методы через локальную LLM там, где нет точного правила (длинные методы, вложенные циклы, N+1)">
            <input type="checkbox" checked={llm} onChange={(e) => setLlm(e.target.checked)} /> LLM
          </label>
        </div>
      )}

      {tab === 'patterns' ? (
        <PatternsTab findings={patterns} onPick={onPickPattern} onApply={onApplyPattern} onSplit={onSplit} applyingId={applyingPatternId} canApply={canFix && fixingIds === null} />
      ) : tab === 'problems' ? (
        <div className="scroll diag-list">
          {!analysis && <p className="panel-empty">Здесь появятся найденные дефекты, оценка сложности и способы исправления.</p>}
          {analysis && total === 0 && (
            <p className="panel-empty ok">
              <CircleCheck size={16} /> {filter ? `В ${filter.kind === 'method' ? 'методе' : 'классе'} дефектов не найдено` : 'Дефектов не найдено'}
            </p>
          )}
          {diagnostics.map((d) => {
            const Icon = ICON[d.severity];
            const source = fixSourceOf(d);
            const inProgress = fixingIds === 'all' ? fixable.includes(d) : !!fixingIds?.includes(d.id);
            return (
              // Карточка — не кнопка: внутри неё своя кнопка «Исправить». Клик по карточке ведёт заголовок (растянут на всю карточку).
              <div
                key={d.id}
                className={`diag${d.id === selectedDiagnosticId ? ' is-selected' : ''}${inProgress ? ' is-fixing' : ''}`}
                style={{ '--sev': SEVERITY[d.severity].color } as CSSProperties}
              >
                <span className="diag-icon"><Icon size={15} strokeWidth={2.25} aria-label={SEVERITY[d.severity].label} /></span>
                <span className="diag-body">
                  <span className="diag-head">
                    <button className="diag-open" onClick={() => onPick(d)}><b>{d.title}</b></button>
                    <span className="diag-loc mono">{d.range.file}:{d.range.startLine}</span>
                  </span>
                  <span className="diag-msg">{d.message}</span>
                  <span className="diag-rec">{d.recommendation}</span>
                  {d.complexity && <Complexity from={d.complexity} to={d.improvedComplexity} />}
                  {source && (
                    <span className="diag-actions">
                      <button
                        className="btn small"
                        disabled={!canFix || fixing || (source === 'llm' && !llm)}
                        onClick={() => onFix([d.id], llm)}
                        title={source === 'rule' ? 'Точная замена по правилу; если шаблон не подойдёт — через LLM' : llm ? 'Метод перепишет локальная LLM' : 'Нужна LLM: включите переключатель «LLM» выше'}
                      >
                        {inProgress ? <><LoaderCircle size={13} className="spin" /> Исправляется…</> : <>{source === 'rule' ? <Wand size={13} /> : <Bot size={13} />} Исправить</>}
                      </button>
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          {scope.map((g) => {
            const { Icon, title } = SCOPE[g.category];
            const first = g.findings[0];
            const constructs = [...new Set(g.findings.map((f) => f.construct))];
            return (
              <button
                key={g.id}
                className="diag"
                style={{ '--sev': SEVERITY.low.color } as CSSProperties}
                onClick={() => onPickScope(first)}
                title="Показать первое место в коде"
              >
                <span className="diag-icon"><Icon size={15} strokeWidth={2.25} aria-label={title} /></span>
                <span className="diag-body">
                  <span className="diag-head">
                    <b>{title}{g.findings.length > 1 ? ` · ${g.findings.length}` : ''}</b>
                    <span className="diag-loc mono">{g.file}:{first.range.startLine}</span>
                  </span>
                  <span className="diag-msg mono">{constructs.slice(0, 4).join(', ')}{constructs.length > 4 ? ` и ещё ${constructs.length - 4}` : ''}</span>
                  <span className="diag-rec">{SCOPE_EFFECT[g.category]}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="scroll">
          <table className="data">
            <thead>
              <tr><th>Метод</th><th className="num">Строк</th><th className="num">CC</th><th>Big O</th></tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.methodId} className={m.methodId === selectedMethodId ? 'is-selected' : ''}>
                  <td className="mono ellipsis" title={m.methodId}>{m.methodId.split('#')[1]}</td>
                  <td className="num">{m.lines}</td>
                  <td className={`num${m.cyclomatic > 10 ? ' is-bad' : ''}`}>{m.cyclomatic}</td>
                  <td className={`mono${m.maxLoopDepth >= 2 ? ' is-bad' : ''}`}>{m.complexity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {current && (
        <div className="method-summary">
          <span className="muted">Сложность метода</span>
          <Complexity from={current.complexity} to={improved?.improvedComplexity} />
        </div>
      )}
    </section>
  );
}
