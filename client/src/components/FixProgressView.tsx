import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, LoaderCircle, RotateCcw, Square } from 'lucide-react';
import type { FixProgress } from '../../../shared/types.ts';

export interface FixRun {
  started: number;
  /** Проблемы, которые исправляются; null — все исправимые. */
  ids: string[] | null;
  llm: boolean;
  /** Применение паттерна: заголовок вместо «Генерация исправлений», id находки. */
  title?: string;
  patternId?: string;
  events: { p: FixProgress; at: number }[];
  abort: AbortController;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Прошедшее время; тикает само, чтобы не перерисовывать всё приложение раз в секунду. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="elapsed">{clock(now - since)}</span>;
}

interface MethodRow {
  method: string;
  index: number;
  total: number;
  attempt: number;
  maxAttempts: number;
  step: FixProgress['step'];
  since: number;
  ok?: boolean;
  detail?: string;
  /** Причины прошлых попыток: почему модель переписывает снова. */
  retries: string[];
}

const STAGE: Partial<Record<FixProgress['step'], string>> = {
  generate: 'генерация',
  compile: 'компиляция',
  behavior: 'компиляция и тесты',
};

function fold(events: FixRun['events']) {
  const rows = new Map<string, MethodRow>();
  let total = 0;
  for (const { p, at } of events) {
    if (!p.method) continue;
    total = p.total ?? total;
    const row = rows.get(p.method) ?? { method: p.method, index: p.index ?? 0, total, attempt: 1, maxAttempts: p.maxAttempts ?? 1, step: p.step, since: at, retries: [] };
    if (p.step === 'generate' && p.detail) row.retries.push(p.detail);
    if (p.step !== row.step || p.attempt !== row.attempt) row.since = at;
    Object.assign(row, { step: p.step, attempt: p.attempt ?? row.attempt, ok: p.ok, detail: p.step === 'method-done' ? p.detail : undefined });
    rows.set(p.method, row);
  }
  return { rows: [...rows.values()], total };
}

const plural = (n: number, one: string, few: string, many: string) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;

interface Props {
  run: FixRun;
  onCancel: () => void;
}

export function FixProgressView({ run, onCancel }: Props) {
  const last = run.events.at(-1);
  const { rows, total } = fold(run.events);
  const queued = Math.max(0, total - rows.length);
  // До первого метода идёт подготовка: правила, затем сборка проекта для проверки ответов.
  const prep = rows.length ? null : last?.p.step === 'build' ? 'Сборка проекта' : run.patternId ? 'Подготовка' : 'Исправления по правилам';
  const scope = run.patternId ? null : run.ids ? plural(run.ids.length, 'проблема', 'проблемы', 'проблем') : 'все исправимые проблемы';

  return (
    <div className="fix-progress" aria-live="polite" aria-busy="true">
      <div className="fix-progress-bar" aria-hidden="true" />
      <div className="fix-progress-head">
        <h2 className="fix-progress-title">
          {run.title ?? (run.llm ? 'Исправление' : 'Поиск исправлений')}
          {scope && <span className="muted"> · {scope}</span>}
        </h2>
        <Elapsed since={run.started} />
        <button className="btn" onClick={onCancel}><Square size={12} /> Отменить</button>
      </div>

      <ol className="fix-steps">
        {prep && (
          <li className="is-active">
            <LoaderCircle size={14} className="spin" />
            <span className="fix-step-name">{prep}</span>
            {last && <Elapsed since={last.at} />}
          </li>
        )}
        {rows.map((r) => {
          const done = r.step === 'method-done';
          return (
            <li key={r.method} className={done ? (r.ok ? 'is-done' : 'is-failed') : 'is-active'}>
              {done ? r.ok ? <CircleCheck size={14} /> : <CircleX size={14} /> : <LoaderCircle size={14} className="spin" />}
              <span className="fix-step-name mono ellipsis" title={r.method}>{r.method}</span>
              {!done && (
                <span className="fix-step-stage">
                  {STAGE[r.step]}{r.maxAttempts > 1 && `, попытка ${r.attempt}/${r.maxAttempts}`}
                </span>
              )}
              {!done && r.total > 1 && <span className="fix-step-count">{r.index}/{r.total}</span>}
              {!done && <Elapsed since={r.since} />}
              {(r.retries.length > 0 || (done && r.detail)) && (
                <div className="fix-step-body">
                  {r.retries.map((reason, i) => (
                    <div key={i} className="fix-step-retry"><RotateCcw size={11} /> {i + 1}: {reason}</div>
                  ))}
                  {done && r.detail && <div className="fix-step-note">{r.detail}</div>}
                </div>
              )}
            </li>
          );
        })}
        {queued > 0 && <li className="is-queued"><span className="fix-dot" /> <span className="fix-step-name">ещё {plural(queued, 'метод', 'метода', 'методов')} в очереди</span></li>}
      </ol>

      <p className="fix-progress-hint">
        {run.llm ? 'Попытка модели занимает от 30 секунд до нескольких минут. ' : ''}Изменения откроются в ревью и без подтверждения не применятся.
      </p>
    </div>
  );
}
