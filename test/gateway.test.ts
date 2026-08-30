import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResponsesGateway, formatInput, toCodexInput } from "../src/gateway.ts";

class FakeCodex {
  notifications: Array<(message: any) => void> = [];
  requests: Array<(request: any) => void> = [];
  toolMode = false;
  dynamicToolName = "";
  turnInput: any[] = [];

  onNotification(listener: (message: any) => void): () => void {
    this.notifications.push(listener);
    return () => undefined;
  }

  onServerRequest(listener: (request: any) => void): () => void {
    this.requests.push(listener);
    return () => undefined;
  }

  async request(method: string, params?: any): Promise<any> {
    if (method === "thread/start") {
      this.dynamicToolName = params?.dynamicTools?.[0]?.name || "";
      if (this.dynamicToolName.startsWith("mcp__")) throw new Error("dynamic tool name is reserved");
      return { thread: { id: "thread-test" } };
    }
    if (method === "thread/resume") return { thread: { id: "thread-test" } };
    if (method === "turn/start") {
      this.turnInput = params?.input || [];
      setImmediate(() => {
        if (this.toolMode) {
          this.emitRequest({
            id: 7,
            method: "item/tool/call",
            params: { threadId: "thread-test", turnId: "turn-test", callId: "call-test", tool: this.dynamicToolName, arguments: { path: "a.txt" } },
            respond: () => {
              setImmediate(() => {
                this.emit({ method: "item/agentMessage/delta", params: { threadId: "thread-test", delta: "tool result accepted" } });
                this.emit({ method: "turn/completed", params: { threadId: "thread-test", turn: { status: "completed" } } });
              });
            },
            reject: () => undefined,
          });
        } else {
          this.emit({ method: "item/agentMessage/delta", params: { threadId: "thread-test", delta: "hello" } });
          this.emit({ method: "turn/completed", params: { threadId: "thread-test", turn: { status: "completed" } } });
        }
      });
      return { turn: { id: "turn-test" } };
    }
    if (method === "thread/compact/start") {
      setImmediate(() => this.emit({ method: "item/completed", params: { threadId: "thread-test", item: { type: "contextCompaction" } } }));
      return {};
    }
    if (method === "model/list") return { data: [{ id: "gpt-test" }] };
    if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
    return {};
  }

  async close(): Promise<void> {}
  emit(message: any): void { for (const listener of this.notifications) listener(message); }
  emitRequest(message: any): void { for (const listener of this.requests) listener(message); }
}

async function gateway(fake = new FakeCodex()): Promise<{ gateway: ResponsesGateway; fake: FakeCodex }> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-bridge-test-"));
  return { gateway: new ResponsesGateway(fake as any, join(directory, "responses.json")), fake };
}

test("formats Responses message input without protocol scaffolding", () => {
  assert.equal(formatInput([{ role: "user", content: [{ type: "input_text", text: "hello" }] }], "be concise"), "Developer instructions:\nbe concise\n\nuser: hello");
});

test("passes Responses image input to native Codex image input", () => {
  const input = toCodexInput([{
    role: "user",
    content: [
      { type: "input_text", text: "describe this" },
      { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "high" },
    ],
  }]);
  assert.deepEqual(input, [
    { type: "text", text: "user: describe this" },
    { type: "image", url: "data:image/png;base64,AA==", detail: "high" },
  ]);
});

test("returns a completed Responses text object", async () => {
  const setup = await gateway();
  const result = await setup.gateway.create({ model: "gpt-test", input: "say hello" });
  assert.equal(result.object, "response");
  assert.equal(result.output_text, "hello");
  assert.equal(result.output[0].type, "message");
});

test("round-trips Responses function calls through Codex dynamic tools", async () => {
  const setup = await gateway();
  setup.fake.toolMode = true;
  const first = await setup.gateway.create({
    model: "gpt-test",
    input: "read a file",
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
  });
  assert.equal(first.output[0].type, "function_call");
  assert.equal(first.output[0].name, "read_file");
  const second = await setup.gateway.create({
    model: "gpt-test",
    previous_response_id: first.id,
    input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "contents" }],
  });
  assert.equal(second.output_text, "tool result accepted");
});

test("maps ZCode MCP tool names around Codex reserved namespaces", async () => {
  const setup = await gateway();
  setup.fake.toolMode = true;
  const result = await setup.gateway.create({
    model: "gpt-test",
    input: "use node",
    tools: [{ type: "function", name: "mcp__node_repl__js", parameters: { type: "object" } }],
  });
  assert.match(setup.fake.dynamicToolName, /^zcode_/);
  assert.equal(result.output[0].name, "mcp__node_repl__js");
});

test("returns a standard-shaped compaction backed by native Codex compaction", async () => {
  const setup = await gateway();
  const response = await setup.gateway.create({ model: "gpt-test", input: "hello" });
  const compacted = await setup.gateway.compact({ model: "gpt-test", previous_response_id: response.id });
  assert.equal(compacted.object, "response.compaction");
  assert.equal(compacted.output.at(-1).type, "compaction");
});
