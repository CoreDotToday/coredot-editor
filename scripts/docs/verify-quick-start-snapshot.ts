import { spawn } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import { createToolEnvironment } from "./verify-quick-start-shared";

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

type SnapshotEntry = {
  file: string;
  objectId: string;
};

type SnapshotHooks = {
  afterIndexPopulation?: () => Promise<void>;
  afterSafeOpen?: (file: string) => Promise<void>;
  noFollowFlag?: number | null;
};

function validateRepositoryRelativePath(file: string) {
  if (
    file === "" ||
    file.includes("\\") ||
    file.includes("\0") ||
    isAbsolute(file) ||
    win32.isAbsolute(file)
  ) {
    throw new Error("Quick-start snapshot failed");
  }

  const segments = file.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Quick-start snapshot failed");
  }

  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const basename = lowerSegments.at(-1) ?? "";
  const publicEnvironmentExample =
    segments.length === 1 &&
    (file === ".env.example" || file === ".env.docker.example");
  if (basename.startsWith(".env") && !publicEnvironmentExample) {
    throw new Error("Quick-start snapshot failed");
  }

  if (
    lowerSegments.some((segment) =>
      [".git", ".next", ".superpowers", "node_modules", "site"].includes(
        segment,
      ),
    ) ||
    (lowerSegments[0] === "docs" && lowerSegments[1] === "superpowers") ||
    /\.(?:db|sqlite|sqlite3)(?:$|[.-])/i.test(basename)
  ) {
    throw new Error("Quick-start snapshot failed");
  }
}

function parseNullTerminatedOutput(output: Buffer) {
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error("Quick-start snapshot failed");

  return output
    .subarray(0, output.length - 1)
    .toString("utf8")
    .split("\0");
}

function readGitOutput(
  root: string,
  args: string[],
  options: { environment?: NodeJS.ProcessEnv; input?: Buffer } = {},
) {
  const child = spawn("git", args, {
    cwd: root,
    env: options.environment ?? createToolEnvironment(process.env),
    stdio: [options.input ? "pipe" : "ignore", "pipe", "ignore"],
  });
  if (options.input) child.stdin?.end(options.input);
  return readChildGitOutput(child);
}

async function readSnapshotEntries(
  root: string,
  environment: NodeJS.ProcessEnv,
) {
  const records = parseNullTerminatedOutput(
    await readGitOutput(root, ["ls-files", "--stage", "-z"], {
      environment,
    }),
  );
  const entries: SnapshotEntry[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const separator = record.indexOf("\t");
    if (separator === -1) throw new Error("Quick-start snapshot failed");
    const metadata = record.slice(0, separator);
    const file = record.slice(separator + 1);
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)$/.exec(metadata);
    if (
      !match ||
      match[3] !== "0" ||
      (match[1] !== "100644" && match[1] !== "100755") ||
      seen.has(file)
    ) {
      throw new Error("Quick-start snapshot failed");
    }
    validateRepositoryRelativePath(file);
    seen.add(file);
    entries.push({ file, objectId: match[2] });
  }

  if (!seen.has(".env.example")) {
    throw new Error("Quick-start snapshot failed");
  }
  return entries.sort((left, right) => left.file.localeCompare(right.file));
}

function hasComparableIdentity(stats: BigIntStats) {
  return stats.dev !== BigInt(0) || stats.ino !== BigInt(0);
}

function assertRegularFileIdentity(left: BigIntStats, right: BigIntStats) {
  if (!left.isFile() || !right.isFile()) {
    throw new Error("Quick-start snapshot failed");
  }
  if (
    hasComparableIdentity(left) &&
    hasComparableIdentity(right) &&
    (left.dev !== right.dev || left.ino !== right.ino)
  ) {
    throw new Error("Quick-start snapshot failed");
  }
}

function assertFileStatsUnchanged(before: BigIntStats, after: BigIntStats) {
  assertRegularFileIdentity(before, after);
  if (
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("Quick-start snapshot failed");
  }
}

async function assertSafeParentDirectories(root: string, file: string) {
  const segments = file.split("/");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    const stats = await lstat(parent, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Quick-start snapshot failed");
    }
  }
}

async function hashOpenWorkingFile(
  root: string,
  file: string,
  environment: NodeJS.ProcessEnv,
  handle: FileHandle,
) {
  const child = spawn(
    "git",
    ["hash-object", `--path=${file}`, "--stdin"],
    {
      cwd: root,
      env: environment,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const output = readChildGitOutput(child);
  if (!child.stdin) {
    child.kill("SIGKILL");
    await output.catch(() => undefined);
    throw new Error("Quick-start snapshot failed");
  }
  try {
    const [, hashOutput] = await Promise.all([
      pipeline(
        handle.createReadStream({ autoClose: false, start: 0 }),
        child.stdin,
      ),
      output,
    ]);
    const objectId = hashOutput.toString("utf8").replace(/\r?\n$/, "");
    if (!/^[0-9a-f]{40,64}$/.test(objectId)) {
      throw new Error("Quick-start snapshot failed");
    }
    return objectId;
  } catch {
    child.kill("SIGKILL");
    await output.catch(() => undefined);
    throw new Error("Quick-start snapshot failed");
  }
}

function readChildGitOutput(child: ReturnType<typeof spawn>) {
  return new Promise<Buffer>((resolveOutput, reject) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failed = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        failed = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => reject(new Error("Quick-start snapshot failed")));
    child.once("close", (code) => {
      if (failed || code !== 0) {
        reject(new Error("Quick-start snapshot failed"));
        return;
      }
      resolveOutput(Buffer.concat(chunks));
    });
  });
}

