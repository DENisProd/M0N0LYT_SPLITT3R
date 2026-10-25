-- CreateTable
CREATE TABLE "Blob" (
    "hash" TEXT NOT NULL PRIMARY KEY,
    "content" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Commit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectKey" TEXT NOT NULL,
    "parentId" TEXT,
    "message" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "changed" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Ref" (
    "projectKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "commitId" TEXT NOT NULL,

    PRIMARY KEY ("projectKey", "name")
);

-- CreateIndex
CREATE INDEX "Commit_projectKey_idx" ON "Commit"("projectKey");

