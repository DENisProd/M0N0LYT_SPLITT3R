import type { SourceFile } from '../../shared/types.ts';
import type { ProjectSource } from './project.ts';

// Экспорт копии проекта с изменениями: zip собирается в браузере, исходные файлы на диске не трогаются.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Zip (deflate, имена в UTF-8). Сжатые данные больше исходных — файл кладётся как есть. */
async function zip(entries: { path: string; data: Uint8Array }[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = new TextEncoder().encode(e.path);
    const packed = await deflate(e.data);
    const stored = packed.length >= e.data.length;
    const body = stored ? e.data : packed;
    const crc = crc32(e.data);
    const header = (sig: number, extra: number) => {
      const h = new DataView(new ArrayBuffer(extra));
      h.setUint32(0, sig, true);
      return h;
    };
    const local = header(0x04034b50, 30 + name.length);
    // версия, флаги (бит 11 — UTF-8), метод, время, дата, crc, размеры, длина имени
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, stored ? 0 : 8, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    new Uint8Array(local.buffer).set(name, 30);
    parts.push(local.buffer, body as BlobPart);

    const dir = header(0x02014b50, 46 + name.length);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, stored ? 0 : 8, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, e.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    new Uint8Array(dir.buffer).set(name, 46);
    central.push(new Uint8Array(dir.buffer));
    offset += 30 + name.length + body.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end.buffer]);
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Копия исходника с изменениями: файлы папки проекта с той же структурой, изменённые — с текущим кодом,
 * остальные — байт в байт как на диске. Верхний каталог — «<имя>-fixed», чтобы не перепутать с оригиналом.
 * Возвращает число изменённых файлов в копии.
 */
export async function exportProject(files: SourceFile[], source: ProjectSource | null, name: string, suffix = 'fixed'): Promise<number> {
  const folder = `${name}-${suffix}`;
  const encode = (s: string) => new TextEncoder().encode(s);
  const out: { path: string; data: Uint8Array }[] = [];
  let changed = 0;
  if (source) {
    const current = new Map(files.map((f) => [source.root + f.path, f]));
    const original = new Map(source.imported.map((f) => [source.root + f.path, f.content]));
    for (const e of source.entries) {
      const f = current.get(e.path);
      const edited = !!f && f.content !== original.get(e.path);
      if (edited) changed++;
      // Путь от выбранной папки: её имя заменяется на имя копии.
      const rel = e.path.includes('/') ? e.path.slice(e.path.indexOf('/') + 1) : e.path;
      out.push({ path: `${folder}/${rel}`, data: edited ? encode(f.content) : new Uint8Array(await e.file.arrayBuffer()) });
      current.delete(e.path);
    }
    // Файлы, которых не было в папке (их нет в исходнике — например, пример с сервера).
    for (const [path, f] of current) {
      out.push({ path: `${folder}/${path.includes('/') ? path.slice(path.indexOf('/') + 1) : path}`, data: encode(f.content) });
      changed++;
    }
  } else {
    for (const f of files) out.push({ path: `${folder}/${f.path}`, data: encode(f.content) });
  }
  save(await zip(out), `${folder}.zip`);
  return changed;
}
