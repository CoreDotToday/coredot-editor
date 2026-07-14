import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const [mode, rawPort, markerPath] = process.argv.slice(2);
const port = Number(rawPort);

if (!Number.isInteger(port) || port < 1 || port > 65_535 || !markerPath) {
  process.exitCode = 2;
} else if (mode === "parent" || mode === "failing-parent") {
  process.on("SIGTERM", () => undefined);
  const leaf = spawn(process.execPath, [scriptPath, "leaf", String(port), markerPath], {
    stdio: "ignore",
  });
  leaf.unref();
  if (mode === "parent") {
    setInterval(() => undefined, 1_000);
  } else {
    const readyPoll = setInterval(async () => {
      try {
        await access(markerPath);
        clearInterval(readyPoll);
        process.exitCode = 7;
      } catch {
        // Wait until the leaf has bound the port and published its identity.
      }
    }, 10);
  }
} else if (mode === "leaf") {
  process.on("SIGTERM", () => undefined);
  const server = createServer();
  server.listen(port, "127.0.0.1", async () => {
    await writeFile(
      markerPath,
      JSON.stringify({ leafPid: process.pid, parentPid: process.ppid, port }),
      "utf8",
    );
  });
} else {
  process.exitCode = 2;
}