async function assertWorkingFileMatchesEntry(
  root: string,
  entry: SnapshotEntry,
  environment: NodeJS.ProcessEnv,
  hooks: SnapshotHooks,
) {
  await assertSafeParentDirectories(root, entry.file);
  const path = resolve(root, ...entry.file.split("/"));
  let handle: FileHandle | undefined;
  try {
    const noFollowFlag =
      hooks.noFollowFlag === null
        ? undefined
        : (hooks.noFollowFlag ?? constants.O_NOFOLLOW);
    const openFlags =
      constants.O_RDONLY |
      (typeof noFollowFlag === "number" ? noFollowFlag : 0);
    handle = await open(path, openFlags);
    await hooks.afterSafeOpen?.(entry.file);
    const beforeHandleStats = await handle.stat({ bigint: true });
    const beforePathStats = await lstat(path, { bigint: true });
    assertRegularFileIdentity(beforeHandleStats, beforePathStats);
    await assertSafeParentDirectories(root, entry.file);

    const objectId = await hashOpenWorkingFile(
      root,
      entry.file,
      environment,
      handle,
    );

    const afterHandleStats = await handle.stat({ bigint: true });
    const afterPathStats = await lstat(path, { bigint: true });
    assertFileStatsUnchanged(beforeHandleStats, afterHandleStats);
    assertRegularFileIdentity(afterHandleStats, afterPathStats);
    await assertSafeParentDirectories(root, entry.file);
    if (objectId !== entry.objectId) {
      throw new Error("Quick-start snapshot failed");
    }
  } catch {
    throw new Error("Quick-start snapshot failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readValidatedSnapshotEntries(
  root: string,
  environment: NodeJS.ProcessEnv,
  hooks: SnapshotHooks,
) {
  const entries = await readSnapshotEntries(root, environment);
  for (const entry of entries) {
    await assertWorkingFileMatchesEntry(root, entry, environment, hooks);
  }
  return entries;
}

async function withWorkingSnapshotIndex<T>(
  root: string,
  operation: (
    canonicalRoot: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<T>,
  hooks: SnapshotHooks = {},
): Promise<T> {
  let temporarySnapshotDirectory: string | undefined;
  try {
    const canonicalRoot = await realpath(root);
    const [canonicalIndex, canonicalObjectDirectory] = await Promise.all([
      resolveGitPath(canonicalRoot, "index"),
      resolveGitPath(canonicalRoot, "objects"),
    ]);
    temporarySnapshotDirectory = await mkdtemp(
      join(tmpdir(), "coredot-quick-start-snapshot-"),
    );
    const alternateIndex = join(temporarySnapshotDirectory, "index");
    const alternateObjectDirectory = join(
      temporarySnapshotDirectory,
      "objects",
    );
    await mkdir(join(alternateObjectDirectory, "info"), { recursive: true });
    await mkdir(join(alternateObjectDirectory, "pack"), { recursive: true });
    await copyFile(canonicalIndex, alternateIndex, constants.COPYFILE_EXCL);

    const environment = {
      ...createToolEnvironment(process.env),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(
        canonicalObjectDirectory,
      ),
      GIT_INDEX_FILE: alternateIndex,
      GIT_OBJECT_DIRECTORY: alternateObjectDirectory,
    };
    await readGitOutput(canonicalRoot, ["add", "-u", "--renormalize", "--"], {
      environment,
    });
    await hooks.afterIndexPopulation?.();
    return await operation(canonicalRoot, environment);
  } catch {
    throw new Error("Quick-start snapshot failed");
  } finally {
    if (temporarySnapshotDirectory) {
      await rm(temporarySnapshotDirectory, { force: true, recursive: true });
    }
  }
}

async function resolveGitPath(root: string, name: "index" | "objects") {
  const output = await readGitOutput(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    name,
  ]);
  const path = output.toString("utf8").replace(/\r?\n$/, "");
  if (
    path === "" ||
    path.includes("\0") ||
    path.includes("\n") ||
    path.includes("\r") ||
    (!isAbsolute(path) && !win32.isAbsolute(path))
  ) {
    throw new Error("Quick-start snapshot failed");
  }
  return realpath(path);
}

export async function listTrackedWorkingFiles(root: string): Promise<string[]> {
  return withWorkingSnapshotIndex(root, async (canonicalRoot, environment) =>
    (await readValidatedSnapshotEntries(canonicalRoot, environment, {})).map(
      (entry) => entry.file,
    ),
  );
}

async function copyTrackedWorkingFilesWithSnapshotHooks(
  root: string,
  destination: string,
  hooks: SnapshotHooks,
) {
  const destinationRoot = resolve(destination);
  await mkdir(destinationRoot, { recursive: true });
  await withWorkingSnapshotIndex(root, async (canonicalRoot, environment) => {
    const files = (
      await readValidatedSnapshotEntries(canonicalRoot, environment, hooks)
    ).map((entry) => entry.file);
    const input = Buffer.from(`${files.join("\0")}\0`, "utf8");
    await readGitOutput(
      canonicalRoot,
      [
        "checkout-index",
        "--stdin",
        "-z",
        `--prefix=${destinationRoot}${sep}`,
      ],
      { environment, input },
    );
  }, hooks);
}

export async function copyTrackedWorkingFiles(
  root: string,
  destination: string,
) {
  await copyTrackedWorkingFilesWithSnapshotHooks(root, destination, {});
}

export async function copyTrackedWorkingFilesWithHooks(
  root: string,
  destination: string,
  hooks: SnapshotHooks,
) {
  await copyTrackedWorkingFilesWithSnapshotHooks(root, destination, hooks);
}

export async function copyDocumentedEnvironmentTemplate(repository: string) {
  try {
    await copyFile(
      join(repository, ".env.example"),
      join(repository, ".env.local"),
      constants.COPYFILE_EXCL,
    );
  } catch {
    throw new Error("Quick-start configure failed");
  }
}
