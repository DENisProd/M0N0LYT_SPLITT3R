import { useMemo, useState } from 'react';
import { Download, Eye, FileDiff, GitCommitHorizontal, History as HistoryIcon, LoaderCircle, Pin, Undo2 } from 'lucide-react';
import type { History } from '../../../shared/types.ts';

interface Props {
  history: History | null;
  /** Файлов, изменённых относительно HEAD. */
  changes: number;
  /** Коммит, зафиксированный как эталон поведения. */
  baselineId: string | null;
  busy: boolean;
  onCommit: (message: string) => void;
  onReviewChanges: () => void;
  onDiscard: () => void;
  onShowCommit: (id: string) => void;
  onCheckout: (id: string) => void;
  onBaseline: (id: string) => void;
  /** Скачать копию проекта в виде этой версии. */
  onExport: (id: string) => void;
}

const time = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function HistoryPanel({ history, changes, baselineId, busy, onCommit, onReviewChanges, onDiscard, onShowCommit, onCheckout, onBaseline, onExport }: Props) {
  const [message, setMessage] = useState('');
  // Коммиты вне цепочки HEAD → корень — другая ветка: так бывает после восстановления старой версии и новой фиксации.
  const ancestry = useMemo(() => {
    const byId = new Map(history?.commits.map((c) => [c.id, c]) ?? []);
    const set = new Set<string>();
    for (let id = history?.head ?? null; id && !set.has(id); id = byId.get(id)?.parentId ?? null) set.add(id);
    return set;
  }, [history]);

  if (!history) return <div className="scroll"><p className="panel-empty"><LoaderCircle size={16} className="spin" /> Загрузка истории версий</p></div>;

  const commit = () => {
    onCommit(message.trim());
    setMessage('');
  };

  return (
    <div className="scroll history">
      <div className="commit-box">
        <input
          className="commit-input"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && changes > 0 && message.trim() && !busy && commit()}
          placeholder={changes ? 'Описание версии: что и зачем изменено' : 'Изменений относительно текущей версии нет'}
          aria-label="Описание версии"
        />
        <button className="btn primary" disabled={!changes || !message.trim() || busy} onClick={commit}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <GitCommitHorizontal size={15} />} Зафиксировать
        </button>
      </div>
      {changes > 0 && (
        <div className="changes-bar">
          <span className="is-warn">Не зафиксировано файлов: {changes}</span>
          <button className="btn ghost small" onClick={onReviewChanges}><FileDiff size={13} /> Просмотреть и принять</button>
          <button className="btn ghost small danger" onClick={onDiscard} disabled={busy}><Undo2 size={13} /> Отменить все</button>
        </div>
      )}

      <ol className="commits">
        {history.commits.map((c) => {
          const isHead = c.id === history.head;
          return (
            <li key={c.id} className={`commit${isHead ? ' is-head' : ''}${ancestry.has(c.id) ? '' : ' is-off'}`} title={ancestry.has(c.id) ? undefined : 'Не в текущей ветке: версия создана до восстановления другой'}>
              <span className="commit-dot" aria-hidden="true" />
              <div className="commit-main">
                <div className="commit-line">
                  <span className="commit-msg ellipsis">{c.message}</span>
                  {isHead && <span className="count is-ok">HEAD</span>}
                  {c.id === baselineId && <span className="count">эталон</span>}
                </div>
                <div className="commit-meta mono">
                  {c.id.slice(0, 7)} · {time(c.createdAt)} · файлов {c.changed}
                </div>
              </div>
              <div className="commit-actions">
                {c.parentId && <button className="icon-btn neutral" onClick={() => onShowCommit(c.id)} title="Изменения этой версии" aria-label="Изменения этой версии"><Eye size={14} /></button>}
                <button className="icon-btn neutral" onClick={() => onExport(c.id)} title="Скачать копию проекта в этой версии" aria-label="Скачать версию"><Download size={14} /></button>
                <button className="icon-btn neutral" onClick={() => onBaseline(c.id)} title="Сделать эталоном поведения" aria-label="Сделать эталоном"><Pin size={14} /></button>
                {!isHead && <button className="icon-btn neutral" onClick={() => onCheckout(c.id)} disabled={busy} title="Восстановить эту версию" aria-label="Восстановить версию"><HistoryIcon size={14} /></button>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
