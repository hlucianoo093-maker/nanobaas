import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, unlinkSync
} from "node:fs";
import path from "node:path";

const requiredTables = [
  "projects", "users", "project_members", "sessions", "api_keys", "roles", "permissions",
  "role_permissions", "user_roles", "files", "webhooks", "webhook_deliveries",
  "audit_logs", "collection_records", "auth_tokens"
];

export interface DatabaseVerification {
  databasePath: string;
  migrationCount: number;
  integrity: "ok";
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function currentMigrations(migrationsDirectory: string): { name: string; checksum: string }[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort()
    .map((name) => ({
      name,
      checksum: createHash("sha256").update(readFileSync(path.join(migrationsDirectory, name))).digest("hex")
    }));
}

export function verifyDatabaseFile(
  databasePath: string,
  migrationsDirectory = path.resolve(process.cwd(), "database", "migrations")
): DatabaseVerification {
  const resolvedDatabasePath = path.resolve(databasePath);
  const database = new Database(resolvedDatabasePath, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = database.pragma("integrity_check") as { integrity_check: string }[];
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed for ${resolvedDatabasePath}`);
    }

    database.pragma("foreign_keys = ON");
    const foreignKeyViolations = database.pragma("foreign_key_check") as {
      table: string;
      rowid: number | null;
      parent: string;
      fkid: number;
    }[];
    if (foreignKeyViolations.length > 0) {
      throw new Error(`SQLite foreign key check failed for ${resolvedDatabasePath}`);
    }

    const tableNames = new Set((database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all() as { name: string }[]).map((table) => table.name));
    const missingTables = requiredTables.filter((name) => !tableNames.has(name));
    if (missingTables.length > 0) {
      throw new Error(`Database is missing required tables: ${missingTables.join(", ")}`);
    }

    const appliedMigrations = database.prepare(
      "SELECT name, checksum FROM _nanobaas_migrations ORDER BY name"
    ).all() as { name: string; checksum: string }[];
    const availableMigrations = currentMigrations(migrationsDirectory);
    if (appliedMigrations.length === 0 || appliedMigrations.length > availableMigrations.length) {
      throw new Error(`Database migration history is invalid for ${resolvedDatabasePath}`);
    }
    for (let index = 0; index < appliedMigrations.length; index += 1) {
      const applied = appliedMigrations[index];
      const available = availableMigrations[index];
      if (!applied || !available || applied.name !== available.name || applied.checksum !== available.checksum) {
        throw new Error(`Database migration history does not match this application: ${applied?.name ?? "unknown"}`);
      }
    }

    return { databasePath: resolvedDatabasePath, migrationCount: appliedMigrations.length, integrity: "ok" };
  } finally {
    database.close();
  }
}

async function writeSnapshot(sourcePath: string, destinationPath: string): Promise<void> {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
  if (process.platform !== "win32") chmodSync(destinationPath, 0o600);
}

export async function backupDatabase(
  sourcePath: string,
  destinationPath: string,
  migrationsDirectory?: string
): Promise<DatabaseVerification> {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (samePath(source, destination)) throw new Error("Backup destination must differ from the live database path");
  if (existsSync(destination)) throw new Error(`Backup destination already exists: ${destination}`);
  verifyDatabaseFile(source, migrationsDirectory);
  mkdirSync(path.dirname(destination), { recursive: true });

  const temporaryPath = `${destination}.tmp-${randomUUID()}`;
  let destinationLinked = false;
  try {
    await writeSnapshot(source, temporaryPath);
    const verification = verifyDatabaseFile(temporaryPath, migrationsDirectory);
    linkSync(temporaryPath, destination);
    destinationLinked = true;
    unlinkSync(temporaryPath);
    return { ...verification, databasePath: destination };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (destinationLinked) rmSync(destination, { force: true });
    throw error;
  }
}

export async function restoreDatabase(
  backupPath: string,
  targetPath: string,
  options: { apiStopped: boolean },
  migrationsDirectory?: string
): Promise<{ databasePath: string; safetySnapshotPath?: string }> {
  if (!options.apiStopped) throw new Error("Stop the API and pass --confirm-api-stopped before restoring a database");
  const backup = path.resolve(backupPath);
  const target = path.resolve(targetPath);
  if (samePath(backup, target)) throw new Error("Restore source must differ from the live database path");
  verifyDatabaseFile(backup, migrationsDirectory);
  mkdirSync(path.dirname(target), { recursive: true });

  const temporaryPath = `${target}.restore-${randomUUID()}`;
  const existingFiles = [target, `${target}-wal`, `${target}-shm`].filter(existsSync);
  const safetySnapshotPath = existingFiles.length > 0
    ? `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`
    : undefined;
  const movedFiles: { original: string; saved: string }[] = [];
  let installed = false;

  try {
    await writeSnapshot(backup, temporaryPath);
    verifyDatabaseFile(temporaryPath, migrationsDirectory);

    if (safetySnapshotPath) {
      mkdirSync(safetySnapshotPath);
      for (const original of existingFiles) {
        const saved = path.join(safetySnapshotPath, path.basename(original));
        renameSync(original, saved);
        movedFiles.push({ original, saved });
      }
    }

    renameSync(temporaryPath, target);
    installed = true;
    verifyDatabaseFile(target, migrationsDirectory);
    return {
      databasePath: target,
      ...(safetySnapshotPath ? { safetySnapshotPath } : {})
    };
  } catch (error) {
    if (installed && existsSync(target) && safetySnapshotPath) {
      const restoredFile = path.join(safetySnapshotPath, `${path.basename(target)}.failed-restore`);
      renameSync(target, restoredFile);
    } else if (installed && existsSync(target)) {
      rmSync(target, { force: true });
    }
    for (const moved of movedFiles.reverse()) {
      if (existsSync(moved.saved)) renameSync(moved.saved, moved.original);
    }
    if (safetySnapshotPath && existsSync(safetySnapshotPath) && readdirSync(safetySnapshotPath).length === 0) {
      rmSync(safetySnapshotPath, { recursive: true, force: true });
    }
    throw error;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
