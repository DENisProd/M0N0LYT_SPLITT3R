import { createHash } from 'node:crypto';
import type { CommitInfo, History, SourceFile } from '../../shared/types.ts';
import type { Prisma } from './generated/prisma/client.ts';
import { prisma } from './store.ts';

// Версии проекта по образцу git: содержимое файлов хранится один раз по хешу (blob),
// коммит — список { path, blob } со ссылкой на родителя, HEAD — ссылка на текущий коммит.

type Tree = { path: string; blob: string }[];

const HEAD = 'HEAD';
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

function toInfo(c: { id: string; parentId: string | null; message: string; createdAt: Date; changed: number }): CommitInfo {
  return { id: c.id, parentId: c.parentId, message: c.message, createdAt: c.createdAt.toISOString(), changed: c.changed };
}

export async function getHistory(projectKey: string): Promise<History> {
  const [rows, head] = await Promise.all([
    prisma.commit.findMany({ where: { projectKey }, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.ref.findUnique({ where: { projectKey_name: { projectKey, name: HEAD } } }),
  ]);
  return { commits: rows.map(toInfo), head: head?.commitId ?? null };
}

export async function getCommitFiles(projectKey: string, id: string): Promise<SourceFile[] | null> {
  const commit = await prisma.commit.findFirst({ where: { projectKey, id } });
  if (!commit) return null;
  const tree = commit.files as unknown as Tree;
  const blobs = await prisma.blob.findMany({ where: { hash: { in: tree.map((f) => f.blob) } } });
  const content = new Map(blobs.map((b) => [b.hash, b.content]));
  return tree.map((f) => ({ path: f.path, content: content.get(f.blob) ?? '' }));
}

/** Новый коммит поверх parentId; HEAD переходит на него. */
export async function createCommit(projectKey: string, message: string, files: SourceFile[], parentId: string | null): Promise<CommitInfo> {
  const tree: Tree = files.map((f) => ({ path: f.path, blob: sha1(f.content) }));
  const parent = parentId ? await prisma.commit.findFirst({ where: { projectKey, id: parentId } }) : null;
  const before = new Map(((parent?.files ?? []) as unknown as Tree).map((f) => [f.path, f.blob]));
  const changed = tree.filter((f) => before.get(f.path) !== f.blob).length + [...before.keys()].filter((p) => !tree.some((f) => f.path === p)).length;
  const createdAt = new Date();
  const id = sha1(JSON.stringify({ tree, parent: parent?.id ?? null, message, at: createdAt.toISOString() })).slice(0, 10);

  const known = new Set((await prisma.blob.findMany({ where: { hash: { in: tree.map((f) => f.blob) } }, select: { hash: true } })).map((b) => b.hash));
  const fresh = new Map(files.map((f, i) => [tree[i].blob, f.content] as const).filter(([hash]) => !known.has(hash)));
  const commit = await prisma.$transaction(async (tx) => {
    if (fresh.size) await tx.blob.createMany({ data: [...fresh].map(([hash, content]) => ({ hash, content })) });
    const row = await tx.commit.create({
      data: { id, projectKey, parentId: parent?.id ?? null, message, files: tree as unknown as Prisma.InputJsonArray, changed, createdAt },
    });
    await tx.ref.upsert({
      where: { projectKey_name: { projectKey, name: HEAD } },
      create: { projectKey, name: HEAD, commitId: id },
      update: { commitId: id },
    });
    return row;
  });
  return toInfo(commit);
}

/** Переключение HEAD (checkout): файлы рабочей копии клиент берёт из getCommitFiles. */
export async function setHead(projectKey: string, id: string): Promise<boolean> {
  if (!(await prisma.commit.findFirst({ where: { projectKey, id } }))) return false;
  await prisma.ref.upsert({
    where: { projectKey_name: { projectKey, name: HEAD } },
    create: { projectKey, name: HEAD, commitId: id },
    update: { commitId: id },
  });
  return true;
}
