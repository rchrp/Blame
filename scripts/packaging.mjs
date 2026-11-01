import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const templates = fileURLToPath(new URL("../packaging/", import.meta.url));

// Template placeholder → release file whose SHA-256 it receives.
export const releaseFiles = {
  SHA256_MAC_ARM64: "blame-mac-arm64.dmg",
  SHA256_MAC_X64: "blame-mac-x64.dmg",
  SHA256_WIN_X64: "blame-win-x64.exe",
  SHA256_LINUX_DEB: "blame-linux-amd64.deb",
};

// Template → path in the output directory.
const outputs = {
  "homebrew/blame.rb": "homebrew/Casks/blame.rb",
  "aur/PKGBUILD": "aur/PKGBUILD",
};

export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64}) [ *](.+)$/i.exec(line.trim());
    if (!match) throw new Error(`Unreadable SHA256SUMS line: ${line}`);
    sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

// Package managers only ever get stable releases: betas stay on GitHub.
export function packageValues(version, sums) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${version} is not a stable version (x.y.z)`);
  const values = { VERSION: version };
  for (const [key, file] of Object.entries(releaseFiles)) {
    const sum = sums.get(file);
    if (!sum) throw new Error(`SHA256SUMS has no entry for ${file}`);
    values[key] = sum;
  }
  return values;
}

export function render(template, values) {
  const text = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (placeholder, key) => {
    if (!(key in values)) throw new Error(`No value for ${placeholder}`);
    return values[key];
  });
  return text;
}

export async function renderPackages(version, sums, output) {
  const values = packageValues(version, sums);
  const files = { ...outputs };
  for (const name of await readdir(join(templates, "winget"))) {
    if (name.endsWith(".yaml")) files[`winget/${name}`] = `winget/${name}`;
  }
  const written = [];
  for (const [template, target] of Object.entries(files)) {
    const destination = join(output, target);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, render(await readFile(join(templates, template), "utf8"), values), "utf8");
    written.push(destination);
  }
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, version, sumsFile, output] = process.argv.slice(2);
  if (command !== "render" || !version || !sumsFile || !output) {
    console.error("Usage: node scripts/packaging.mjs render <version> <SHA256SUMS> <output>");
    process.exit(1);
  }
  const files = await renderPackages(version, parseSha256Sums(await readFile(sumsFile, "utf8")), output);
  for (const file of files) console.log(file);
}
