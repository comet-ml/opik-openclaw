#!/usr/bin/env node
/**
 * Mock Opik API server for E2E tests.
 *
 * Accepts the Opik trace/span batch and patch endpoints and records every
 * payload it receives. On SIGTERM (or when the gateway flushes and stops),
 * it writes a summary to E2E_RESULT_FILE (default: e2e-result.json) and exits.
 *
 * The check-e2e-result.mjs script reads that file and fails the test if
 * no traces or spans were received.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = parseInt(process.env.MOCK_OPIK_PORT ?? "18791", 10);
const RESULT_FILE = process.env.E2E_RESULT_FILE ?? "e2e-result.json";

const received = {
  traces: 0,
  spans: 0,
  endedTraces: 0,
  endedSpans: 0,
  tracePatches: 0,
  spanPatches: 0,
  requests: [],
};

function record(method, url, body) {
  console.error(`[mock-opik] ${method} ${url}`);
  received.requests.push({ method, url, bodyLength: JSON.stringify(body).length });

  if (method === "POST" && url.includes("/traces/batch")) {
    const traces = body?.traces ?? [];
    received.traces += traces.length;
    received.endedTraces += traces.filter((trace) => trace?.endTime !== undefined || trace?.end_time !== undefined).length;
  } else if (method === "POST" && url.includes("/spans/batch")) {
    const spans = body?.spans ?? [];
    received.spans += spans.length;
    received.endedSpans += spans.filter((span) => span?.endTime !== undefined || span?.end_time !== undefined).length;
  } else if (method === "PATCH" && url.match(/\/traces\/[^/]+$/)) {
    received.tracePatches += 1;
  } else if (method === "PATCH" && url.match(/\/spans\/[^/]+$/)) {
    received.spanPatches += 1;
  }
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      // ignore parse errors for non-JSON bodies
    }

    record(req.method, req.url, body);

    // Respond 200/204 to everything so the plugin doesn't retry.
    const status =
      req.method === "GET" ? 200 : req.method === "DELETE" ? 204 : 200;

    res.writeHead(status, { "Content-Type": "application/json" });

    // Return minimal responses for the endpoints Opik SDK reads back.
    if (req.url?.includes("/projects") && req.method === "GET") {
      res.end(JSON.stringify({ content: [{ id: "mock-project-id", name: "e2e-test" }] }));
    } else if (req.url?.includes("/traces/batch") && req.method === "POST") {
      res.end(JSON.stringify({}));
    } else if (req.url?.includes("/spans/batch") && req.method === "POST") {
      res.end(JSON.stringify({}));
    } else {
      res.end(JSON.stringify({}));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[mock-opik] listening on http://127.0.0.1:${PORT}`);
});

function writeResult() {
  const summary = {
    traces: received.traces,
    spans: received.spans,
    endedTraces: received.endedTraces,
    endedSpans: received.endedSpans,
    tracePatches: received.tracePatches,
    spanPatches: received.spanPatches,
    totalRequests: received.requests.length,
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(summary, null, 2));
  console.error(`[mock-opik] result written to ${RESULT_FILE}:`, summary);
}

process.on("SIGTERM", () => {
  writeResult();
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  writeResult();
  server.close(() => process.exit(0));
});
