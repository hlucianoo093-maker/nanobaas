import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db/index.js";
import { backupDatabase, restoreDatabase, verifyDatabaseFile } from "../../../scripts/database-operations.js";

describe("SQLite database operations", () => {
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  function makeDirectory() {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), "nanobaas-db-ops-"));
    return temporaryDirectory;
  }

  it("creates a consistent, verified backup without overwriting an existing file", async () => {
    const directory = makeDirectory();
    const sourcePath = path.join(directory, "live.sqlite");
    const backupPath = path.join(directory, "backups", "snapshot.sqlite");
    const database = createDatabase(sourcePath);
    database.client.prepare(`
      INSERT INTO projects (id, name, slug, settings, created_at, updated_at)
      VALUES (?, ?, ?, '{}', ?, ?)
    `).run("project-1", "Backup source", "backup-source", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    const result = await backupDatabase(sourcePath, backupPath);
    expect(result.migrationCount).toBe(5);
    expect(verifyDatabaseFile(backupPath).integrity).toBe("ok");

    const snapshot = new Database(backupPath, { readonly: true });
    try {
      expect(snapshot.prepare("SELECT name FROM projects WHERE id = ?").get("project-1"))
        .toEqual({ name: "Backup source" });
    } finally {
      snapshot.close();
    }

    await expect(backupDatabase(sourcePath, backupPath)).rejects.toThrow("Backup destination already exists");
    database.close();
  });

  it("requires a stopped API and restores verified data while preserving the previous database files", async () => {
    const directory = makeDirectory();
    const livePath = path.join(directory, "live.sqlite");
    const backupPath = path.join(directory, "snapshot.sqlite");
    const initial = createDatabase(livePath);
    initial.client.prepare(`
      INSERT INTO projects (id, name, slug, settings, created_at, updated_at)
      VALUES (?, ?, ?, '{}', ?, ?)
    `).run("project-1", "Backup source", "backup-source", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    await backupDatabase(livePath, backupPath);

    await expect(restoreDatabase(backupPath, livePath, { apiStopped: false }))
      .rejects.toThrow("Stop the API");
    initial.client.prepare("UPDATE projects SET name = ? WHERE id = ?").run("Live changes", "project-1");
    initial.close();

    const result = await restoreDatabase(backupPath, livePath, { apiStopped: true });
    expect(result.safetySnapshotPath).toBeTruthy();

    const restored = createDatabase(livePath);
    try {
      expect(restored.client.prepare("SELECT name FROM projects WHERE id = ?").get("project-1"))
        .toEqual({ name: "Backup source" });
    } finally {
      restored.close();
    }

    const previousPath = path.join(result.safetySnapshotPath!, path.basename(livePath));
    const previous = new Database(previousPath, { readonly: true });
    try {
      expect(previous.prepare("SELECT name FROM projects WHERE id = ?").get("project-1"))
        .toEqual({ name: "Live changes" });
    } finally {
      previous.close();
    }
  });

  it("rejects files that are not valid NanoBaaS database backups", () => {
    const directory = makeDirectory();
    const corruptPath = path.join(directory, "corrupt.sqlite");
    writeFileSync(corruptPath, "not a SQLite database");
    expect(() => verifyDatabaseFile(corruptPath)).toThrow();
  });
});
