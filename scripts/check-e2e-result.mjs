#!/usr/bin/env node
/**
 * Reads the E2E result file written by mock-opik-server.mjs and exits non-zero
 * if the minimum expected trace/span counts were not met.
 */

import fs from "node:fs";

const RESULT_FILE = process.env.E2E_RESULT_FILE ?? "e2e-result.json";

if (!fs.existsSync(RESULT_FILE)) {
  console.error(`[check-e2e] FAIL: result file not found: ${RESULT_FILE}`);
  console.error("  The mock Opik server may not have written its result (SIGTERM not received?).");
  process.exit(1);
}

const result = JSON.parse(fs.readFileSync(RESULT_FILE, "utf8"));
console.log("[check-e2e] result:", result);

const failures = [];

if (result.traces < 1) {
  failures.push(`Expected ≥1 trace batch, got ${result.traces}`);
}

if (result.spans < 1) {
  failures.push(`Expected ≥1 span batch, got ${result.spans}`);
}

if (result.totalRequests < 1) {
  failures.push("No requests at all reached the mock Opik server — plugin hooks may not have fired");
}

if (failures.length > 0) {
  console.error("[check-e2e] FAIL:");
  for (const f of failures) console.error("  •", f);
  process.exit(1);
}

console.log("[check-e2e] PASS — traces and spans received by mock Opik server");
