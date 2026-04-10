#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible mock LLM server for E2E tests.
 *
 * Returns a canned chat completion response so the OpenClaw gateway can
 * complete a full agent turn (llm_input → llm_output → agent_end) without
 * a real model API key.
 *
 * Supports both streaming (SSE) and non-streaming responses because OpenClaw
 * may request either depending on config.
 */

import http from "node:http";

const PORT = parseInt(process.env.MOCK_LLM_PORT ?? "18790", 10);
const MODEL = "gpt-4o-mini";

function nonStreamingResponse(model) {
  return JSON.stringify({
    id: "chatcmpl-e2e-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "pong" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });
}

function streamingChunks(model) {
  const id = "chatcmpl-e2e-mock";
  const created = Math.floor(Date.now() / 1000);

  const chunks = [
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];

  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    console.error(`[mock-llm] ${req.method} ${req.url}`);

    if (req.url === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
      return;
    }

    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }

      const wantsStream = body.stream === true;

      if (wantsStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(streamingChunks(body.model ?? MODEL));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(nonStreamingResponse(body.model ?? MODEL));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[mock-llm] listening on http://127.0.0.1:${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
