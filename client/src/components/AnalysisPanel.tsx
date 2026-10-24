import { useState, type CSSProperties } from 'react';
import { ArrowRight, CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { AnalyzeResult, Diagnostic, ScopeCategory, ScopeFinding, Severity } from '../../../shared/types.ts';
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

interface Props {
  analysis: AnalyzeResult | null;
  selectedMethodId: string | null;
  selectedDiagnosticId: string | null;
  onPick: (d: Diagnostic) => void;
  onPickScope: (f: ScopeFinding) => void;
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

export function AnalysisPanel({ analysis, selectedMethodId, selectedDiagnosticId, onPick, onPickScope }: Props) {
  const [tab, setTab] = useState<'problems' | 'metrics'>('problems');
  const diagnostics = [...(analysis?.diagnostics ?? [])].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const metrics = analysis?.metrics ?? [];
  const current = metrics.find((m) => m.methodId === selectedMethodId);
  const improved = diagnostics.find((d) => d.methodId === selectedMethodId && d.improvedComplexity);
  const scope = groupScope(analysis?.scope ?? []);
  const counts = { high: 0, medium: 0, low: scope.length };
  for (const d of diagnostics) counts[d.severity]++;
  const total = diagnostics.length + scope.length;

  return (
    <section className="panel analysis" aria-label="Анализ">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'problems'} onClick={() => setTab('problems')}>
          Проблемы <span className="count">{total}</span>
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

      {tab === 'problems' ? (
        <div className="scroll diag-list">
          {!analysis && <p className="panel-empty">Здесь появятся найденные дефекты, оценка сложности и способы исправления.</p>}
          {analysis && total === 0 && (
            <p className="panel-empty ok">
              <CircleCheck size={16} /> Дефектов не найдено
            </p>
          )}
          {diagnostics.map((d) => {
            const Icon = ICON[d.severity];
            return (
              <button
                key={d.id}
                className={`diag${d.id === selectedDiagnosticId ? ' is-selected' : ''}`}
                style={{ '--sev': SEVERITY[d.severity].color } as CSSProperties}
                onClick={() => onPick(d)}
              >
                <span className="diag-icon"><Icon size={15} strokeWidth={2.25} aria-label={SEVERITY[d.severity].label} /></span>
                <span className="diag-body">
                  <span className="diag-head">
                    <b>{d.title}</b>
                    <span className="diag-loc mono">{d.range.file}:{d.range.startLine}</span>
                  </span>
                  <span className="diag-msg">{d.message}</span>
                  <span className="diag-rec">{d.recommendation}</span>
                  {d.complexity && <Complexity from={d.complexity} to={d.improvedComplexity} />}
                </span>
              </button>
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
