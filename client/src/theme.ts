import {
  ArrowDownToLine,
  ArrowUpToLine,
  Braces,
  CircleDot,
  Clock,
  CornerDownLeft,
  Cpu,
  Diamond,
  Dices,
  Equal,
  FolderOpen,
  Globe,
  Repeat,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  Split,
  Square,
  SquareFunction,
  Variable,
  Waves,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { FlowNodeKind, LinkKind, ScopeCategory, Severity } from '../../shared/types.ts';

// Цвета типов блоков: одна светлота и насыщенность, различаются только тоном,
// чтобы ни один тип не «кричал» громче остальных. Литералы, а не CSS-переменные:
// MiniMap пишет цвет в SVG-атрибут fill, где var() не работает.
const k = (hue: number, chroma = 0.13) => `oklch(0.76 ${chroma} ${hue})`;

export interface KindMeta {
  title: string;
  color: string;
  Icon: LucideIcon;
}

export const KIND: Record<FlowNodeKind, KindMeta> = {
  start: { title: 'Метод', color: k(285, 0.11), Icon: Workflow },
  end: { title: 'Конец', color: 'oklch(0.66 0.02 255)', Icon: Square },
  variable: { title: 'Переменная', color: k(250), Icon: Variable },
  operation: { title: 'Операция', color: k(185, 0.1), Icon: Equal },
  call: { title: 'Вызов', color: k(220, 0.11), Icon: SquareFunction },
  condition: { title: 'Условие', color: k(80, 0.13), Icon: Diamond },
  loop: { title: 'Цикл', color: k(305, 0.12), Icon: Repeat },
  switch: { title: 'Выбор', color: k(60, 0.13), Icon: Split },
  try: { title: 'try', color: k(345, 0.11), Icon: ShieldCheck },
  catch: { title: 'catch', color: k(15, 0.13), Icon: ShieldAlert },
  finally: { title: 'finally', color: k(345, 0.07), Icon: Braces },
  stream: { title: 'Поток', color: k(200, 0.11), Icon: Waves },
  return: { title: 'Возврат', color: k(150, 0.13), Icon: CornerDownLeft },
  throw: { title: 'Исключение', color: 'oklch(0.7 0.18 25)', Icon: Zap },
  break: { title: 'break', color: 'oklch(0.7 0.03 255)', Icon: ArrowDownToLine },
  continue: { title: 'continue', color: 'oklch(0.7 0.03 255)', Icon: ArrowUpToLine },
  merge: { title: '', color: 'oklch(0.5 0.02 255)', Icon: CircleDot },
};

export const SEVERITY: Record<Severity, { label: string; color: string }> = {
  high: { label: 'Высокая', color: 'oklch(0.7 0.19 25)' },
  medium: { label: 'Средняя', color: 'oklch(0.8 0.14 75)' },
  low: { label: 'Низкая', color: 'oklch(0.74 0.11 245)' },
};

/** Возможности вне рамок кейса: показываем, но не моделируем. */
export const SCOPE: Record<ScopeCategory, { title: string; Icon: LucideIcon; nondeterministic: boolean }> = {
  concurrency: { title: 'Многопоточность', Icon: Cpu, nondeterministic: true },
  reflection: { title: 'Рефлексия', Icon: ScanSearch, nondeterministic: false },
  files: { title: 'Файлы', Icon: FolderOpen, nondeterministic: false },
  network: { title: 'Сеть', Icon: Globe, nondeterministic: true },
  time: { title: 'Время', Icon: Clock, nondeterministic: true },
  random: { title: 'Случайность', Icon: Dices, nondeterministic: true },
};

/** Виды связей между приложениями. */
export const LINK: Record<LinkKind, { title: string; color: string }> = {
  http: { title: 'HTTP', color: k(220, 0.12) },
  messaging: { title: 'Сообщения', color: k(150, 0.12) },
  library: { title: 'Общий код', color: 'oklch(0.62 0.02 255)' },
  data: { title: 'Данные', color: k(300, 0.12) },
};

export const EDGE_COLOR = {
  normal: 'oklch(0.56 0.02 255)',
  back: 'oklch(0.68 0.1 300)',
  exception: 'oklch(0.66 0.17 25)',
};
