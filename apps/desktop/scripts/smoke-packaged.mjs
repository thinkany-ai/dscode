import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseDir = path.join(projectRoot, "release");
const executable = findPackagedExecutable();
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "dscode-packaged-smoke-"));

let output = "";
const child = spawn(executable, [], {
  env: {
    ...process.env,
    DSCODE_HOME: path.join(temporaryRoot, "dscode-home"),
    DSCODE_DESKTOP_USER_DATA: path.join(temporaryRoot, "desktop-data"),
    ELECTRON_ENABLE_LOGGING: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

const earlyExit = await Promise.race([
  new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
  new Promise((resolve) => setTimeout(() => resolve(undefined), 6_000)),
]);

if (earlyExit) {
  await removeTemporaryRoot();
  throw new Error(
    `Packaged DSCode exited before the smoke window elapsed (${JSON.stringify(earlyExit)}).\n${output}`,
  );
}

child.kill();
await Promise.race([
  new Promise((resolve) => child.once("exit", resolve)),
  new Promise((resolve) => setTimeout(resolve, 2_000)),
]);
await removeTemporaryRoot();
console.log(`Packaged DSCode stayed running for 6 seconds: ${executable}`);

async function removeTemporaryRoot() {
  try {
    await fsp.rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  } catch (error) {
    // Chromium can briefly retain its Trust Tokens file after process exit on
    // Windows. Cleanup is best-effort and must not turn a successful launch
    // smoke test into a product failure.
    console.warn(`Could not remove packaged smoke data: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findPackagedExecutable() {
  const candidates = process.platform === "darwin"
    ? [
        path.join(releaseDir, process.arch === "arm64" ? "mac-arm64" : "mac", "DSCode.app", "Contents", "MacOS", "DSCode"),
        path.join(releaseDir, "mac", "DSCode.app", "Contents", "MacOS", "DSCode"),
        path.join(releaseDir, "mac-arm64", "DSCode.app", "Contents", "MacOS", "DSCode"),
      ]
    : process.platform === "win32"
      ? [path.join(releaseDir, "win-unpacked", "DSCode.exe")]
      : [
          path.join(releaseDir, "linux-unpacked", "dscode-desktop"),
          path.join(releaseDir, "linux-unpacked", "dscode"),
          path.join(releaseDir, "linux-unpacked", "DSCode"),
        ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Could not find a packaged DSCode executable. Checked:\n${candidates.join("\n")}`);
  }
  return found;
}
