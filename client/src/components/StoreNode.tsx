import { Database, HardDrive, Search, Zap } from 'lucide-react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { StoreKind } from '../../../shared/types.ts';

export const STORE_W = 210;
const MAX_TABLES = 6;

/** Высота узла хранилища: заголовок и до шести таблиц. */
export const storeHeight = (tables: number) => 56 + Math.min(tables, MAX_TABLES) * 17 + (tables > MAX_TABLES ? 17 : 0) + (tables ? 6 : 0);

const ICON = { sql: Database, mongodb: HardDrive, cassandra: HardDrive, redis: Zap, elasticsearch: Search } as const;

export interface StoreData extends Record<string, unknown> {
  kind: StoreKind;
  engine: string;
  name: string;
  tables: string[];
  /** Таблицы, к которым ходят и другие сервисы: подсвечиваются. */
  sharedTables?: string[];
  /** Хранилище без адреса в конфигурации и коде. */
  unknown?: boolean;
  selected?: boolean;
}

export function StoreNode({ data }: NodeProps<Node<StoreData>>) {
  const Icon = ICON[data.kind];
  const shared = new Set(data.sharedTables ?? []);
  return (
    <div className={`store-node${data.selected ? ' is-selected' : ''}${data.unknown ? ' is-unknown' : ''}`} style={{ width: STORE_W, height: storeHeight(data.tables.length) }}>
      <Handle type="target" position={Position.Left} />
      <div className="store-head">
        <Icon size={13} strokeWidth={2.25} /> <span>{data.engine}</span>
      </div>
      <div className="store-name ellipsis" title={data.name}>{data.name}</div>
      {data.tables.length > 0 && (
        <ul className="store-tables mono">
          {data.tables.slice(0, MAX_TABLES).map((t) => <li key={t} className={shared.has(t) ? 'is-shared' : ''} title={shared.has(t) ? 'С таблицей работают и другие сервисы' : undefined}>{t}</li>)}
          {data.tables.length > MAX_TABLES && <li className="muted">…ещё {data.tables.length - MAX_TABLES}</li>}
        </ul>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
