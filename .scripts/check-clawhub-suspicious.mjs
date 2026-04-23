#!/usr/bin/env bun

import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pluginRoot = path.resolve(process.argv[2] ?? ".");
const clawhubSourceDir = path.resolve(process.env.CLAWHUB_SOURCE_DIR ?? "clawhub-source");

const requireFromClawHub = createRequire(path.join(clawhubSourceDir, "package.json"));
const ignoreModule = await import(pathToFileURL(requireFromClawHub.resolve("ignore")).href);
const ignore = ignoreModule.default ?? ignoreModule;
const { TEXT_FILE_EXTENSION_SET } = await import(
  pathToFileURL(path.join(clawhubSourceDir, "packages/schema/src/textFiles.ts")).href
);
const { runStaticModerationScan } = await import(
  pathToFileURL(path.join(clawhubSourceDir, "convex/lib/moderationEngine.ts")).href
);

const ig = ignore();
ig.add([".git/", "node_modules/", ".clawhub/", ".clawdhub/"]);
const clawhubSourceRelPath = normalizePath(path.relative(pluginRoot, clawhubSourceDir));
if (clawhubSourceRelPath && !clawhubSourceRelPath.startsWith("../") && clawhubSourceRelPath !== "..") {
  ig.add(`${clawhubSourceRelPath}/`);
}
await addIgnoreFile(".clawhubignore");
await addIgnoreFile(".clawdhubignore");

const files = [];
await walk(pluginRoot);

const fileContents = [];
for (const file of files) {
  const ext = path.extname(file.path).slice(1).toLowerCase();
  if (!ext || !TEXT_FILE_EXTENSION_SET.has(ext)) continue;
  fileContents.push({
    path: file.path,
    content: await readFile(file.absPath, "utf8"),
  });
}

const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
const result = runStaticModerationScan({
  slug: packageJson.name,
  displayName: packageJson.openclaw?.displayName ?? packageJson.name,
  summary: packageJson.description,
  frontmatter: {},
  metadata: packageJson,
  files: files.map((file) => ({ path: file.path, size: file.size })),
  fileContents,
});

if (result.status !== "clean") {
  console.error(`ClawHub suspicious check failed: status=${result.status}`);
  console.error(`Reason codes: ${result.reasonCodes.join(", ") || "(none)"}`);
  for (const finding of result.findings) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`- ${finding.code} at ${location}: ${finding.message}`);
  }
  process.exit(1);
}

console.log(
  `ClawHub suspicious check passed: status=clean, files=${files.length}, textFiles=${fileContents.length}`,
);

async function addIgnoreFile(fileName) {
  try {
    const raw = await readFile(path.join(pluginRoot, fileName), "utf8");
    ig.add(raw.split(/\r?\n/));
  } catch {
    // Optional.
  }
}

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;

    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(absPath);
      continue;
    }
    if (!entry.isFile()) continue;

    const relPath = normalizePath(path.relative(pluginRoot, absPath));
    if (!relPath || ig.ignores(relPath)) continue;

    const stats = await stat(absPath);
    files.push({
      path: relPath,
      absPath,
      size: stats.size,
    });
  }
}

function normalizePath(value) {
  return value.split(path.sep).join("/").replace(/^\.\/+/, "");
}
