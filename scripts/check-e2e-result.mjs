#!/usr/bin/env node
/**
 * Reads the E2E result file written by mock-opik-server.mjs and exits non-zero
 * if the minimum expected trace/span counts were not met.
 */

import fs from "node:fs";

const RESULT_FILE = process.env.E2E_RESULT_FILE ?? "e2e-result.json";
const LLM_RESULT_FILE = process.env.E2E_LLM_RESULT_FILE ?? "e2e-llm-result.json";
const OPIK_JOURNAL_FILE = process.env.E2E_OPIK_JOURNAL_FILE ?? "e2e-opik-journal.json";
const LLM_JOURNAL_FILE = process.env.E2E_LLM_JOURNAL_FILE ?? "e2e-llm-journal.json";

function readJsonIfExists(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function formatRecentRequests(label, journal) {
  if (!journal?.requests?.length) {
    return `  ${label}: no journal entries (${label === "Opik" ? OPIK_JOURNAL_FILE : LLM_JOURNAL_FILE})`;
  }
  const recent = journal.requests.slice(-3);
  const lines = recent.map((entry) => {
    const summary =
      entry.route === "traces-batch"
        ? `traceCount=${entry.traceCount ?? 0} finalized=${entry.finalizedTraceCount ?? 0}`
        : entry.route === "spans-batch"
          ? `spanCount=${entry.spanCount ?? 0} finalized=${entry.finalizedSpanCount ?? 0}`
          : entry.route === "responses" || entry.route === "chat-completions"
            ? `model=${entry.model ?? "unknown"} stream=${entry.stream === true}`
            : "";
    return `    - ${entry.method} ${entry.url} route=${entry.route}${summary ? ` ${summary}` : ""}`;
  });
  return [`  ${label} journal: ${label === "Opik" ? OPIK_JOURNAL_FILE : LLM_JOURNAL_FILE}`, ...lines].join("\n");
}

if (!fs.existsSync(RESULT_FILE)) {
  console.error(`[check-e2e] FAIL: result file not found: ${RESULT_FILE}`);
  console.error("  The mock Opik server may not have written its result (SIGTERM not received?).");
  process.exit(1);
}

const result = JSON.parse(fs.readFileSync(RESULT_FILE, "utf8"));
console.log("[check-e2e] result:", result);

if (!fs.existsSync(LLM_RESULT_FILE)) {
  console.error(`[check-e2e] FAIL: LLM result file not found: ${LLM_RESULT_FILE}`);
  console.error("  The mock LLM server may not have written its result (SIGTERM not received?).");
  process.exit(1);
}

const llmResult = JSON.parse(fs.readFileSync(LLM_RESULT_FILE, "utf8"));
console.log("[check-e2e] llm result:", llmResult);
const opikJournal = readJsonIfExists(OPIK_JOURNAL_FILE);
const llmJournal = readJsonIfExists(LLM_JOURNAL_FILE);

const failures = [];
const llmGenerationRequests = (llmResult.responses ?? 0) + (llmResult.chatCompletions ?? 0);
const traceFinalizations = (result.tracePatches ?? 0) + (result.endedTraces ?? 0);
const spanFinalizations = (result.spanPatches ?? 0) + (result.endedSpans ?? 0);

if (result.traces < 1) {
  failures.push(`Expected ≥1 trace batch, got ${result.traces}`);
}

if (result.spans < 1) {
  failures.push(`Expected ≥1 span batch, got ${result.spans}`);
}

if (traceFinalizations < 1) {
  failures.push(
    `Expected ≥1 finalized trace (patch or batch endTime), got patches=${result.tracePatches ?? 0} ended=${result.endedTraces ?? 0}`,
  );
}

if (spanFinalizations < 1) {
  failures.push(
    `Expected ≥1 finalized span (patch or batch endTime), got patches=${result.spanPatches ?? 0} ended=${result.endedSpans ?? 0}`,
  );
}

if (result.totalRequests < 1) {
  failures.push("No requests at all reached the mock Opik server — plugin hooks may not have fired");
}

if (llmGenerationRequests < 1) {
  failures.push(
    `Expected ≥1 mock LLM generation request, got ${llmGenerationRequests}`,
  );
}

if (failures.length > 0) {
  console.error("[check-e2e] FAIL:");
  for (const f of failures) console.error("  •", f);
  console.error(formatRecentRequests("Opik", opikJournal));
  console.error(formatRecentRequests("LLM", llmJournal));
  process.exit(1);
}

console.log("[check-e2e] PASS — traces, spans, patches, and mock LLM traffic were observed");
