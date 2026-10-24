import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { CSSProperties } from 'react';
import type { FlowGraph, FlowNode, ScopeCategory, Severity } from '../../../shared/types.ts';
import { Lambda } from 'lucide-react';
import { layoutGraph, nodeWidth } from '../layout.ts';
import { EDGE_COLOR, KIND, SCOPE, SEVERITY } from '../theme.ts';

const NODE_HEIGHT = 62;
const STAGE_HEIGHT = 21;
const CHIPS_HEIGHT = 28;

/** Лямбды, не привязанные к стадиям потока, показываются отдельными ссылками. */
const looseLambdas = (n: FlowNode) => {
  const inStages = new Set(n.stream?.stages.map((s) => s.lambdaId).filter(Boolean));
  return (n.lambdas ?? []).filter((l) => !inStages.has(l.id));
};

const blockWidth = (n: FlowNode) =>
  n.stream ? Math.max(nodeWidth(n.label), ...n.stream.stages.map((s) => nodeWidth(`→ ${s.name}(${s.args})`, 0, 420))) : nodeWidth(n.label);

const blockHeight = (n: FlowNode) =>
  NODE_HEIGHT + (n.stream ? (n.stream.stages.length + 1) * STAGE_HEIGHT + 6 : 0) + (looseLambdas(n).length ? CHIPS_HEIGHT : 0);

interface BlockData extends Record<string, unknown> {
  node: FlowNode;
  severity?: Severity;
  /** Конструкция вне рамок кейса внутри узла. */
  scope?: ScopeCategory;
  editing: boolean;
  /** null — отмена редактирования. */
  onCommit: (node: FlowNode, text: string | null) => void;
  onOpenLambda: (id: string) => void;
}

function LambdaLink({ id, label, onOpen }: { id: string; label: string; onOpen: (id: string) => void }) {
  return (
    <button
      className="lambda-link nodrag"
      title="Открыть блок-схему лямбды"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(id);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Lambda size={11} strokeWidth={2.5} /> {label}
    </button>
  );
}

