import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export function runMigrations(database: Database.Database, migrationsDir: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _nanobaas_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Map(
    (database.prepare("SELECT name, checksum FROM _nanobaas_migrations").all() as { name: string; checksum: string }[])
      .map((row) => [row.name, row.checksum])
  );
  const files = readdirSync(migrationsDir).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();

  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const previousChecksum = applied.get(file);
    if (previousChecksum) {
      if (previousChecksum !== checksum) throw new Error(`Applied migration was modified: ${file}`);
      continue;
    }

    const applyMigration = database.transaction(() => {
      database.exec(sql);
      database.prepare(
        "INSERT INTO _nanobaas_migrations (name, checksum, applied_at) VALUES (?, ?, ?)"
      ).run(file, checksum, new Date().toISOString());
    });
    applyMigration();
  }
}
