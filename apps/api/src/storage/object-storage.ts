import { createReadStream, mkdirSync, type ReadStream } from "node:fs";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  open(key: string): Promise<ReadStream>;
  remove(key: string): Promise<void>;
}

export class LocalObjectStorage implements ObjectStorage {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolveKey(key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
          throw cleanupError;
        }
      }
      throw error;
    }
  }

  async open(key: string): Promise<ReadStream> {
    const target = this.resolveKey(key);
    const details = await stat(target);
    if (!details.isFile()) throw new Error("Stored object is not a regular file");
    return createReadStream(target);
  }

  async remove(key: string): Promise<void> {
    await unlink(this.resolveKey(key));
  }

  private resolveKey(key: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
      throw new Error("Invalid storage key");
    }
    return path.join(this.directory, `${key}.blob`);
  }
}
