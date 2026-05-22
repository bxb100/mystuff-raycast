import { createHash } from "node:crypto";
import type { GitHubRepositoryContent } from "./content";
import { execSql } from "./db";

const TABLE_NAME = "github_repositories";
const SEARCH_LIMIT = 50;

export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS embedding;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  repo_full_name TEXT PRIMARY KEY,
  default_branch TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  topic TEXT[] NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL DEFAULT '',
  content_vec vector(1024),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS topic TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS content_vec vector(1024);
ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE ${TABLE_NAME} DROP COLUMN IF EXISTS tsv;
ALTER TABLE ${TABLE_NAME} DROP COLUMN IF EXISTS content;
`;

export const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_github_repositories_embedding
  ON ${TABLE_NAME} USING hnsw (content_vec vector_cosine_ops);
`;

export const FTS_INDEX_SQL = `
DROP INDEX IF EXISTS idx_github_repositories_tsv;
`;

export type GitHubRepositorySearchResult = {
  repoFullName: string;
  defaultBranch: string;
  description: string;
  topic: string[];
  contentHash: string;
  syncedAt?: string;
  score?: number;
  vectorDistance?: number;
  ftsRank?: number;
};

export type GitHubRepositoriesSyncStatus = {
  total: number;
  searchable: number;
  missingVectors: number;
  latestSyncedAt?: string;
};

export function escapeSqlString(s: string): string {
  return (
    s
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "''")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      // https://github.com/db9-ai/community/issues/2
      .replaceAll(" from stdin", " from std_in")
  );
}

export function escapeSqlLiteral(s: string): string {
  return `E'${escapeSqlString(s)}'`;
}

export function escapeSqlTextArray(values: string[]): string {
  if (values.length === 0) {
    return "'{}'";
  }

  return `ARRAY[${values.map((v) => `'${escapeSqlString(v)}'`).join(",")}]`;
}

export function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function initGitHubRepositoriesSchema(options: { db9Token: string; databaseId: string }): Promise<void> {
  await execSql(options.db9Token, options.databaseId, SCHEMA_SQL);
  // TODO: worker subsystem is disabled (DB9_WORKER_ENABLED=false)
  // await execSql(options.db9Token, options.databaseId, INDEX_SQL);
  await execSql(options.db9Token, options.databaseId, FTS_INDEX_SQL);
}

export async function getGitHubRepositoriesSyncStatus(options: {
  db9Token: string;
  databaseId: string;
}): Promise<GitHubRepositoriesSyncStatus> {
  await initGitHubRepositoriesSchema(options);

  const result = await execSql(
    options.db9Token,
    options.databaseId,
    `
SELECT
  COUNT(*)::int AS total,
  COUNT(content_vec)::int AS searchable,
  COUNT(*) FILTER (WHERE content_vec IS NULL)::int AS missing_vectors,
  MAX(synced_at)::text AS latest_synced_at
FROM ${TABLE_NAME};
`,
  );

  const row = result.rows[0] ?? [];

  return {
    total: toNumber(row[0]),
    searchable: toNumber(row[1]),
    missingVectors: toNumber(row[2]),
    latestSyncedAt: toOptionalString(row[3]),
  };
}

export async function getSyncedRepositoryFullNames(options: {
  db9Token: string;
  databaseId: string;
  repoFullNames: string[];
}): Promise<Set<string>> {
  if (options.repoFullNames.length === 0) {
    return new Set();
  }

  await initGitHubRepositoriesSchema(options);

  const result = await execSql(
    options.db9Token,
    options.databaseId,
    buildSelectSyncedRepositoryFullNamesSql(options.repoFullNames),
  );

  return new Set(result.rows.map((row) => String(row[0])));
}

