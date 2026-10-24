import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Globe, Library, Radio, Server, TriangleAlert } from 'lucide-react';
import { Background, Controls, Handle, MarkerType, Panel, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import type { AnalyzeResult, AppInfo, LinkKind, TypeInfo } from '../../../shared/types.ts';
import { layoutCompound, nodeWidth, type CompoundLayout } from '../layout.ts';
import { EDGE_COLOR, LINK } from '../theme.ts';

const TYPE_H = 62;
const EXT_W = 190;
const EXT_H = 48;

/** Ключ типа: имена классов в разных сервисах совпадают, файл — нет. */
export const typeKey = (t: Pick<TypeInfo, 'file' | 'name'>) => `${t.file}:${t.name}`;

interface TypeData extends Record<string, unknown> {
  type: TypeInfo;
  methods: number;
  rest: number;
  listeners: number;
  issues: number;
}

interface GroupData extends Record<string, unknown> {
  app: AppInfo;
  width: number;
  height: number;
}

function TypeNode({ data }: NodeProps<Node<TypeData>>) {
  const { type, methods, rest, listeners, issues } = data;
  return (
    <div className={`type-node kind-${type.kind}`} style={{ width: nodeWidth(type.name, 150, 300) }}>
      <Handle type="target" position={Position.Left} />
      <div className="type-name ellipsis" title={type.name}>
        <span className="tree-kind">{type.kind}</span> {type.name}
      </div>
      <div className="method-meta">
        <span>{methods} мет.</span>
        {rest > 0 && <span style={{ color: LINK.http.color }}>REST {rest}</span>}
        {listeners > 0 && <span style={{ color: LINK.messaging.color }}>слушатель</span>}
        {issues > 0 && <span className="method-issues"><TriangleAlert size={11} strokeWidth={2.25} /> {issues}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function GroupNode({ data }: NodeProps<Node<GroupData>>) {
  const { app, width, height } = data;
  const Icon = app.kind === 'service' ? Server : Library;
  return (
    <div className={`boundary is-${app.kind}`} style={{ width, height }}>
      <Handle type="target" position={Position.Left} />
      <div className="boundary-title">
        <Icon size={13} strokeWidth={2.25} /> {app.name}
        <span className="muted">{app.kind === 'service' ? 'сервис' : 'библиотека'}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ExtNode({ data }: NodeProps<Node<{ label: string; kind: string }>>) {
  const Icon = data.kind === 'http' ? Globe : Radio;
  return (
    <div className="ext-node" style={{ width: EXT_W }} title="Вне проекта">
      <Handle type="target" position={Position.Left} />
      <Icon size={13} /> <span className="ellipsis">{data.label}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// Не 'group': у встроенного типа React Flow свои рамка и фон.
const nodeTypes = { type: TypeNode, boundary: GroupNode, ext: ExtNode };

interface ClassEdge {
  id: string;
  source: string;
  target: string;
  /** null — вызов внутри приложения. */
  kind: LinkKind | null;
  count: number;
  label?: string;
}

interface Props {
  analysis: AnalyzeResult;
  /** Приложение, на котором сфокусироваться при открытии. */
  focusApp: string | null;
  onOpenType: (appId: string, typeKey: string) => void;
}

/** Уровень 2: классы внутри границ своих приложений; рёбра — вызовы, а между приложениями — HTTP, сообщения, общий код. */
export function BoundaryView({ analysis, focusApp, onOpenType }: Props) {
  const { apps, externals, links } = analysis.architecture;
  const [onlyLinked, setOnlyLinked] = useState(false);
  const [layout, setLayout] = useState<{ key: string; value: CompoundLayout } | null>(null);

  const graph = useMemo(() => {
    const appOfFile = new Map<string, string>();
    for (const a of apps) for (const f of a.files) appOfFile.set(f, a.id);
    const typeOfMethod = new Map<string, string>();
    for (const t of analysis.types) for (const m of t.methods) typeOfMethod.set(m.id, typeKey(t));
    // Тип по имени внутри приложения — для связей, где известно только имя (import, слушатель класса).
    const findType = (name: string | undefined, appId: string) => {
      const t = name ? analysis.types.find((x) => x.name === name && appOfFile.get(x.file) === appId) : undefined;
      return t && typeKey(t);
    };

    const edges = new Map<string, ClassEdge>();
    const add = (source: string | undefined, target: string | undefined, kind: LinkKind | null, label?: string) => {
      if (!source || !target || source === target) return;
      const id = `${kind ?? 'call'}:${source}->${target}`;
      const e = edges.get(id);
      if (e) e.count++;
      else edges.set(id, { id, source, target, kind, count: 1, label });
    };
    for (const c of analysis.callGraph) if (c.kind !== 'lambda') add(typeOfMethod.get(c.from), typeOfMethod.get(c.to), null);
    for (const l of links) {
      for (const c of l.calls) {
        const source = l.from.startsWith('ext:') ? l.from : (c.fromMethodId && typeOfMethod.get(c.fromMethodId)) || findType(c.fromType, l.from);
        // Обработчик не найден — ребро ведёт к рамке приложения-получателя.
        const target = l.to.startsWith('ext:') ? l.to : (c.toMethodId && typeOfMethod.get(c.toMethodId)) || findType(c.toType, l.to) || l.to;
        add(source, target, l.kind, l.kind === 'library' ? undefined : c.detail);
      }
    }

    const linked = new Set([...edges.values()].flatMap((e) => [e.source, e.target]));
    const visibleTypes = analysis.types.filter((t) => !onlyLinked || linked.has(typeKey(t)));
    return { edges: [...edges.values()], visibleTypes, appOfFile };
  }, [analysis, apps, links, onlyLinked]);

  const layoutKey = `${onlyLinked}`;
  useEffect(() => {
    let cancelled = false;
    const groups = apps.map((a) => ({
      id: a.id,
      children: graph.visibleTypes
        .filter((t) => graph.appOfFile.get(t.file) === a.id)
        .map((t) => ({ id: typeKey(t), width: nodeWidth(t.name, 150, 300), height: TYPE_H })),
    }));
    const ids = new Set([...groups.flatMap((g) => [g.id, ...g.children.map((c) => c.id)]), ...externals.map((e) => e.id)]);
    layoutCompound(
      groups,
      externals.map((e) => ({ id: e.id, width: EXT_W, height: EXT_H })),
      graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    ).then((value) => !cancelled && setLayout({ key: layoutKey, value }));
    return () => {
      cancelled = true;
    };
  }, [apps, externals, graph, layoutKey]);

  const nodes = useMemo<Node[]>(() => {
    if (!layout) return [];
    const { groups, nodes: pos } = layout.value;
    const methodsOf = (t: TypeInfo) => t.methods.filter((m) => m.kind !== 'lambda');
    const restOf = (t: TypeInfo) => {
      const ids = new Set(t.methods.map((m) => m.id));
      return apps.flatMap((a) => a.endpoints).filter((e) => e.methodId && ids.has(e.methodId)).length;
    };
    const listenerTypes = new Set(links.flatMap((l) => (l.kind === 'messaging' ? l.calls.map((c) => c.toType) : [])));
    return [
      // Родитель должен идти в массиве раньше детей.
      ...apps.map((a) => {
        const g = groups.get(a.id) ?? { x: 0, y: 0, width: 220, height: 64 };
        return { id: a.id, type: 'boundary', position: { x: g.x, y: g.y }, data: { app: a, width: g.width, height: g.height }, selectable: false, style: { width: g.width, height: g.height } };
      }),
      ...graph.visibleTypes.map((t) => ({
        id: typeKey(t),
        type: 'type',
        parentId: graph.appOfFile.get(t.file),
        position: pos.get(typeKey(t)) ?? { x: 0, y: 0 },
        data: {
          type: t,
          methods: methodsOf(t).length,
          rest: restOf(t),
          listeners: listenerTypes.has(t.name) ? 1 : 0,
          issues: analysis.diagnostics.filter((d) => d.range.file === t.file && d.range.start >= t.range.start && d.range.start <= t.range.end).length,
        },
      })),
      ...externals.map((e) => ({ id: e.id, type: 'ext', position: pos.get(e.id) ?? { x: 0, y: 0 }, data: { label: e.label, kind: e.kind } })),
    ];
  }, [layout, apps, externals, links, graph, analysis]);

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => {
        const color = e.kind ? LINK[e.kind].color : EDGE_COLOR.normal;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'smoothstep',
          label: e.label,
          labelStyle: { fill: color, fontSize: 11, fontFamily: 'var(--mono)' },
          labelBgStyle: { fill: 'var(--bg-1)' },
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 4,
          zIndex: e.kind ? 1 : 0,
          style: { stroke: color, strokeWidth: e.kind && e.kind !== 'library' ? 2 : 1.25, strokeDasharray: e.kind === 'library' ? '5 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        };
      }),
    [graph],
  );

  if (layout?.key !== layoutKey) return <div className="empty">Раскладка графа…</div>;

  const focus = focusApp && apps.some((a) => a.id === focusApp) ? [{ id: focusApp }] : undefined;

  return (
    <ReactFlow
      key={`${layoutKey}|${focusApp}`}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={focus ? { nodes: focus, padding: 0.15 } : undefined}
      minZoom={0.05}
      nodesDraggable={false}
      onNodeClick={(_, n) => n.type === 'type' && n.parentId && onOpenType(n.parentId, n.id)}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="oklch(0.27 0.014 255)" gap={24} size={1.25} />
      <Controls showInteractive={false} />
      <Panel position="top-left" className="panel-row">
        <div className="legend">
          <span className="legend-item" style={{ '--kind': EDGE_COLOR.normal } as CSSProperties}>Вызов</span>
          {Object.entries(LINK).map(([kind, meta]) => (
            <span key={kind} style={{ '--kind': meta.color } as CSSProperties} className={`legend-item is-${kind}`}>{meta.title}</span>
          ))}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={onlyLinked} onChange={(e) => setOnlyLinked(e.target.checked)} />
          <span>Только связанные</span>
        </label>
      </Panel>
    </ReactFlow>
  );
}
