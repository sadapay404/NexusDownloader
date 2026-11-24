import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));

function manifest(name) {
  const hashes = new Map();
  for (const line of read(name).toString("utf8").trimEnd().split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})  ([\w.@/-]+)$/);
    const path = match?.[2];
    if (!path || path.split("/").some((part) => !part || part === "." || part === "..") || hashes.has(path)) {
      throw new Error(`Invalid or duplicate path in ${name}: ${line}`);
    }
    hashes.set(path, match[1]);
  }
  return hashes;
}

const baseline = manifest("UPSTREAM-SHA256SUMS");
const fork = manifest("FORK-SHA256SUMS");
for (const [path, digest] of fork) {
  if (baseline.get(path) === digest) throw new Error(`Redundant fork hash for ${path}`);
}
const expected = new Map([...baseline, ...fork]);
for (const [path, digest] of expected) {
  if (createHash("sha256").update(read(path)).digest("hex") !== digest) {
    console.error(`Source hash mismatch: ${path}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) {
  console.log(`Verified ${expected.size} source files (${baseline.size} upstream baseline entries, ${fork.size} fork entries).`);
}
