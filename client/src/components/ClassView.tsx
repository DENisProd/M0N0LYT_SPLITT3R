import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Lambda, TriangleAlert } from 'lucide-react';
import { Background, Controls, Handle, MarkerType, Panel, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import type { AnalyzeResult, MethodInfo, MethodMetrics } from '../../../shared/types.ts';
import { layoutGraph, nodeWidth } from '../layout.ts';
import { typeKey } from './BoundaryView.tsx';
import { EDGE_COLOR } from '../theme.ts';

// Цвет класса — только идентификация группы, поэтому приглушённые тона одной светлоты.
const PALETTE = [250, 305, 185, 80, 345, 150, 45, 120].map((h) => `oklch(0.76 0.11 ${h})`);

interface MethodData extends Record<string, unknown> {
  method: MethodInfo;
  metrics?: MethodMetrics;
  issues: number;
  color: string;
}

function MethodNode({ data }: NodeProps<Node<MethodData>>) {
  const { method, metrics, issues, color } = data;
  const label = `${method.className}.${method.signature}`;
  const heavy = !!metrics && metrics.maxLoopDepth >= 2;
  if (method.kind === 'lambda') {
    return (
      <div className="method-node is-lambda" style={{ '--kind': color, width: nodeWidth(method.signature, 150, 300) } as CSSProperties}>
        <Handle type="target" position={Position.Left} />
        <div className="method-sig"><Lambda size={12} strokeWidth={2.5} /> {method.signature.replace(/^λ\s*/, '')}</div>
        {metrics && metrics.maxLoopDepth > 0 && <div className="method-meta"><span>{metrics.complexity}</span></div>}
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }
  return (
    <div className="method-node" style={{ '--kind': color, width: nodeWidth(label, 200, 440) } as CSSProperties}>
      <Handle type="target" position={Position.Left} />
      <div className="method-class">{method.className}</div>
      <div className="method-sig">
        {method.typeParameters && <span className="type-params">{method.typeParameters} </span>}
        {method.signature}
      </div>
      <div className="method-meta">
        <span>{method.lines} стр.</span>
        {metrics && <span>CC {metrics.cyclomatic}</span>}
        {metrics && <span className={heavy ? 'is-bad' : ''}>{metrics.complexity}</span>}
        {issues > 0 && (
          <span className="method-issues">
            <TriangleAlert size={11} strokeWidth={2.25} /> {issues}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { method: MethodNode };

interface Props {
  analysis: AnalyzeResult;
  /** Файлы одного приложения; null — весь проект. */
  files?: string[] | null;
  /** Класс (`file:Name`), на методах которого сфокусироваться. */
  focusType?: string | null;
  onOpenMethod: (methodId: string) => void;
}

const methodBox = (m: MethodInfo) =>
  m.kind === 'lambda'
    ? { width: nodeWidth(m.signature, 150, 300), height: 52 }
    : { width: nodeWidth(`${m.className}.${m.signature}`, 200, 440), height: 80 };

/** Обзор монолита: методы, сгруппированные цветом по классам, и граф вызовов. */
export function ClassView({ analysis, files = null, focusType = null, onOpenMethod }: Props) {
  // Лямбд в монолите много — по умолчанию они свёрнуты в свои методы
  // (вызовы изнутри лямбды уже учтены как вызовы метода).
  const [showLambdas, setShowLambdas] = useState(false);
  const lambdaCount = useMemo(() => analysis.types.reduce((n, t) => n + t.methods.filter((m) => m.kind === 'lambda').length, 0), [analysis]);
  const methods = useMemo(() => {
    const inApp = files && new Set(files);
    return analysis.types.flatMap((t) => t.methods).filter((m) => (showLambdas || m.kind !== 'lambda') && (!inApp || inApp.has(m.range.file)));
  }, [analysis, showLambdas, files]);
  const calls = useMemo(() => {
    const visible = new Set(methods.map((m) => m.id));
    return analysis.callGraph.filter((e) => visible.has(e.from) && visible.has(e.to));
  }, [analysis, methods]);
  const [layout, setLayout] = useState<{ key: string; pos: Map<string, { x: number; y: number }> } | null>(null);
  const layoutKey = `${showLambdas}|${files?.join('|') ?? '*'}`;

  useEffect(() => {
    let cancelled = false;
    layoutGraph(
      methods.map((m) => ({ id: m.id, ...methodBox(m) })),
      calls.map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to })),
      'RIGHT',
    )
      .then((pos) => !cancelled && setLayout({ key: layoutKey, pos }))
      .catch((e) => {
        // Раскладка не удалась — показываем методы сеткой, а не пустой холст.
        console.error('Раскладка графа классов:', e);
        if (!cancelled) setLayout({ key: layoutKey, pos: new Map(methods.map((m, i) => [m.id, { x: (i % 6) * 480, y: Math.floor(i / 6) * 120 }])) });
      });
    return () => {
      cancelled = true;
    };
  }, [methods, calls, layoutKey]);

  const nodes = useMemo<Node<MethodData>[]>(() => {
    const colorOf = new Map(analysis.types.map((t, i) => [t.name, PALETTE[i % PALETTE.length]]));
    const metricsOf = new Map(analysis.metrics.map((m) => [m.methodId, m]));
    return methods.map((m) => ({
      id: m.id,
      type: 'method',
      position: layout?.pos.get(m.id) ?? { x: 0, y: 0 },
      data: {
        method: m,
        metrics: metricsOf.get(m.id),
        issues: m.kind === 'lambda' ? 0 : analysis.diagnostics.filter((d) => d.methodId === m.id).length,
        color: colorOf.get(m.className) ?? PALETTE[0],
      },
    }));
  }, [analysis, methods, layout]);

  const edges = useMemo<Edge[]>(
    () =>
      calls.map((e) => {
        const color = e.kind === 'lambda' ? EDGE_COLOR.back : EDGE_COLOR.normal;
        return {
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          type: 'smoothstep',
          style: { stroke: color, strokeDasharray: e.kind === 'lambda' ? '4 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        };
      }),
    [calls],
  );

  if (layout?.key !== layoutKey) return <div className="empty">Раскладка графа…</div>;
  if (!methods.length) return <div className="empty">В приложении нет методов</div>;

  const focused = focusType ? analysis.types.find((t) => typeKey(t) === focusType) : undefined;
  const focus = focused?.methods.filter((m) => methods.includes(m)).map((m) => ({ id: m.id }));

  return (
    <ReactFlow
      key={`${layoutKey}|${focusType}`}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={focus?.length ? { nodes: focus, padding: 0.3, maxZoom: 1.2 } : undefined}
      minZoom={0.1}
      nodesDraggable={false}
      onNodeClick={(_, n) => onOpenMethod(n.id)}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="oklch(0.27 0.014 255)" gap={24} size={1.25} />
      <Controls showInteractive={false} />
      {lambdaCount > 0 && (
        <Panel position="top-left">
          <label className="toggle">
            <input type="checkbox" checked={showLambdas} onChange={(e) => setShowLambdas(e.target.checked)} />
            <span>Лямбды <span className="count">{lambdaCount}</span></span>
          </label>
        </Panel>
      )}
    </ReactFlow>
  );
}
