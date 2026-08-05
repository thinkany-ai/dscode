import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "native", "windows-sandbox");
const outputRoot = path.join(projectRoot, "packages", "core", "dist", "native", "windows-sandbox");
const go = process.env.GO?.trim() || "go";
const files = {};

for (const architecture of ["amd64", "arm64"]) {
  const target = architecture === "amd64" ? "win32-x64" : "win32-arm64";
  const relative = `${target}/dscode-windows-sandbox.exe`;
  const output = path.join(outputRoot, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync(
    go,
    ["build", "-trimpath", "-ldflags=-s -w", "-o", output, "./cmd/dscode-windows-sandbox"],
    {
      cwd: source,
      env: { ...process.env, GOOS: "windows", GOARCH: architecture, CGO_ENABLED: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Go build failed for ${architecture}.`);
  }
  files[relative] = createHash("sha256").update(fs.readFileSync(output)).digest("hex");
}

fs.writeFileSync(
  path.join(outputRoot, "manifest.json"),
  `${JSON.stringify({ version: 1, protocol: 1, files }, null, 2)}\n`,
  "utf8",
);
process.stdout.write("Built checksum-verified Windows sandbox helpers for x64 and ARM64.\n");
