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
const JOURNAL_FILE = process.env.E2E_OPIK_JOURNAL_FILE ?? "e2e-opik-journal.json";

const received = {
  traces: 0,
  spans: 0,
  endedTraces: 0,
  endedSpans: 0,
  tracePatches: 0,
  spanPatches: 0,
  traceProjects: new Set(),
  requests: [],
};

function resolveEntityProject(entity) {
  return entity?.projectName ?? entity?.project_name ?? null;
}

function redactHeaders(headers) {
  const entries = Object.entries(headers ?? {});
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (key.toLowerCase() === "authorization") {
        return [key, "<redacted>"];
      }
      return [key, value];
    }),
  );
}

function buildRequestSummary(method, url, body) {
  if (method === "POST" && url.includes("/traces/batch")) {
    const traces = body?.traces ?? [];
    const traceProjects = [...new Set(traces.map(resolveEntityProject).filter(Boolean))];
    return {
      route: "traces-batch",
      traceCount: traces.length,
      finalizedTraceCount: traces.filter(
        (trace) => trace?.endTime !== undefined || trace?.end_time !== undefined,
      ).length,
      traceIds: traces.map((trace) => trace?.id).filter(Boolean).slice(0, 5),
      traceProjects,
    };
  }
  if (method === "POST" && url.includes("/spans/batch")) {
    const spans = body?.spans ?? [];
    return {
      route: "spans-batch",
      spanCount: spans.length,
      finalizedSpanCount: spans.filter(
        (span) => span?.endTime !== undefined || span?.end_time !== undefined,
      ).length,
      spanIds: spans.map((span) => span?.id).filter(Boolean).slice(0, 5),
    };
  }
  if (method === "PATCH" && url.match(/\/traces\/[^/]+$/)) {
    return { route: "trace-patch" };
  }
  if (method === "PATCH" && url.match(/\/spans\/[^/]+$/)) {
    return { route: "span-patch" };
  }
  if (method === "GET" && url.includes("/projects")) {
    return { route: "projects-list" };
  }
  return { route: "other" };
}

function record(method, url, body, headers) {
  console.error(`[mock-opik] ${method} ${url}`);
  const encodedBody = JSON.stringify(body);
  const summary = buildRequestSummary(method, url, body);
  received.requests.push({
    at: new Date().toISOString(),
    method,
    url,
    headers: redactHeaders(headers),
    bodyLength: encodedBody.length,
    body,
    ...summary,
  });

  if (method === "POST" && url.includes("/traces/batch")) {
    const traces = body?.traces ?? [];
    received.traces += traces.length;
    received.endedTraces += traces.filter((trace) => trace?.endTime !== undefined || trace?.end_time !== undefined).length;
    for (const trace of traces) {
      const projectName = resolveEntityProject(trace);
      if (projectName) {
        received.traceProjects.add(projectName);
      }
    }
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

    record(req.method, req.url, body, req.headers);

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
    traceProjects: [...received.traceProjects].sort(),
    totalRequests: received.requests.length,
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(summary, null, 2));
  console.error(`[mock-opik] result written to ${RESULT_FILE}:`, summary);
  const journal = {
    summary,
    requests: received.requests,
  };
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));
  console.error(`[mock-opik] journal written to ${JOURNAL_FILE}`);
}

process.on("SIGTERM", () => {
  writeResult();
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  writeResult();
  server.close(() => process.exit(0));
});
