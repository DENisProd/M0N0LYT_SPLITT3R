import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

export interface LayoutInput {
  id: string;
  width: number;
  height: number;
}

/** Слоистая раскладка сверху вниз — классическая блок-схема. */
export async function layoutGraph(
  nodes: LayoutInput[],
  edges: { id: string; source: string; target: string }[],
  direction: 'DOWN' | 'RIGHT' = 'DOWN',
): Promise<Map<string, { x: number; y: number }>> {
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.layered.spacing.nodeNodeBetweenLayers': '50',
      'elk.spacing.nodeNode': '40',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const pos = new Map<string, { x: number; y: number }>();
  for (const c of result.children ?? []) pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return pos;
}

export interface LayoutGroup {
  id: string;
  children: LayoutInput[];
}

export interface CompoundLayout {
  /** Рамки групп в координатах холста. */
  groups: Map<string, { x: number; y: number; width: number; height: number }>;
  /** Узлы: внутри группы — относительно её угла (так их ждёт React Flow с parentId). */
  nodes: Map<string, { x: number; y: number }>;
}

/** Слоистая раскладка с вложенностью: узлы внутри рамок групп, рёбра — и между группами. */
export async function layoutCompound(
  groups: LayoutGroup[],
  loose: LayoutInput[],
  edges: { id: string; source: string; target: string }[],
): Promise<CompoundLayout> {
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '60',
      'elk.spacing.nodeNode': '28',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
    },
    children: [
      ...groups.map((g) => ({
        id: g.id,
        // Пустая группа без размеров схлопнулась бы в точку.
        ...(g.children.length ? {} : { width: 220, height: 64 }),
        layoutOptions: { 'elk.padding': '[top=48,left=18,bottom=18,right=18]' },
        children: g.children.map((n) => ({ id: n.id, width: n.width, height: n.height })),
      })),
      ...loose.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    ],
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const out: CompoundLayout = { groups: new Map(), nodes: new Map() };
  const groupIds = new Set(groups.map((g) => g.id));
  for (const c of result.children ?? []) {
    if (groupIds.has(c.id)) {
      out.groups.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 });
      for (const n of c.children ?? []) out.nodes.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
    } else {
      out.nodes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
    }
  }
  return out;
}

/** Оценка ширины узла по длине подписи (моноширинный шрифт ~7px/символ). */
export function nodeWidth(label: string, min = 140, max = 380): number {
  return Math.min(max, Math.max(min, label.length * 7.2 + 56));
}
