import { createDatabase } from "./index.js";
import { loadConfig } from "../config.js";

const database = createDatabase(loadConfig().DATABASE_PATH);
database.close();
console.log("Database migrations applied.");
