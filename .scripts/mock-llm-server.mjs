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
import fs from "node:fs";

const PORT = parseInt(process.env.MOCK_LLM_PORT ?? "18790", 10);
const MODEL = "gpt-4o-mini";
const RESULT_FILE = process.env.E2E_LLM_RESULT_FILE ?? "e2e-llm-result.json";
const JOURNAL_FILE = process.env.E2E_LLM_JOURNAL_FILE ?? "e2e-llm-journal.json";
const RESPONSE_TEXT = "pong";

const received = {
  models: 0,
  responses: 0,
  streamingResponses: 0,
  chatCompletions: 0,
  streamingChatCompletions: 0,
  requests: [],
};

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

function recordRequest(req, body, summary) {
  received.requests.push({
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: redactHeaders(req.headers),
    body,
    ...summary,
  });
}

function nonStreamingResponse(model) {
  return JSON.stringify({
    id: "chatcmpl-e2e-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: RESPONSE_TEXT },
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
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: RESPONSE_TEXT }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];

  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function responseObject(model) {
  return {
    id: "resp-e2e-mock",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [
      {
        id: "msg-e2e-mock",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: RESPONSE_TEXT,
            annotations: [],
          },
        ],
      },
    ],
    output_text: RESPONSE_TEXT,
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  };
}

function streamingResponseEvents(model) {
  const response = responseObject(model);
  const message = response.output[0];
  const part = message.content[0];

  const events = [
    ["response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }],
    ["response.in_progress", { type: "response.in_progress", response: { ...response, status: "in_progress", output: [] } }],
    ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } }],
    ["response.content_part.added", { type: "response.content_part.added", output_index: 0, item_id: message.id, content_index: 0, part: { type: "output_text", text: "" } }],
    ["response.output_text.delta", { type: "response.output_text.delta", output_index: 0, item_id: message.id, content_index: 0, delta: RESPONSE_TEXT }],
    ["response.output_text.done", { type: "response.output_text.done", output_index: 0, item_id: message.id, content_index: 0, text: RESPONSE_TEXT }],
    ["response.content_part.done", { type: "response.content_part.done", output_index: 0, item_id: message.id, content_index: 0, part }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: message }],
    ["response.completed", { type: "response.completed", response }],
  ];

  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("") + "data: [DONE]\n\n";
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    console.error(`[mock-llm] ${req.method} ${req.url}`);

    if (req.url === "/v1/models" && req.method === "GET") {
      received.models += 1;
      recordRequest(req, undefined, { route: "models-list" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
      return;
    }

    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }

      const wantsStream = body.stream === true;
      received.chatCompletions += 1;
      if (wantsStream) {
        received.streamingChatCompletions += 1;
      }
      recordRequest(req, body, {
        route: "chat-completions",
        stream: wantsStream,
        model: body.model ?? MODEL,
        inputShape: Array.isArray(body.messages) ? "messages" : typeof body.input,
      });

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

    if (req.url === "/v1/responses" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }

      const wantsStream = body.stream === true;
      received.responses += 1;
      if (wantsStream) {
        received.streamingResponses += 1;
      }
      recordRequest(req, body, {
        route: "responses",
        stream: wantsStream,
        model: body.model ?? MODEL,
        inputShape: Array.isArray(body.input) ? "input[]" : typeof body.input,
      });

      if (wantsStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(streamingResponseEvents(body.model ?? MODEL));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseObject(body.model ?? MODEL)));
      }
      return;
    }

    recordRequest(req, body, { route: "not-found" });
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[mock-llm] listening on http://127.0.0.1:${PORT}`);
});

function writeResult() {
  const summary = {
    models: received.models,
    responses: received.responses,
    streamingResponses: received.streamingResponses,
    chatCompletions: received.chatCompletions,
    streamingChatCompletions: received.streamingChatCompletions,
    totalRequests: received.requests.length,
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(summary, null, 2));
  console.error(`[mock-llm] result written to ${RESULT_FILE}:`, summary);
  const journal = {
    summary,
    requests: received.requests,
  };
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));
  console.error(`[mock-llm] journal written to ${JOURNAL_FILE}`);
}

process.on("SIGTERM", () => {
  writeResult();
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  writeResult();
  server.close(() => process.exit(0));
});
