import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Background, Controls, Handle, MarkerType, Panel, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Boxes, Crosshair, LoaderCircle, Package, RefreshCw, Star, X } from 'lucide-react';
import type { AppInfo, Bottleneck, BottleneckKind, DecompositionChoice, DecompositionResult, DecompositionStrategy, DecompositionType, DecompositionVariant, Range, SourceFile, TypeRole } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { layoutCompound, nodeWidth, type CompoundLayout } from '../layout.ts';
import { EDGE_COLOR, SEVERITY } from '../theme.ts';

const TYPE_H = 50;
const SHARED = '__shared';
const CROSS = 'oklch(0.72 0.17 48)';

const ROLE: Record<TypeRole, string> = {
  entity: 'сущность', repository: 'репозиторий', controller: 'контроллер', listener: 'слушатель',
  service: 'сервис', dto: 'DTO', config: 'конфигурация', other: 'класс',
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

const KIND: Record<BottleneckKind, string> = {
  'hot-endpoint': 'нагрузка', 'cross-aggregate-tx': 'транзакция', 'god-class': 'god-класс',
  'shared-data': 'общие данные', hub: 'центр связей', 'class-cycle': 'цикл',
};

interface TypeData extends Record<string, unknown> {
  type: DecompositionType;
  /** Связей через границу сервиса. */
  cross: number;
  /** Подсветка выбранного узкого места: true — класс затронут, false — приглушён, null — подсветки нет. */
  focus: boolean | null;
}

function TypeNode({ data }: NodeProps<Node<TypeData>>) {
  const { type, cross, focus } = data;
  return (
    <div className={`type-node role-${type.role}${focus ? ' is-focus' : focus === false ? ' is-dim' : ''}`} style={{ width: nodeWidth(type.name, 140, 280) }}>
      <Handle type="target" position={Position.Left} />
      <div className="type-name ellipsis" title={type.name}>{type.name}</div>
      <div className="method-meta">
        <span>{ROLE[type.role]}</span>
        <span>{type.lines} стр.</span>
        {cross > 0 && <span style={{ color: CROSS }}>↔ {cross}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

interface GroupData extends Record<string, unknown> {
  title: string;
  sub: string;
  shared: boolean;
  width: number;
  height: number;
}

function GroupNode({ data }: NodeProps<Node<GroupData>>) {
  return (
    <div className={`boundary${data.shared ? ' is-library' : ''}`} style={{ width: data.width, height: data.height }}>
      <Handle type="target" position={Position.Left} />
      <div className="boundary-title">
        {data.shared ? <Package size={13} strokeWidth={2.25} /> : <Boxes size={13} strokeWidth={2.25} />} {data.title}
        <span className="muted">{data.sub}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { type: TypeNode, boundary: GroupNode };

interface Props {
  /** Проанализированный снимок файлов: распил считается по нему. */
  files: SourceFile[];
  apps: AppInfo[];
  choice: DecompositionChoice;
  onChoiceChange: (c: DecompositionChoice) => void;
  /** Клик по классу — его методы на вкладке «Методы». */
  onOpenType: (typeKey: string) => void;
  /** Показать место в панели кода. */
  onPickRange: (r: Range) => void;
}

/** Варианты распила приложения на микросервисы: метрики, плюсы и минусы, граф сервисов и вызовы через будущие границы. */
export function DecomposeView({ files, apps, choice, onChoiceChange, onOpenType, onPickRange }: Props) {
  const [result, setResult] = useState<DecompositionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'variants' | 'bottlenecks'>('variants');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [layout, setLayout] = useState<{ key: string; value: CompoundLayout } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.decompose(files, choice.appId)
      .then((r) => !cancelled && setResult(r))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [files, choice.appId, reload]);

  const variant: DecompositionVariant | undefined =
    result?.variants.find((v) => v.id === choice.variant) ?? result?.variants.find((v) => v.recommended);
  const focus: Bottleneck | undefined = result?.bottlenecks.find((b) => b.id === focusId);
  const focusSet = useMemo(() => (focus ? new Set(focus.types) : null), [focus]);
  const pick = (id: DecompositionStrategy) => {
    setSelected(null);
    onChoiceChange({ ...choice, variant: id });
  };

  const graph = useMemo(() => {
    if (!result || !variant) return null;
    const groupOf = new Map<string, string>();
    for (const s of variant.services) for (const t of s.types) groupOf.set(t, s.id);
    for (const t of variant.shared) groupOf.set(t, SHARED);
    const crossCount = new Map<string, number>();
    const edges = result.edges.filter((e) => groupOf.has(e.source) && groupOf.has(e.target)).map((e) => {
      const cross = groupOf.get(e.source) !== groupOf.get(e.target) && groupOf.get(e.target) !== SHARED;
      if (cross) {
        crossCount.set(e.source, (crossCount.get(e.source) ?? 0) + 1);
        crossCount.set(e.target, (crossCount.get(e.target) ?? 0) + 1);
      }
      return { id: `${e.source}->${e.target}`, source: e.source, target: e.target, weight: e.weight, cross };
    });
    const types = new Map(result.types.map((t) => [t.key, t]));
    return { groupOf, edges, crossCount, types };
  }, [result, variant]);

  const layoutKey = `${choice.appId}|${variant?.id}|${result?.edges.length}`;
  useEffect(() => {
    if (!graph || !variant) return;
    let cancelled = false;
    const box = (keys: string[]) => keys.map((k) => ({ id: k, width: nodeWidth(graph.types.get(k)?.name ?? k, 140, 280), height: TYPE_H }));
    const groups = [
      ...variant.services.map((s) => ({ id: s.id, children: box(s.types) })),
      ...(variant.shared.length ? [{ id: SHARED, children: box(variant.shared) }] : []),
    ];
    layoutCompound(groups, [], graph.edges).then((value) => !cancelled && setLayout({ key: layoutKey, value }));
    return () => {
      cancelled = true;
    };
  }, [graph, variant, layoutKey]);

  const nodes = useMemo<Node[]>(() => {
    if (!layout || !graph || !variant) return [];
    const { groups, nodes: pos } = layout.value;
    const frame = (id: string) => groups.get(id) ?? { x: 0, y: 0, width: 220, height: 64 };
    return [
      ...variant.services.map((s) => {
        const g = frame(s.id);
        const sub = [`${s.types.length} кл.`, `${s.lines} стр.`, s.endpoints.length ? `${s.endpoints.length} эндп.` : ''].filter(Boolean).join(' · ');
        return { id: s.id, type: 'boundary', position: { x: g.x, y: g.y }, data: { title: s.name, sub, shared: false, width: g.width, height: g.height }, style: { width: g.width, height: g.height } };
      }),
      ...(variant.shared.length ? [(() => {
        const g = frame(SHARED);
        return { id: SHARED, type: 'boundary', position: { x: g.x, y: g.y }, data: { title: 'общий модуль', sub: 'библиотека', shared: true, width: g.width, height: g.height }, style: { width: g.width, height: g.height } };
      })()] : []),
      ...[...graph.groupOf].map(([key, group]) => ({
        id: key,
        type: 'type',
        parentId: group,
        position: pos.get(key) ?? { x: 0, y: 0 },
        data: { type: graph.types.get(key)!, cross: graph.crossCount.get(key) ?? 0, focus: focusSet ? focusSet.has(key) : null },
      })),
    ];
  }, [layout, graph, variant, focusSet]);

  const edges = useMemo<Edge[]>(() => (graph?.edges ?? []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'smoothstep',
    zIndex: e.cross ? 1 : 0,
    style: {
      stroke: e.cross ? CROSS : EDGE_COLOR.normal,
      strokeWidth: e.cross ? 2 : 1,
      opacity: focusSet && !(focusSet.has(e.source) && focusSet.has(e.target)) ? 0.12 : e.cross ? 1 : 0.55,
    },
    markerEnd: { type: MarkerType.ArrowClosed, color: e.cross ? CROSS : EDGE_COLOR.normal },
  })), [graph, focusSet]);

  const service = variant?.services.find((s) => s.id === selected);
  const multiApp = apps.length > 1;

  return (
    <div className="decompose">
      <aside className="variants" aria-label="Варианты распила">
        <div className="variants-head">
          {multiApp && (
            <select className="app-select" value={choice.appId ?? result?.appId ?? ''} aria-label="Приложение"
              onChange={(e) => onChoiceChange({ appId: e.target.value || null, variant: null })}>
              {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          {!multiApp && <b>{result?.appName ?? 'Проект'}</b>}
          <button className="icon-btn" onClick={() => setReload((n) => n + 1)} disabled={loading} aria-label="Пересчитать" title="Пересчитать по текущему коду">
            {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
        {error && <p className="hint is-bad">Распил не посчитан: {error}</p>}
        {result && (
          <div className="seg" role="tablist" aria-label="Раздел">
            <button role="tab" aria-selected={tab === 'variants'} onClick={() => setTab('variants')}>
              Варианты <span className="count">{result.variants.length}</span>
            </button>
            <button role="tab" aria-selected={tab === 'bottlenecks'} onClick={() => setTab('bottlenecks')}>
              Узкие места <span className={`count${result.bottlenecks.some((b) => b.severity === 'high') ? ' is-bad' : ''}`}>{result.bottlenecks.length}</span>
            </button>
          </div>
        )}
        {tab === 'bottlenecks' && result && (
          <BottleneckList items={result.bottlenecks} focusId={focusId} onFocus={(id) => setFocusId(id === focusId ? null : id)} onPickRange={onPickRange} />
        )}
        {tab === 'variants' && result && !result.variants.length && <p className="hint">Вариантов нет.</p>}
        {tab === 'variants' && result?.variants.map((v) => (
          <button key={v.id} className={`variant${v.id === variant?.id ? ' is-active' : ''}`} onClick={() => pick(v.id)} aria-pressed={v.id === variant?.id}>
            <div className="variant-head">
              <b>{v.title}</b>
              {v.recommended && <span className="count is-ok"><Star size={11} /> лучший</span>}
              <span className={`variant-score ${v.score >= 60 ? 'is-ok' : v.score >= 40 ? 'is-warn' : 'is-bad'}`}>{v.score}</span>
            </div>
            <p className="variant-desc">{v.description}</p>
            <div className="variant-metrics">
              <span title="Число сервисов">{v.metrics.services} серв.</span>
              <span title="Доля связей внутри сервисов">связн. {pct(v.metrics.cohesion)}</span>
              <span title="Модулярность разбиения (Newman)">Q {v.metrics.modularity.toFixed(2)}</span>
              <span title="Циклов между сервисами" className={v.metrics.cycles.length ? 'is-bad' : ''}>циклов {v.metrics.cycles.length}</span>
              <span title="Сущностей, нужных нескольким сервисам" className={v.metrics.sharedEntities.length ? 'is-warn' : ''}>общих сущн. {v.metrics.sharedEntities.length}</span>
              {v.metrics.distributedTransactions > 0 && (
                <span title="Транзакций, которые этот разрез делает распределёнными" className="is-bad">распр. транз. {v.metrics.distributedTransactions}</span>
              )}
            </div>
            {v.id === variant?.id && (
              <ul className="variant-points">
                {v.pros.map((p) => <li key={p} className="is-ok">+ {p}</li>)}
                {v.cons.map((c) => <li key={c} className="is-bad">− {c}</li>)}
              </ul>
            )}
          </button>
        ))}
        {tab === 'variants' && result && (result.notes.length > 0 || result.infra.length > 0 || result.isolated.length > 0) && (
          <div className="variant-notes">
            {result.infra.length > 0 && <p>Конфигурация в каждый сервис: {result.infra.map((k) => k.split(':').pop()).join(', ')}.</p>}
            {result.isolated.length > 0 && <p>Без связей (в любой сервис): {result.isolated.map((k) => k.split(':').pop()).join(', ')}.</p>}
            {result.notes.map((n) => <p key={n}>{n}</p>)}
          </div>
        )}
        {tab === 'variants' && (
          <p className="variant-notes">
            Оценка — эвристика: 50% за связи внутри сервисов, 50% за модулярность; минус 12 за цикл, 5 за общую сущность, 6 за распределённую транзакцию (до 18), 20 если один сервис больше 70% кода.
          </p>
        )}
      </aside>

      <div className="decompose-graph">
        {!result && loading && <div className="empty"><LoaderCircle size={16} className="spin" /> Поиск вариантов распила</div>}
        {result && !variant && <div className="empty">Нет вариантов для показа</div>}
        {variant && layout?.key !== layoutKey && <div className="empty">Раскладка графа…</div>}
        {variant && layout?.key === layoutKey && (
          <ReactFlow
            key={layoutKey}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.05}
            nodesDraggable={false}
            onNodeClick={(_, n) => (n.type === 'type' ? onOpenType(n.id) : n.id !== SHARED && setSelected(n.id))}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="oklch(0.27 0.014 255)" gap={24} size={1.25} />
            <Controls showInteractive={false} />
            <Panel position="top-left" className="panel-row">
              <div className="legend">
                <span className="legend-item" style={{ '--kind': EDGE_COLOR.normal } as CSSProperties}>Внутри сервиса</span>
                <span className="legend-item" style={{ '--kind': CROSS } as CSSProperties}>Через границу — станет API или событием</span>
              </div>
            </Panel>
            <Panel position="top-right" className="inspector">
              {focus ? (
                <>
                  <button className="inspector-close" onClick={() => setFocusId(null)} aria-label="Снять подсветку"><X size={14} /></button>
                  <div className="inspector-title">{focus.title}</div>
                  <div className="inspector-sub">{KIND[focus.kind]} · важность: {SEVERITY[focus.severity].label.toLowerCase()}{focus.types.some((t) => !graph?.groupOf.has(t)) ? ' · часть классов не входит в этот вариант' : ''}</div>
                  <p className="inspector-sub">{focus.recommendation}</p>
                  {focus.evidence.length > 0 && (
                    <>
                      <div className="inspector-h">Подробности</div>
                      <ul className="inspector-list">
                        {focus.evidence.map((e, i) => (
                          <li key={i}>
                            {e.range ? (
                              <button onClick={() => onPickRange(e.range!)} title={`${e.range.file}:${e.range.startLine}`}><span className="dep-call">{e.text}</span></button>
                            ) : (
                              <span className="dep-call">{e.text}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : service ? (
                <>
                  <button className="inspector-close" onClick={() => setSelected(null)} aria-label="Закрыть"><X size={14} /></button>
                  <div className="inspector-title">{service.name}</div>
                  <div className="inspector-sub">{service.types.length} классов · {service.lines} строк</div>
                  {service.entities.length > 0 && (<><div className="inspector-h">Данные</div><p className="inspector-sub mono">{service.entities.join(', ')}</p></>)}
                  {service.endpoints.length > 0 && (
                    <>
                      <div className="inspector-h">Эндпоинты</div>
                      <ul className="inspector-list">{service.endpoints.map((e) => <li key={e}><span>{e}</span></li>)}</ul>
                    </>
                  )}
                  <DependencyList variant={variant} filter={service.id} />
                </>
              ) : (
                <>
                  <div className="inspector-title">{variant.title}</div>
                  <div className="inspector-sub">Клик по рамке — детали сервиса, по классу — его методы</div>
                  <DependencyList variant={variant} />
                </>
              )}
            </Panel>
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

/** Зависимости между сервисами с вызовами, которые придётся заменить API или событиями. */
function DependencyList({ variant, filter }: { variant: DecompositionVariant; filter?: string }) {
  const deps = variant.dependencies.filter((d) => !filter || d.from === filter || d.to === filter);
  if (!deps.length) return <p className="inspector-sub">Зависимостей от других сервисов нет.</p>;
  return (
    <>
      <div className="inspector-h">Вызовы через границы</div>
      <ul className="inspector-list">
        {deps.map((d) => (
          <li key={`${d.from}->${d.to}`}>
            <span>
              <b>{d.from} → {d.to}</b>
              <span className="muted">вес связи {d.weight}{d.calls.length ? `, вызовов ${d.calls.length}` : ', только типы и поля'}</span>
              {d.calls.slice(0, 6).map((c) => <span key={c} className="dep-call">{c}</span>)}
              {d.calls.length > 6 && <span className="muted">…ещё {d.calls.length - 6}</span>}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Узкие места монолита: клик подсвечивает затронутые классы на графе, второй клик снимает подсветку. */
function BottleneckList({ items, focusId, onFocus, onPickRange }: { items: Bottleneck[]; focusId: string | null; onFocus: (id: string) => void; onPickRange: (r: Range) => void }) {
  if (!items.length) return <p className="hint">Узких мест не найдено: нет god-классов, общих таблиц, циклов, транзакций через агрегаты и тяжёлых эндпоинтов.</p>;
  return (
    <>
      {items.map((b) => (
        <div
          key={b.id}
          className={`diag bottleneck${b.id === focusId ? ' is-selected' : ''}`}
          style={{ '--sev': SEVERITY[b.severity].color } as CSSProperties}
          role="button"
          tabIndex={0}
          aria-pressed={b.id === focusId}
          onClick={() => onFocus(b.id)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            onFocus(b.id);
          }}
        >
          <span className="diag-body">
            <span className="diag-head">
              <b>{b.title}</b>
              <span className="diag-loc">{KIND[b.kind]}</span>
            </span>
            <span className="diag-msg">{b.message}</span>
            {b.range && (
              <button
                className="link-btn"
                title={`${b.range.file}:${b.range.startLine}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (b.id !== focusId) onFocus(b.id);
                  onPickRange(b.range!);
                }}
              >
                <Crosshair size={12} /> к коду · {b.range.file.split('/').pop()}:{b.range.startLine}
              </button>
            )}
          </span>
        </div>
      ))}
    </>
  );
}
