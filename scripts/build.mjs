#!/usr/bin/env node

import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

rmSync("dist", { force: true, recursive: true });

const tscCommand = process.platform === "win32" ? "tsc.cmd" : "tsc";
const build = spawnSync(tscCommand, ["-p", "tsconfig.build.json"], {
  cwd: process.cwd(),
  stdio: "inherit",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
