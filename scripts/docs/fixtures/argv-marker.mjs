import { writeFile } from "node:fs/promises";

const [markerPath, ...arguments_] = process.argv.slice(2);
if (!markerPath) {
  process.exitCode = 2;
} else {
  await writeFile(markerPath, JSON.stringify(arguments_), "utf8");
}
