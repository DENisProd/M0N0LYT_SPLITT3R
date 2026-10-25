import { useEffect, useState } from 'react';
import { Box, LoaderCircle, Lock, Minus, Plus, Scissors, TriangleAlert, Variable, X } from 'lucide-react';
import type { SourceFile, SplitPlan, SplitResult, TestCase, UnitCase } from '../../../shared/types.ts';
import { api } from '../api.ts';

export interface SplitTarget {
  file: string;
  typeName: string;
}

interface Props {
  target: SplitTarget;
  /** Проанализированный код: план строится по нему. */
  files: SourceFile[];
  tests: TestCase[];
  unitCases: UnitCase[];
  /** Разделение выполнено и проверено — дальше ревью. */
  onDone: (result: SplitResult, plan: SplitPlan) => void;
  onClose: () => void;
}

const MAX_PARTS = 6;

/**
 * Разделение класса: число классов, имена и состав каждой части. План предлагает сервер
 * (кластеризация по связям членов), здесь его можно поправить вручную.
 */
export function SplitView({ target, files, tests, unitCases, onDone, onClose }: Props) {
  const [plan, setPlan] = useState<SplitPlan | null>(null);
  /** Число классов, выбранное пользователем; без него — рекомендованное сервером. */
  const [requested, setRequested] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.splitPlan(files, target.file, target.typeName, requested)
      .then((p) => {
        if (cancelled) return;
        setPlan(p);
        setError(p.error ?? null);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [files, target.file, target.typeName, requested]);

  const count = plan?.parts.length ?? 2;
  const member = new Map(plan?.members.map((m) => [m.id, m]));
  const movable = plan?.members.filter((m) => !m.pinned).length ?? 0;
  const maxParts = Math.min(MAX_PARTS, movable + 1);
  const partLines = (ids: string[]) => ids.reduce((n, id) => n + (member.get(id)?.lines ?? 0), 0);

  const move = (id: string, to: number) =>
    setPlan((p) => p && { ...p, parts: p.parts.map((part, i) => ({ ...part, members: i === to ? [...part.members.filter((x) => x !== id), id] : part.members.filter((x) => x !== id) })) });
  const rename = (i: number, name: string) => setPlan((p) => p && { ...p, parts: p.parts.map((part, k) => (k === i ? { ...part, name } : part)) });

  const apply = async () => {
    if (!plan) return;
    setApplying(true);
    setError(null);
    try {
      const r = await api.splitApply({ files, plan, tests, unitCases });
      if (!r.created.length) setError(r.errors ?? 'Разделение не выполнено');
      else onDone(r, plan);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="review split">
      <div className="review-head">
        <span className="fix-progress-icon"><Scissors size={17} /></span>
        <div className="review-title">
          <b>Разделение класса {target.typeName}</b>
          <span className="muted">
            {target.file}{plan?.totalLines ? ` · ${plan.totalLines} строк · членов: ${plan.members.length}` : ''}
          </span>
        </div>
        {plan && !plan.error && (
          <div className="split-count" role="group" aria-label="Число классов">
            <span className="muted">Классов</span>
            <button className="icon-btn neutral" disabled={loading || applying || count <= 2} onClick={() => setRequested(count - 1)} aria-label="Меньше"><Minus size={14} /></button>
            <b className="split-count-n">{count}</b>
            <button className="icon-btn neutral" disabled={loading || applying || count >= maxParts} onClick={() => setRequested(count + 1)} aria-label="Больше"><Plus size={14} /></button>
            {plan.suggested > 0 && plan.suggested !== count && (
              <button className="btn ghost small" onClick={() => setRequested(plan.suggested)} title="Число классов по размеру и связности кода">рекомендуется {plan.suggested}</button>
            )}
          </div>
        )}
        <button className="icon-btn neutral" onClick={onClose} aria-label="Закрыть" title="Закрыть"><X size={16} /></button>
      </div>

      <div className="review-body">
        {error && <p className="review-warn" role="alert"><TriangleAlert size={14} /> <span className="split-error">{error}</span></p>}
        {loading && !plan && <div className="canvas-loading"><LoaderCircle size={18} className="spin" /> Построение плана</div>}
        {plan && !plan.error && (
          <>
            <p className="hint">
              Исходный класс остаётся точкой входа: в нём конструкторы, main и всё, что переносить нельзя (замок — с причиной).
              Остальные члены разложены по связям: общие поля, взаимные вызовы, слова в именах. Перенесите члены между классами и задайте имена — обращения перепишутся автоматически.
            </p>
            <div className={`split-parts${loading ? ' is-loading' : ''}`}>
              {plan.parts.map((part, i) => (
                <section key={i} className={`split-part${i === 0 ? ' is-origin' : ''}`}>
                  <div className="split-part-head">
                    {i === 0
                      ? <b className="mono">{part.name}</b>
                      : <input className="mono split-name" value={part.name} onChange={(e) => rename(i, e.target.value)} aria-label={`Имя класса ${i + 1}`} spellCheck={false} />}
                    <span className="count">{partLines(part.members)} стр.</span>
                  </div>
                  <span className="split-reason">{i === 0 ? 'исходный класс · ' : 'новый класс · '}{part.reason}</span>
                  <ul className="split-members">
                    {part.members.map((id) => {
                      const m = member.get(id);
                      if (!m) return null;
                      return (
                        <li key={id} title={m.label}>
                          {m.kind === 'method' ? <Box size={13} className="muted" /> : <Variable size={13} className="muted" />}
                          <span className="mono ellipsis">{m.name}{m.kind === 'method' ? '()' : ''}{m.isStatic ? <span className="muted"> static</span> : null}</span>
                          <span className="muted split-lines">{m.lines}</span>
                          {m.pinned
                            ? <span className="split-pin" title={`Остаётся: ${m.pinned}`}><Lock size={12} /></span>
                            : (
                              <select value={i} onChange={(e) => move(id, Number(e.target.value))} aria-label={`Класс для ${m.name}`} disabled={applying}>
                                {plan.parts.map((p, k) => <option key={k} value={k}>{p.name || `Класс ${k + 1}`}</option>)}
                              </select>
                            )}
                        </li>
                      );
                    })}
                    {!part.members.length && <li className="muted">пусто</li>}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>

      {plan && !plan.error && (
        <div className="review-foot">
          <span className="muted review-hint">
            {applying
              ? 'Перенос членов, компиляция и прогон тестов на версиях до и после…'
              : `Новые классы появятся рядом с ${target.file.split('/').pop()}. Результат откроется в ревью — без подтверждения ничего не применится.`}
          </span>
          <button className="btn primary" disabled={loading || applying} onClick={apply}>
            {applying ? <><LoaderCircle size={15} className="spin" /> Разделение…</> : <><Scissors size={15} /> Разделить на {plan.parts.length}</>}
          </button>
        </div>
      )}
    </div>
  );
}
