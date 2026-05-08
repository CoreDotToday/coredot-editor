import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeE2eDatabaseFiles } from "../../scripts/e2e/prepare";

describe("removeE2eDatabaseFiles", () => {
  it("removes the E2E database and SQLite sidecar files only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coredot-prepare-"));
    const dbPath = join(dir, "coredot-e2e.db");
    const keepPath = join(dir, "keep.db");
    const nestedPath = join(dir, "nested");

    await mkdir(nestedPath);
    await Promise.all([
      writeFile(dbPath, "db"),
      writeFile(`${dbPath}-shm`, "shm"),
      writeFile(`${dbPath}-wal`, "wal"),
      writeFile(`${dbPath}-journal`, "journal"),
      writeFile(keepPath, "keep"),
      writeFile(join(nestedPath, "unrelated.db"), "nested"),
    ]);

    await removeE2eDatabaseFiles(dbPath);

    await expect(readFile(dbPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${dbPath}-shm`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${dbPath}-wal`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${dbPath}-journal`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(keepPath, "utf8")).resolves.toBe("keep");
    await expect(readFile(join(nestedPath, "unrelated.db"), "utf8")).resolves.toBe("nested");
  });
});
