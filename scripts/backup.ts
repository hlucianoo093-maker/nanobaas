import { resolve } from "node:path";
import { loadConfig } from "../apps/api/src/config.js";
import { backupDatabase } from "./database-operations.js";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: npm run db:backup -- <destination.sqlite>");

const configuredPath = loadConfig().DATABASE_PATH;
if (configuredPath === ":memory:") throw new Error("Backups require a persistent SQLite database");
const result = await backupDatabase(resolve(configuredPath), resolve(destination));
console.log(`Verified database backup written to ${result.databasePath} (${result.migrationCount} migrations)`);
