import path from "node:path";
import { fileURLToPath } from "node:url";

export function formatInstallSuccess(version) {
  return `
DSCode v${version} installed successfully.

Get started:
  cd your-project
  dscode

The first launch will guide you through model provider setup.
Run dscode --help to see all commands.

`;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const version = process.argv[2];
  if (!version) throw new Error("DSCode version is required");
  process.stdout.write(formatInstallSuccess(version));
}
