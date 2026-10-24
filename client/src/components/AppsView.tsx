import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Boxes, Globe, Library, Radio, Server, TriangleAlert, X } from 'lucide-react';
import { Background, Controls, Handle, MarkerType, Panel, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import type { AnalyzeResult, AppInfo, AppLink, ExternalNode, Range } from '../../../shared/types.ts';
import { layoutGraph } from '../layout.ts';
import { LINK } from '../theme.ts';

const APP_W = 230;
const APP_H = 96;
const EXT_W = 190;
const EXT_H = 48;

interface AppStats {
  types: number;
  issues: number;
}

interface AppData extends Record<string, unknown> {
  app: AppInfo;
  stats: AppStats;
  selected: boolean;
}

interface ExtData extends Record<string, unknown> {
  ext: ExternalNode;
  selected: boolean;
}

function AppNode({ data }: NodeProps<Node<AppData>>) {
  const { app, stats, selected } = data;
  const Icon = app.kind === 'service' ? Server : Library;
  return (
    <div className={`app-node is-${app.kind}${selected ? ' is-selected' : ''}`} style={{ width: APP_W }}>
      <Handle type="target" position={Position.Left} />
      <div className="app-head">
        <Icon size={13} strokeWidth={2.25} />
        <span>{app.kind === 'service' ? 'сервис' : 'библиотека'}</span>
      </div>
      <div className="app-name ellipsis" title={app.id}>{app.name}</div>
      <div className="method-meta">
        <span>{stats.types} классов</span>
        {app.endpoints.length > 0 && <span>REST {app.endpoints.length}</span>}
        {app.listens.length > 0 && <span>подписок {new Set(app.listens).size}</span>}
        {stats.issues > 0 && <span className="method-issues"><TriangleAlert size={11} strokeWidth={2.25} /> {stats.issues}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ExtNode({ data }: NodeProps<Node<ExtData>>) {
  const { ext, selected } = data;
  const Icon = ext.kind === 'http' ? Globe : Radio;
  return (
    <div className={`ext-node${selected ? ' is-selected' : ''}`} style={{ width: EXT_W }} title="Вне проекта">
      <Handle type="target" position={Position.Left} />
      <Icon size={13} /> <span className="ellipsis">{ext.label}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { app: AppNode, ext: ExtNode };

/** Подпись ребра: что именно связывает приложения. */
function linkLabel(l: AppLink): string {
  if (l.kind === 'library') return `код · ${l.calls.length}`;
  const details = [...new Set(l.calls.map((c) => c.detail))];
  return details.length > 2 ? `${details.slice(0, 2).join(', ')} +${details.length - 2}` : details.join(', ');
}

type Selection = { kind: 'app' | 'link'; id: string } | null;

interface Props {
  analysis: AnalyzeResult;
  onOpenBoundaries: (appId: string) => void;
  onOpenMethods: (appId: string) => void;
  onPickRange: (range: Range) => void;
}

/** Уровень 1: приложения проекта и связи между ними (HTTP, сообщения, общий код). */
export function AppsView({ analysis, onOpenBoundaries, onOpenMethods, onPickRange }: Props) {
  const { apps, externals, links } = analysis.architecture;
  const [selection, setSelection] = useState<Selection>(null);
  const [pos, setPos] = useState<Map<string, { x: number; y: number }> | null>(null);

  const stats = useMemo(() => {
    const map = new Map<string, AppStats>();
    for (const a of apps) {
      const files = new Set(a.files);
      map.set(a.id, {
        types: analysis.types.filter((t) => files.has(t.file)).length,
        issues: analysis.diagnostics.filter((d) => files.has(d.range.file)).length,
      });
    }
    return map;
  }, [analysis, apps]);

  useEffect(() => {
    let cancelled = false;
    layoutGraph(
      [...apps.map((a) => ({ id: a.id, width: APP_W, height: APP_H })), ...externals.map((e) => ({ id: e.id, width: EXT_W, height: EXT_H }))],
      links.map((l) => ({ id: l.id, source: l.from, target: l.to })),
      'RIGHT',
    ).then((p) => !cancelled && setPos(p));
    return () => {
      cancelled = true;
    };
  }, [apps, externals, links]);

  const nodes = useMemo<Node[]>(
    () => [
      ...apps.map((a) => ({
        id: a.id,
        type: 'app',
        position: pos?.get(a.id) ?? { x: 0, y: 0 },
        data: { app: a, stats: stats.get(a.id)!, selected: selection?.kind === 'app' && selection.id === a.id },
      })),
      ...externals.map((e) => ({
        id: e.id,
        type: 'ext',
        position: pos?.get(e.id) ?? { x: 0, y: 0 },
        data: { ext: e, selected: false },
      })),
    ],
    [apps, externals, pos, stats, selection],
  );

  const edges = useMemo<Edge[]>(
    () =>
      links.map((l) => {
        const color = LINK[l.kind].color;
        const active = selection?.kind === 'link' && selection.id === l.id;
        return {
          id: l.id,
          source: l.from,
          target: l.to,
          type: 'smoothstep',
          label: linkLabel(l),
          labelStyle: { fill: color, fontSize: 11, fontFamily: 'var(--mono)' },
          labelBgStyle: { fill: 'var(--bg-1)' },
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 4,
          interactionWidth: 16,
          style: { stroke: color, strokeWidth: active ? 2.5 : 1.5, strokeDasharray: l.kind === 'library' ? '5 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        };
      }),
    [links, selection],
  );

  if (!pos) return <div className="empty">Раскладка графа…</div>;

  const app = selection?.kind === 'app' ? apps.find((a) => a.id === selection.id) : undefined;
  const link = selection?.kind === 'link' ? links.find((l) => l.id === selection.id) : undefined;
  const nameOf = (id: string) => apps.find((a) => a.id === id)?.name ?? externals.find((e) => e.id === id)?.label ?? id;

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.1}
      nodesDraggable={false}
      onNodeClick={(_, n) => setSelection(n.type === 'app' ? { kind: 'app', id: n.id } : null)}
      onNodeDoubleClick={(_, n) => n.type === 'app' && onOpenBoundaries(n.id)}
      onEdgeClick={(_, e) => setSelection({ kind: 'link', id: e.id })}
      onPaneClick={() => setSelection(null)}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="oklch(0.27 0.014 255)" gap={24} size={1.25} />
      <Controls showInteractive={false} />
      <Panel position="top-left">
        <div className="legend">
          {Object.entries(LINK).map(([kind, meta]) => (
            <span key={kind} style={{ '--kind': meta.color } as CSSProperties} className={`legend-item is-${kind}`}>{meta.title}</span>
          ))}
        </div>
      </Panel>
      {(app || link) && (
        <Panel position="top-right" className="inspector">
          <button className="inspector-close" onClick={() => setSelection(null)} aria-label="Закрыть"><X size={14} /></button>
          {app && (
            <>
              <div className="inspector-title">{app.name}</div>
              <div className="inspector-sub mono">{app.mainClass ?? app.id}</div>
              <div className="inspector-actions">
                <button className="btn" onClick={() => onOpenBoundaries(app.id)}><Boxes size={14} /> Классы</button>
                <button className="btn" onClick={() => onOpenMethods(app.id)}>Методы</button>
              </div>
              {app.endpoints.length > 0 && <h3 className="inspector-h">REST</h3>}
              <ul className="inspector-list">
                {app.endpoints.map((e) => (
                  <li key={`${e.method} ${e.path} ${e.range.start}`}>
                    <button onClick={() => onPickRange(e.range)}><b>{e.method}</b> {e.path}</button>
                  </li>
                ))}
              </ul>
              {app.listens.length > 0 && <h3 className="inspector-h">Подписки</h3>}
              <ul className="inspector-list">
                {[...new Set(app.listens)].map((t) => <li key={t}><span>{t}</span></li>)}
              </ul>
            </>
          )}
          {link && (
            <>
              <div className="inspector-title" style={{ color: LINK[link.kind].color }}>{LINK[link.kind].title}</div>
              <div className="inspector-sub">{nameOf(link.from)} → {nameOf(link.to)}</div>
              <h3 className="inspector-h">Где в коде · {link.calls.length}</h3>
              <ul className="inspector-list">
                {link.calls.map((c, i) => (
                  <li key={i}>
                    <button onClick={() => onPickRange(c.range)} title="Показать в коде">
                      {c.detail}
                      <span className="muted">{c.fromType ?? c.toType}{c.toType && c.fromType ? ` → ${c.toType}` : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}
    </ReactFlow>
  );
}
