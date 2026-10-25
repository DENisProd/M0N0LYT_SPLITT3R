import { useMemo, useState } from 'react';
import { Bot, Check, CircleSlash, GitCommitHorizontal, TriangleAlert, Wand, X } from 'lucide-react';
import type { FixResult, SourceFile } from '../../../shared/types.ts';
import { applyHunks, diffFiles, type FileDiff, type Hunk } from '../../../shared/diff.ts';

/**
 * Что показывает ревью:
 *   fix     — предложенные исправления; по умолчанию ничего не применено, принятые фрагменты ложатся на текущий код;
 *   changes — незафиксированные правки относительно HEAD; по умолчанию остаются, отклонённые откатываются;
 *   commit  — изменения коммита относительно родителя, только просмотр.
 */
export interface Review {
  mode: 'fix' | 'changes' | 'commit';
  title: string;
  base: SourceFile[];
  next: SourceFile[];
  fix?: FixResult;
  /** Правка цельная (разделение класса, паттерн): часть фрагментов без остальных не скомпилируется — только всё или ничего. */
  atomic?: boolean;
}

type Decision = 'accept' | 'reject';

interface Props {
  review: Review;
  /** Код изменился после того, как ревью было построено: применять поверх нельзя. */
  outdated: boolean;
  onApply: (files: SourceFile[], summary: { accepted: number; rejected: number }) => void;
  onCommit: (files: SourceFile[], message: string) => void;
  onClose: () => void;
  /** Показать место в редакторе: файл и строка (1-based) текущего кода. */
  onLocate: (path: string, line: number) => void;
}

const CONTEXT = 3;

interface Row {
  kind: 'ctx' | 'del' | 'add';
  old?: number;
  new?: number;
  text: string;
}

function rowsOf(d: FileDiff, i: number): Row[] {
  const h = d.hunks[i];
  const from = Math.max(i ? d.hunks[i - 1].baseEnd : 0, h.baseStart - CONTEXT);
  const to = Math.min(d.hunks[i + 1]?.baseStart ?? d.base.length, h.baseEnd + CONTEXT);
  const shift = h.nextStart - h.baseStart;
  const rows: Row[] = [];
  for (let k = from; k < h.baseStart; k++) rows.push({ kind: 'ctx', old: k + 1, new: k + shift + 1, text: d.base[k] });
  h.removed.forEach((text, k) => rows.push({ kind: 'del', old: h.baseStart + k + 1, text }));
  h.added.forEach((text, k) => rows.push({ kind: 'add', new: h.nextStart + k + 1, text }));
  const after = h.nextStart + h.added.length - h.baseEnd;
  for (let k = h.baseEnd; k < to; k++) rows.push({ kind: 'ctx', old: k + 1, new: k + after + 1, text: d.base[k] });
  return rows;
}

const SIGN = { ctx: ' ', del: '−', add: '+' } as const;