export async function searchRepositories(options: {
  db9Token: string;
  databaseId: string;
  query: string;
}): Promise<GitHubRepositorySearchResult[]> {
  await initGitHubRepositoriesSchema(options);

  const result = await execSql(
    options.db9Token,
    options.databaseId,
    buildSearchRepositoriesSql(options.query, SEARCH_LIMIT),
  );

  return result.rows.map(parseSearchResultRow);
}

export async function rebuildRepositoryVector(options: {
  db9Token: string;
  databaseId: string;
  repoFullName: string;
}): Promise<number> {
  await initGitHubRepositoriesSchema(options);
  const result = await execSql(
    options.db9Token,
    options.databaseId,
    buildRebuildRepositoryVectorSql(options.repoFullName),
  );

  return result.row_count;
}

export async function rebuildAllRepositoryVectors(options: { db9Token: string; databaseId: string }): Promise<number> {
  await initGitHubRepositoriesSchema(options);
  const result = await execSql(options.db9Token, options.databaseId, buildRebuildAllRepositoryVectorsSql());

  return result.row_count;
}

export function buildSelectSyncedRepositoryFullNamesSql(repoFullNames: string[]): string {
  if (repoFullNames.length === 0) {
    return "SELECT repo_full_name FROM github_repositories WHERE false;";
  }

  const values = repoFullNames.map((repoFullName) => `(${escapeSqlLiteral(repoFullName)})`).join(",\n");

  return `
WITH incoming(repo_full_name) AS (
  VALUES
${values}
)
SELECT repositories.repo_full_name
FROM ${TABLE_NAME} repositories
JOIN incoming ON incoming.repo_full_name = repositories.repo_full_name
WHERE repositories.content_hash <> ''
  AND repositories.content_vec IS NOT NULL;
`;
}

export function buildUpsertRepositorySql(repository: GitHubRepositoryContent): string {
  const content = escapeSqlLiteral(repository.content.slice(0, 8000));
  const contentHash = hashContent(content);

  return `
INSERT INTO ${TABLE_NAME} (repo_full_name, default_branch, description, topic, content_hash, content_vec)
VALUES (
  ${escapeSqlLiteral(repository.repoFullName)},
  ${escapeSqlLiteral(repository.defaultBranch)},
  ${escapeSqlLiteral(repository.description)},
  ${escapeSqlTextArray(repository.topic)},
  '${contentHash}',
  embedding(${content})::vector(1024)
)
ON CONFLICT (repo_full_name) DO UPDATE SET
  default_branch = EXCLUDED.default_branch,
  description = EXCLUDED.description,
  topic = EXCLUDED.topic,
  content_hash = EXCLUDED.content_hash,
  content_vec = CASE
    WHEN ${TABLE_NAME}.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN EXCLUDED.content_vec
    ELSE ${TABLE_NAME}.content_vec
  END,
  synced_at = now()
`;
}

export function buildRebuildMissingRepositoryVectorSql(repoFullName: string): string {
  return `
UPDATE ${TABLE_NAME}
SET content_vec = embedding(${buildStoredEmbeddingTextSql()})::vector(1024)
WHERE repo_full_name = ${escapeSqlLiteral(repoFullName)}
  AND content_vec IS NULL;
`;
}

