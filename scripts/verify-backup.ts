import { resolve } from "node:path";
import { verifyDatabaseFile } from "./database-operations.js";

const backupPath = process.argv[2];
if (!backupPath) throw new Error("Usage: npm run db:verify -- <backup.sqlite>");

const result = verifyDatabaseFile(resolve(backupPath));
console.log(`Database backup verified: ${result.databasePath} (${result.migrationCount} migrations, integrity ${result.integrity})`);