export function ReviewView({ review, outdated, onApply, onCommit, onClose, onLocate }: Props) {
  const diffs = useMemo(() => diffFiles(review.base, review.next), [review]);
  const hunks = useMemo(() => diffs.flatMap((d) => d.hunks), [diffs]);
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const [message, setMessage] = useState('');
  const readOnly = review.mode === 'commit';
  // Без решения: исправление не применяется, а уже сделанная правка остаётся.
  const taken = (h: Hunk) => (decisions.get(h.key) ?? (review.mode === 'fix' ? 'reject' : 'accept')) === 'accept';
  const accepted = hunks.filter((h) => decisions.get(h.key) === 'accept').length;
  const rejected = hunks.filter((h) => decisions.get(h.key) === 'reject').length;
  const undecided = hunks.length - accepted - rejected;

  const decide = (keys: string[], d: Decision | null) =>
    setDecisions((m) => {
      const next = new Map(m);
      for (const k of keys) {
        if (d && next.get(k) !== d) next.set(k, d);
        else next.delete(k);
      }
      return next;
    });
  const result = () => applyHunks(review.base, review.next, diffs, taken);
  const locate = (path: string, h: Hunk) => onLocate(path, (review.mode === 'fix' ? h.baseStart : h.nextStart) + 1);

  return (
    <div className="review">
      <div className="review-head">
        <div className="review-title">
          <b>{review.title}</b>
          <span className="muted">
            {diffs.length} {diffs.length === 1 ? 'файл' : 'файлов'} · {hunks.length} фрагм.
            {!readOnly && ` · принято ${accepted}, отклонено ${rejected}`}
          </span>
        </div>
        {!readOnly && !review.atomic && hunks.length > 0 && (
          <div className="btn-group">
            <button className="btn ghost" onClick={() => setDecisions(new Map(hunks.map((h) => [h.key, 'accept'])))}><Check size={14} /> Принять всё</button>
            <button className="btn ghost" onClick={() => setDecisions(new Map(hunks.map((h) => [h.key, 'reject'])))}><X size={14} /> Отклонить всё</button>
          </div>
        )}
        <button className="icon-btn neutral" onClick={onClose} aria-label="Закрыть ревью" title="Закрыть"><X size={16} /></button>
      </div>

      <div className="review-body">
        {outdated && !readOnly && (
          <p className="review-warn" role="alert"><TriangleAlert size={14} /> Код изменился после построения ревью. Закройте его и запустите снова, иначе правки лягут не туда.</p>
        )}

        {review.fix && (
          <div className="fix-summary">
            {review.fix.applied.map((a, i) => (
              <div key={i} className="fix-item">
                {a.source === 'llm' ? <Bot size={14} className="fix-llm" /> : <Wand size={14} className="is-ok" />}
                <span><b>{a.title}</b> <span className="mono muted">{a.file}:{a.line}</span>{a.note && <span className="fix-note">{a.note}</span>}</span>
                <span className="fix-source">{a.source === 'llm' ? 'LLM' : 'правило'}</span>
              </div>
            ))}
            {review.fix.skipped.length > 0 && (
              <details className="fix-skipped">
                <summary>Не исправлено: {review.fix.skipped.length}</summary>
                {review.fix.skipped.map((s, i) => (
                  <div key={i} className="fix-item">
                    <CircleSlash size={14} className="muted" />
                    <span><b>{s.title}</b> <span className="mono muted">{s.file}:{s.line}</span><span className="fix-note">{s.reason}</span></span>
                  </div>
                ))}
              </details>
            )}
          </div>
        )}

        {hunks.length === 0 && <p className="panel-empty">Изменений нет.</p>}

        {diffs.map((d) => (
          <section key={d.path} className="review-file">
            <div className="review-file-head">
              <span className="mono ellipsis">{d.path}</span>
              {d.status !== 'modified' && <span className="count">{d.status === 'added' ? 'новый' : 'удалён'}</span>}
              {!readOnly && !review.atomic && d.hunks.length > 1 && (
                <span className="btn-group">
                  <button className="btn ghost small" onClick={() => decide(d.hunks.map((h) => h.key), 'accept')}>Принять файл</button>
                  <button className="btn ghost small" onClick={() => decide(d.hunks.map((h) => h.key), 'reject')}>Отклонить файл</button>
                </span>
              )}
            </div>
            {d.hunks.map((h, i) => {
              const state = decisions.get(h.key);
              return (
                <div key={h.key} className={`hunk${state ? ` is-${state}` : ''}`}>
                  <div className="hunk-head">
                    <button className="hunk-loc mono" onClick={() => locate(d.path, h)} disabled={review.mode === 'commit'} title="Показать в коде">
                      строки {h.baseStart + 1}{h.baseEnd - h.baseStart > 1 ? `–${h.baseEnd}` : ''}
                    </button>
                    <span className="hunk-stat"><span className="is-bad">−{h.removed.length}</span> <span className="is-ok">+{h.added.length}</span></span>
                    {!readOnly && !review.atomic && (
                      <span className="hunk-actions">
                        <button className={`btn small${state === 'accept' ? ' is-on-ok' : ''}`} aria-pressed={state === 'accept'} onClick={() => decide([h.key], 'accept')}><Check size={13} /> Принять</button>
                        <button className={`btn small${state === 'reject' ? ' is-on-bad' : ''}`} aria-pressed={state === 'reject'} onClick={() => decide([h.key], 'reject')}><X size={13} /> Отклонить</button>
                      </span>
                    )}
                  </div>
                  <div className="hunk-body mono">
                    {rowsOf(d, i).map((r, k) => (
                      <div key={k} className={`hunk-row is-${r.kind}`}>
                        <span className="ln">{r.old ?? ''}</span>
                        <span className="ln">{r.new ?? ''}</span>
                        <span className="sign">{SIGN[r.kind]}</span>
                        <span className="text">{r.text || ' '}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>

      {!readOnly && review.atomic && hunks.length > 0 && (
        <div className="review-foot">
          <span className="muted review-hint">Фрагменты связаны между собой, поэтому применяются только вместе. Изменения лягут в рабочую копию приложения — файлы на диске не меняются.</span>
          <button className="btn" onClick={onClose}><X size={15} /> Отклонить</button>
          <button className="btn primary" disabled={outdated} onClick={() => onApply(review.next, { accepted: hunks.length, rejected: 0 })}>
            <Check size={15} /> Применить целиком
          </button>
        </div>
      )}

      {!readOnly && !review.atomic && hunks.length > 0 && (
        <div className="review-foot">
          <span className="muted review-hint">
            {review.mode === 'fix'
              ? `Принятые фрагменты лягут в рабочую копию приложения — файлы на диске не меняются${undecided ? `; без решения — ${undecided}, они не применятся` : ''}.`
              : `Отклонённые фрагменты откатятся к HEAD${undecided ? `; без решения — ${undecided}, они останутся` : ''}.`}
          </span>
          {review.mode === 'changes' && (
            <input className="commit-input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Описание версии" aria-label="Описание версии" />
          )}
          {review.mode === 'changes' && (
            <button className="btn" disabled={outdated || !message.trim()} onClick={() => onCommit(result(), message.trim())}>
              <GitCommitHorizontal size={15} /> Зафиксировать принятое
            </button>
          )}
          <button
            className="btn primary"
            disabled={outdated || (review.mode === 'fix' ? !accepted : !rejected)}
            onClick={() => onApply(result(), { accepted: review.mode === 'fix' ? accepted : hunks.length - rejected, rejected })}
          >
            {review.mode === 'fix' ? <><Check size={15} /> Применить принятые ({accepted})</> : <><X size={15} /> Откатить отклонённые ({rejected})</>}
          </button>
        </div>
      )}
    </div>
  );
}
