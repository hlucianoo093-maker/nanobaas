import { resolve } from "node:path";
import { loadConfig } from "../apps/api/src/config.js";
import { restoreDatabase } from "./database-operations.js";

const [confirmation, backupPath, ...extra] = process.argv.slice(2);
if (confirmation !== "--confirm-api-stopped" || !backupPath || extra.length > 0) {
  throw new Error("Usage: npm run db:restore -- --confirm-api-stopped <backup.sqlite>");
}

const configuredPath = loadConfig().DATABASE_PATH;
if (configuredPath === ":memory:") throw new Error("Restore requires a persistent SQLite database");
const result = await restoreDatabase(resolve(backupPath), resolve(configuredPath), { apiStopped: true });
console.log(`Database restored to ${result.databasePath}`);
if (result.safetySnapshotPath) console.log(`Previous database files preserved at ${result.safetySnapshotPath}`);