export function buildSearchRepositoriesSql(query: string, limit = SEARCH_LIMIT): string {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return `
SELECT
  repo_full_name,
  default_branch,
  description,
  topic,
  content_hash,
  synced_at::text,
  NULL::double precision AS score,
  NULL::double precision AS vector_distance,
  NULL::double precision AS fts_rank
FROM ${TABLE_NAME}
ORDER BY synced_at DESC, repo_full_name ASC
LIMIT ${limit};
`;
  }

  const queryLiteral = escapeSqlLiteral(trimmedQuery);

  return `
WITH input AS (
  SELECT ${queryLiteral}::text AS raw_query, plainto_tsquery('english', ${queryLiteral}) AS text_query
),
query_vector AS (
  SELECT embedding(raw_query)::vector(1024) AS value
  FROM input
),
repositories_with_text AS (
  SELECT
    repositories.repo_full_name,
    repositories.default_branch,
    repositories.description,
    repositories.topic,
    repositories.content_hash,
    repositories.content_vec,
    repositories.synced_at,
    to_tsvector('english', ${buildStoredEmbeddingTextSql("repositories")}) AS text_vector
  FROM ${TABLE_NAME} repositories
),
fts_candidates AS (
  SELECT
    repositories.repo_full_name,
    repositories.default_branch,
    repositories.description,
    repositories.topic,
    repositories.content_hash,
    repositories.synced_at,
    ts_rank(repositories.text_vector, input.text_query)::double precision AS fts_rank,
    CASE
      WHEN repositories.content_vec IS NULL THEN NULL
      ELSE (repositories.content_vec <=> query_vector.value)::double precision
    END AS vector_distance
  FROM repositories_with_text repositories
  CROSS JOIN input
  CROSS JOIN query_vector
  WHERE repositories.text_vector @@ input.text_query
  ORDER BY ts_rank(repositories.text_vector, input.text_query) DESC
  LIMIT ${limit}
),
vector_candidates AS (
  SELECT
    repositories.repo_full_name,
    repositories.default_branch,
    repositories.description,
    repositories.topic,
    repositories.content_hash,
    repositories.synced_at,
    0::double precision AS fts_rank,
    (repositories.content_vec <=> query_vector.value)::double precision AS vector_distance
  FROM repositories_with_text repositories
  CROSS JOIN query_vector
  WHERE repositories.content_vec IS NOT NULL
  ORDER BY repositories.content_vec <=> query_vector.value
  LIMIT ${limit}
),
combined AS (
  SELECT DISTINCT ON (repo_full_name)
    repo_full_name,
    default_branch,
    description,
    topic,
    content_hash,
    synced_at,
    fts_rank,
    vector_distance
  FROM (
    SELECT * FROM fts_candidates
    UNION ALL
    SELECT * FROM vector_candidates
  ) candidates
  ORDER BY repo_full_name, fts_rank DESC, vector_distance ASC NULLS LAST
)
SELECT
  repo_full_name,
  default_branch,
  description,
  topic,
  content_hash,
  synced_at::text,
  CASE
    WHEN fts_rank > 0 THEN 100 + fts_rank
    WHEN vector_distance IS NULL THEN 0
    ELSE 1 - LEAST(vector_distance, 1)
  END AS score,
  vector_distance,
  fts_rank
FROM combined
ORDER BY (fts_rank > 0) DESC, fts_rank DESC, vector_distance ASC NULLS LAST, synced_at DESC, repo_full_name ASC
LIMIT ${limit};
`;
}

export function buildRebuildRepositoryVectorSql(repoFullName: string): string {
  return `
UPDATE ${TABLE_NAME}
SET content_vec = embedding(${buildStoredEmbeddingTextSql()})::vector(1024)
WHERE repo_full_name = ${escapeSqlLiteral(repoFullName)};
`;
}

export function buildRebuildAllRepositoryVectorsSql(): string {
  return `
UPDATE ${TABLE_NAME}
SET content_vec = embedding(${buildStoredEmbeddingTextSql()})::vector(1024);
`;
}

function parseSearchResultRow(row: unknown[]): GitHubRepositorySearchResult {
  return {
    repoFullName: String(row[0]),
    defaultBranch: String(row[1]),
    description: String(row[2]),
    topic: toStringArray(row[3]),
    contentHash: String(row[4]),
    syncedAt: toOptionalString(row[5]),
    score: toOptionalNumber(row[6]),
    vectorDistance: toOptionalNumber(row[7]),
    ftsRank: toOptionalNumber(row[8]),
  };
}

function buildStoredEmbeddingTextSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `concat_ws(' ', ${prefix}repo_full_name, ${prefix}description, array_to_string(${prefix}topic, ' '))`;
}

function toNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function toOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return JSON.stringify(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item));
}