function BlockNode({ data, selected }: NodeProps<Node<BlockData>>) {
  const { node, severity, scope, editing, onCommit, onOpenLambda } = data;
  const ScopeIcon = scope ? SCOPE[scope].Icon : null;
  const loose = looseLambdas(node);
  const meta = KIND[node.kind];
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) return;
    setDraft(node.code ?? node.label);
    // После двойного клика React Flow фокусирует обёртку узла — забираем фокус кадром позже.
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [editing, node]);

  const commit = () => onCommit(node, draft.trim() && draft !== node.code ? draft : null);

  return (
    <div
      className={`block-node kind-${node.kind}${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}
      style={{ '--kind': meta.color, width: blockWidth(node) } as CSSProperties}
      title={node.editable && !editing ? 'Двойной клик — изменить код блока' : undefined}
    >
      <Handle type="target" position={Position.Top} />
      <div className="block-head">
        <span className="block-icon"><meta.Icon size={12} strokeWidth={2.25} /></span>
        <span className="block-kind">{meta.title}</span>
        {severity && (
          <span className="block-issue" style={{ '--sev': SEVERITY[severity].color } as CSSProperties} title={`Проблема: ${SEVERITY[severity].label.toLowerCase()}`} />
        )}
        {ScopeIcon && (
          <span className="block-scope" title={`${SCOPE[scope!].title} — подробности в списке проблем`}>
            <ScopeIcon size={11} strokeWidth={2.25} />
          </span>
        )}
        {node.stmtRange && <span className="block-line">{node.stmtRange.startLine}</span>}
      </div>
      {editing ? (
        <textarea
          ref={inputRef}
          className="block-input nodrag nowheel"
          value={draft}
          spellCheck={false}
          aria-label="Код блока"
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(8, draft.split('\n').length)}
          onBlur={(e) => e.relatedTarget && commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') onCommit(node, null);
          }}
        />
      ) : node.stream ? (
        <ol className="stream-stages">
          <li className="stream-source">{node.stream.source}</li>
          {node.stream.stages.map((st, i) => (
            <li key={i}>
              <span className="stage-name">{st.name}</span>
              <span className="stage-args">({st.args})</span>
              {st.lambdaId && <LambdaLink id={st.lambdaId} label="" onOpen={onOpenLambda} />}
            </li>
          ))}
        </ol>
      ) : (
        <div className="block-code">{node.label}</div>
      )}
      {!editing && loose.length > 0 && (
        <div className="lambda-links">
          {loose.map((l, i) => (
            <LambdaLink key={l.id} id={l.id} label={loose.length > 1 ? `λ${i + 1}` : 'лямбда'} onOpen={onOpenLambda} />
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { block: BlockNode };

interface Props {
  flow: FlowGraph;
  nodeSeverity: Map<string, Severity>;
  nodeScope: Map<string, ScopeCategory>;
  selectedNodeId: string | null;
  onSelect: (node: FlowNode | null) => void;
  onEdit: (node: FlowNode, text: string) => void;
  onOpenLambda: (id: string) => void;
}

export function FlowView({ flow, nodeSeverity, nodeScope, selectedNodeId, onSelect, onEdit, onOpenLambda }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const onCommit = useCallback(
    (node: FlowNode, text: string | null) => {
      setEditingId(null);
      if (text !== null) onEdit(node, text);
    },
    [onEdit],
  );
  // Раскладка помнит, для какого метода посчитана: ReactFlow рендерим только
  // после первой раскладки, чтобы fitView сработал по реальным координатам.
  const [layout, setLayout] = useState<{ methodId: string; pos: Map<string, { x: number; y: number }> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    layoutGraph(
      flow.nodes.map((n) => ({ id: n.id, width: blockWidth(n), height: blockHeight(n) })),
      flow.edges,
    ).then((pos) => !cancelled && setLayout({ methodId: flow.methodId, pos }));
    return () => {
      cancelled = true;
    };
  }, [flow]);

  // Узлы держим в состоянии React Flow и обновляем, сохраняя прежние объекты
  // (с замерами). Если пересоздавать массив на каждый клик, React Flow
  // перемеряет и на миг прячет узлы — двойной клик «проваливается» в фон.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<BlockData>>([]);
  const appliedLayout = useRef<typeof layout>(null);

  useEffect(() => {
    if (!layout || layout.methodId !== flow.methodId) return;
    const relayout = appliedLayout.current !== layout;
    appliedLayout.current = layout;
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return flow.nodes.map((n) => {
        const o = old.get(n.id);
        return {
          ...o,
          id: n.id,
          type: 'block',
          position: !relayout && o ? o.position : layout.pos.get(n.id) ?? { x: 0, y: 0 },
          selected: n.id === selectedNodeId,
          data: { node: n, severity: nodeSeverity.get(n.id), scope: nodeScope.get(n.id), editing: n.id === editingId, onCommit, onOpenLambda },
        };
      });
    });
  }, [flow, layout, selectedNodeId, nodeSeverity, nodeScope, editingId, onCommit, onOpenLambda, setNodes]);

  const edges = useMemo<Edge[]>(
    () =>
      flow.edges.map((e) => {
        const color = EDGE_COLOR[e.kind ?? 'normal'];
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          type: 'smoothstep',
          animated: e.kind === 'back',
          style: { stroke: color, strokeDasharray: e.kind === 'exception' ? '6 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color },
          labelStyle: { fill: 'oklch(0.86 0.01 255)', fontSize: 11, fontWeight: 500 },
          labelBgStyle: { fill: 'oklch(0.2 0.014 255)' },
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 4,
        };
      }),
    [flow],
  );

  const byId = useMemo(() => new Map(flow.nodes.map((n) => [n.id, n])), [flow]);

  if (layout?.methodId !== flow.methodId || !nodes.length) return <div className="empty">Раскладка графа…</div>;

  return (
    <ReactFlow
      key={flow.methodId}
      nodes={nodes}
      onNodesChange={onNodesChange}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable
      fitView
      minZoom={0.1}
      zoomOnDoubleClick={false}
      onNodeClick={(_, n) => onSelect(byId.get(n.id) ?? null)}
      onNodeDoubleClick={(_, n) => byId.get(n.id)?.editable && setEditingId(n.id)}
      onPaneClick={() => {
        setEditingId(null);
        onSelect(null);
      }}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="oklch(0.27 0.014 255)" gap={24} size={1.25} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        style={{ width: 150, height: 104 }}
        nodeColor={(n) => KIND[(n.data as BlockData).node.kind].color}
        nodeBorderRadius={3}
        maskColor="oklch(0.16 0.012 255 / 0.72)"
      />
    </ReactFlow>
  );
}
