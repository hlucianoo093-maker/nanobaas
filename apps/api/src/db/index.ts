import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema.js";
import { runMigrations } from "./migrate.js";

export interface DatabaseConnection {
  client: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  close: () => void;
}

export function createDatabase(databasePath: string): DatabaseConnection {
  if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

  const client = new Database(databasePath);
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  client.pragma("synchronous = NORMAL");

  const migrationPath = path.resolve(process.cwd(), "database", "migrations");
  runMigrations(client, migrationPath);

  return {
    client,
    orm: drizzle(client, { schema }),
    close: () => client.close()
  };
}
