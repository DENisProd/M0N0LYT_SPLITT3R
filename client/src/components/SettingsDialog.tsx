import { useEffect, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import type { AppSettings } from '../../../shared/types.ts';
import { api } from '../api.ts';

interface Props {
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
  onClose: () => void;
}

/** Настройки инструмента: локальная LLM для тест-кейсов. Хранятся на сервере в SQLite (Prisma). */
export function SettingsDialog({ settings, onSaved, onClose }: Props) {
  const [draft, setDraft] = useState(settings);
  const [models, setModels] = useState<{ ok: boolean; models: string[]; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Список моделей — по сохранённому адресу; после смены адреса обновится при следующем открытии.
  useEffect(() => {
    api.ollamaModels().then(setModels).catch((e) => setModels({ ok: false, models: [], error: String(e) }));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.saveSettings(draft));
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const modelOptions = [...new Set([draft.ollamaModel, ...(models?.models ?? [])])];

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <button className="inspector-close" onClick={onClose} aria-label="Закрыть"><X size={14} /></button>
        <h2 id="settings-title" className="dialog-title">Настройки</h2>
        <p className="hint">Сохраняются на сервере в SQLite. Тесты, тест-кейсы и выбранный вариант микросервисов сохраняются для каждого проекта автоматически.</p>

        <div className="inspector-h">Локальная LLM (Ollama)</div>
        <label className="field">
          <span>Адрес</span>
          <input value={draft.ollamaUrl} onChange={(e) => setDraft({ ...draft, ollamaUrl: e.target.value })} spellCheck={false} />
        </label>
        <label className="field">
          <span>Модель</span>
          <select className="app-select" value={draft.ollamaModel} onChange={(e) => setDraft({ ...draft, ollamaModel: e.target.value })}>
            {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        {models && !models.ok && <p className="hint is-bad">{models.error}</p>}
        {!models && <p className="hint"><LoaderCircle size={12} className="spin" /> Список моделей…</p>}
        <label className="field">
          <span>Таймаут, с</span>
          <input type="number" min={10} value={Math.round(draft.llmTimeoutMs / 1000)} onChange={(e) => setDraft({ ...draft, llmTimeoutMs: Number(e.target.value) * 1000 })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.llmByDefault} onChange={(e) => setDraft({ ...draft, llmByDefault: e.target.checked })} />
          LLM включена при генерации тест-кейсов
        </label>

        {error && <p className="hint is-bad">Не сохранено: {error}</p>}
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>Отмена</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving && <LoaderCircle size={14} className="spin" />} Сохранить</button>
        </div>
      </div>
    </div>
  );
}
