import { useEffect, useState } from 'react';
import { Bot, CircleCheck, CircleX, LoaderCircle, RotateCcw, Square, Wand } from 'lucide-react';
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
  generate: 'LLM пишет код',
  compile: 'Компиляция',
  behavior: 'Компиляция и прогон тестов',
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

interface Props {
  run: FixRun;
  onCancel: () => void;
}

export function FixProgressView({ run, onCancel }: Props) {
  const steps = run.events.map((e) => e.p.step);
  const last = run.events.at(-1);
  const { rows, total } = fold(run.events);
  const building = last?.p.step === 'build';
  const llmStarted = rows.length > 0;
  const queued = Math.max(0, total - rows.length);

  return (
    <div className="fix-progress" aria-live="polite">
      <div className="fix-progress-bar" aria-hidden="true" />
      <div className="fix-progress-head">
        <span className="fix-progress-icon">{run.llm ? <Bot size={18} /> : <Wand size={18} />}</span>
        <div className="fix-progress-title">
          <b>{run.title ?? (run.llm ? 'Генерация исправлений' : 'Поиск исправлений')}</b>
          <span className="muted">
            {run.patternId ? 'Паттерн проектирования' : run.ids ? `Проблем: ${run.ids.length}` : 'Все исправимые проблемы'} · <Elapsed since={run.started} />
          </span>
        </div>
        <button className="btn" onClick={onCancel}><Square size={13} /> Отменить</button>
      </div>

      <ol className="fix-steps">
        <li className={steps.length > 1 ? 'is-done' : 'is-active'}>
          {steps.length > 1 ? <CircleCheck size={15} /> : <LoaderCircle size={15} className="spin" />}
          <span>{run.patternId ? 'Подготовка' : 'Точные исправления по правилам'}</span>
        </li>
        {run.llm && (steps.includes('build') || llmStarted) && (
          <li className={llmStarted ? 'is-done' : 'is-active'}>
            {llmStarted ? <CircleCheck size={15} /> : <LoaderCircle size={15} className="spin" />}
            <span>Сборка проекта до правок — чтобы проверять ответы LLM</span>
            {building && <Elapsed since={last!.at} />}
          </li>
        )}
        {rows.map((r) => {
          const done = r.step === 'method-done';
          return (
            <li key={r.method} className={done ? (r.ok ? 'is-done' : 'is-failed') : 'is-active'}>
              {done ? r.ok ? <CircleCheck size={15} /> : <CircleX size={15} /> : <LoaderCircle size={15} className="spin" />}
              <div className="fix-step-body">
                <div className="fix-step-line">
                  <span className="mono ellipsis">{r.method}</span>
                  {r.total > 1 && <span className="muted">{r.index} из {r.total}</span>}
                </div>
                {!done && (
                  <div className="fix-step-stage">
                    {STAGE[r.step]} · попытка {r.attempt} из {r.maxAttempts} · <Elapsed since={r.since} />
                  </div>
                )}
                {r.retries.map((reason, i) => (
                  <div key={i} className="fix-step-retry"><RotateCcw size={12} /> Попытка {i + 1}: {reason}</div>
                ))}
                {done && r.detail && <div className="fix-step-note">{r.detail}</div>}
              </div>
            </li>
          );
        })}
        {queued > 0 && <li className="is-queued"><span className="fix-dot" /> <span>В очереди методов: {queued}</span></li>}
      </ol>

      <p className="hint fix-progress-hint">
        {run.llm
          ? 'Одна попытка локальной модели — от 30 секунд до нескольких минут. Ответ проверяется компиляцией и тестами; если не прошёл, ошибки уходят модели. Без вашего подтверждения ничего не применится.'
          : 'Без вашего подтверждения ничего не применится.'}
      </p>
    </div>
  );
}
