#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (pack.status !== 0) {
  process.stderr.write(pack.stdout);
  process.stderr.write(pack.stderr);
  process.exit(pack.status ?? 1);
}

let payload;
try {
  payload = JSON.parse(pack.stdout);
} catch (error) {
  console.error(`npm pack did not return JSON: ${String(error)}`);
  process.stderr.write(pack.stdout);
  process.exit(1);
}

const files = new Set(payload[0]?.files?.map((file) => file.path) ?? []);
const requiredFiles = [
  "package.json",
  "openclaw.plugin.json",
  "index.ts",
  "src/cli.ts",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/src/cli.js",
];
const missingFiles = requiredFiles.filter((file) => !files.has(file));

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const expectedExtensions = ["./index.ts"];
const expectedRuntimeExtensions = ["./dist/index.js"];
const issues = [];

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function requireStringArray(name, actual, expected) {
  if (!sameStringArray(actual, expected)) {
    issues.push(`${name} must be ${JSON.stringify(expected)}`);
  }
}

if (missingFiles.length > 0) {
  issues.push(`missing packed files: ${missingFiles.join(", ")}`);
}
requireStringArray("openclaw.extensions", packageJson.openclaw?.extensions, expectedExtensions);
requireStringArray(
  "openclaw.runtimeExtensions",
  packageJson.openclaw?.runtimeExtensions,
  expectedRuntimeExtensions,
);
if (!packageJson.files?.includes("dist/**")) {
  issues.push("package files must include dist/**");
}

if (issues.length > 0) {
  console.error(`Package payload check failed:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `Package payload OK: ${payload[0]?.entryCount ?? files.size} files, runtime ./dist/index.js`,
);
