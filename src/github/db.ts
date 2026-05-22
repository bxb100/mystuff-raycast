import { LocalStorage } from "@raycast/api";
import { createDb9Client } from "get-db9";
import type { DatabaseResponse, Db9Client } from "get-db9";

export const SELECTED_DATABASE_STORAGE_KEY = "github-stars-db9-database-id";

export type Db9Preferences = {
  "db9-client-token": string;
  "github-token": string;
};

export type Db9Database = Pick<DatabaseResponse, "id" | "name" | "state">;

export type SqlRows = {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  row_count: number;
};

export function createClient(token: string): Db9Client {
  return createDb9Client({ token });
}

export async function listDatabases(token: string): Promise<Db9Database[]> {
  return createClient(token).databases.list();
}

export function isUsableDatabase(database: Db9Database): boolean {
  const state = database.state?.toLowerCase();
  return !state || !["deleted", "deleting", "failed"].includes(state);
}

export async function getStoredDatabaseId(): Promise<string | undefined> {
  return LocalStorage.getItem<string>(SELECTED_DATABASE_STORAGE_KEY);
}

export async function storeDatabaseId(databaseId: string): Promise<void> {
  await LocalStorage.setItem(SELECTED_DATABASE_STORAGE_KEY, databaseId);
}

export async function execSql(token: string, databaseId: string, sql: string): Promise<SqlRows> {
  const result = await createClient(token).databases.sql(databaseId, sql);

  if (result.error) {
    throw new Error(`SQL error: ${formatSqlError(result.error)}`);
  }

  return {
    columns: result.columns,
    rows: result.rows,
    row_count: result.row_count,
  };
}

function formatSqlError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }

  return JSON.stringify(error);
}
