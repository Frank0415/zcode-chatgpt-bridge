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
  childToolMode = false;
  parallelToolMode = false;
  failTurnStartOnce = false;
  uniqueThreads = false;
  dynamicToolName = "";
  turnInput: any[] = [];
  threadStarts = 0;
  turnInputs: any[][] = [];
  toolResponses = new Map<string, number>();
  expectedToolResponses = new Map<string, number>();

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
      this.threadStarts += 1;
      this.dynamicToolName = params?.dynamicTools?.[0]?.name || "";
      if (this.dynamicToolName.startsWith("mcp__")) throw new Error("dynamic tool name is reserved");
      return { thread: { id: this.uniqueThreads ? `thread-${this.threadStarts}` : "thread-test" } };
    }
    if (method === "thread/resume") return { thread: { id: "thread-test" } };
    if (method === "thread/read") {
      const threadId = String(params?.threadId || "");
      return { thread: { id: threadId, parentThreadId: threadId.endsWith("-child") ? threadId.slice(0, -"-child".length) : null } };
    }
    if (method === "turn/start") {
      if (this.failTurnStartOnce) {
        this.failTurnStartOnce = false;
        throw new Error("turn start failed");
      }
      this.turnInput = params?.input || [];
      this.turnInputs.push(this.turnInput);
      setImmediate(() => {
        const rootThreadId = params?.threadId || "thread-test";
        if (this.childToolMode) {
          const childThreadId = `${rootThreadId}-child`;
          this.expectedToolResponses.set(rootThreadId, 1);
          this.emitRequest(this.toolRequest(rootThreadId, childThreadId, `call-${childThreadId}`, 7));
        } else if (this.parallelToolMode) {
          this.expectedToolResponses.set(rootThreadId, 2);
          this.emitRequest(this.toolRequest(rootThreadId, rootThreadId, "call-one", 7));
          this.emitRequest(this.toolRequest(rootThreadId, rootThreadId, "call-two", 8));
        } else if (this.toolMode) {
          this.expectedToolResponses.set(rootThreadId, 1);
          this.emitRequest(this.toolRequest(rootThreadId, rootThreadId, "call-test", 7));
        } else {
          this.emit({ method: "item/agentMessage/delta", params: { threadId: rootThreadId, delta: "hello" } });
          this.emit({ method: "turn/completed", params: { threadId: rootThreadId, turn: { status: "completed" } } });
        }
      });
      return { turn: { id: "turn-test" } };
    }
    if (method === "thread/compact/start") {
      setImmediate(() => this.emit({ method: "item/completed", params: { threadId: "thread-test", item: { type: "contextCompaction" } } }));
      return {};
    }
    if (method === "model/list") return { data: [{ id: "gpt-test" }, { id: "gpt-5.6-sol" }, { id: "gpt-5.6-luna" }] };
    if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
    return {};
  }

  async close(): Promise<void> {}
  emit(message: any): void { for (const listener of this.notifications) listener(message); }
  emitRequest(message: any): void { for (const listener of this.requests) listener(message); }

  toolRequest(rootThreadId: string, threadId: string, callId: string, id: number): any {
    return {
      id,
      method: "item/tool/call",
      params: { threadId, turnId: "turn-test", callId, tool: this.dynamicToolName, arguments: { path: "a.txt" } },
      respond: () => {
        const responses = (this.toolResponses.get(rootThreadId) || 0) + 1;
        this.toolResponses.set(rootThreadId, responses);
        if (responses !== this.expectedToolResponses.get(rootThreadId)) return;
        setImmediate(() => {
          this.emit({ method: "item/agentMessage/delta", params: { threadId: rootThreadId, delta: "tool result accepted" } });
          this.emit({ method: "turn/completed", params: { threadId: rootThreadId, turn: { status: "completed" } } });
        });
      },
      reject: () => undefined,
    };
  }
}

async function gateway(fake = new FakeCodex()): Promise<{ gateway: ResponsesGateway; fake: FakeCodex }> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-bridge-test-"));
  return { gateway: new ResponsesGateway(fake as any, join(directory, "responses.json")), fake };
}

test("formats Responses message input without protocol scaffolding", () => {
  assert.equal(formatInput([{ role: "user", content: [{ type: "input_text", text: "hello" }] }], "be concise"), "Developer instructions:\nbe concise\n\nuser: hello");
});

test("advertises GPT-5.6 long-context metadata", async () => {
  const setup = await gateway();
  const result = await setup.gateway.models();
  for (const id of ["gpt-5.6-sol", "gpt-5.6-luna"]) {
    const model = result.data.find((entry: any) => entry.id === id);
    assert.equal(model.context_window, 1_050_000);
    assert.equal(model.max_output_tokens, 128_000);
  }
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

test("continues the Codex thread from ZCode item references", async () => {
  const setup = await gateway();
  const first = await setup.gateway.create({ model: "gpt-test", input: "first" });
  await setup.gateway.create({
    model: "gpt-test",
    input: [
      { role: "developer", content: "old instructions" },
      { role: "user", content: "first" },
      { type: "item_reference", id: first.output[0].id },
      { role: "user", content: "second" },
    ],
  });
  assert.equal(setup.fake.threadStarts, 1);
  assert.deepEqual(setup.fake.turnInputs[1], [{ type: "text", text: "user: second" }]);
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

test("routes subagent dynamic tool calls through the parent Responses session", async () => {
  const setup = await gateway();
  setup.fake.childToolMode = true;
  const first = await setup.gateway.create({
    model: "gpt-test",
    input: "delegate a lookup",
    tools: [{ type: "function", name: "lookup_value", parameters: { type: "object" } }],
  });
  assert.equal(first.output[0].type, "function_call");
  assert.equal(first.output[0].call_id, "call-thread-test-child");
  const second = await setup.gateway.create({
    model: "gpt-test",
    previous_response_id: first.id,
    input: [{ type: "function_call_output", call_id: "call-thread-test-child", output: "value" }],
  });
  assert.equal(second.output_text, "tool result accepted");
});

test("routes concurrent subagent tool calls to their respective parent sessions", async () => {
  const setup = await gateway();
  setup.fake.childToolMode = true;
  setup.fake.uniqueThreads = true;
  const request = (label: string) => setup.gateway.create({
    model: "gpt-test",
    input: `delegate ${label}`,
    tools: [{ type: "function", name: "lookup_value", parameters: { type: "object" } }],
  });
  const [first, second] = await Promise.all([request("one"), request("two")]);
  assert.deepEqual(
    new Set([first.output[0].call_id, second.output[0].call_id]),
    new Set(["call-thread-1-child", "call-thread-2-child"]),
  );
  const finish = (response: any) => setup.gateway.create({
    model: "gpt-test",
    previous_response_id: response.id,
    input: [{ type: "function_call_output", call_id: response.output[0].call_id, output: "value" }],
  });
  const [firstDone, secondDone] = await Promise.all([finish(first), finish(second)]);
  assert.equal(firstDone.output_text, "tool result accepted");
  assert.equal(secondDone.output_text, "tool result accepted");
});

test("drains concurrent tool calls without leaving the Codex turn stuck", async () => {
  const setup = await gateway();
  setup.fake.parallelToolMode = true;
  const first = await setup.gateway.create({
    model: "gpt-test",
    input: "run two tools",
    tools: [{ type: "function", name: "lookup_value", parameters: { type: "object" } }],
  });
  assert.equal(first.output[0].call_id, "call-one");
  const second = await setup.gateway.create({
    model: "gpt-test",
    previous_response_id: first.id,
    input: [{ type: "function_call_output", call_id: "call-one", output: "one" }],
  });
  assert.equal(second.output[0].call_id, "call-two");
  const third = await setup.gateway.create({
    model: "gpt-test",
    previous_response_id: second.id,
    input: [{ type: "function_call_output", call_id: "call-two", output: "two" }],
  });
  assert.equal(third.output_text, "tool result accepted");
});

test("cleans up an active session when turn/start fails", async () => {
  const setup = await gateway();
  setup.fake.failTurnStartOnce = true;
  await assert.rejects(setup.gateway.create({ model: "gpt-test", input: "first" }), /turn start failed/);
  const recovered = await setup.gateway.create({ model: "gpt-test", input: "second" });
  assert.equal(recovered.output_text, "hello");
});

test("ignores replayed historical tool outputs when a current tool call is pending", async () => {
  const setup = await gateway();
  setup.fake.toolMode = true;
  const first = await setup.gateway.create({
    model: "gpt-test",
    input: "read a file",
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
  });
  const second = await setup.gateway.create({
    model: "gpt-test",
    input: [
      { type: "function_call_output", call_id: "call-already-consumed", output: "old result" },
      { type: "function_call_output", call_id: first.output[0].call_id, output: "current result" },
    ],
  });
  assert.equal(second.output_text, "tool result accepted");
});

test("continues with user input after a completed historical tool exchange", async () => {
  const setup = await gateway();
  setup.fake.toolMode = true;
  const first = await setup.gateway.create({
    model: "gpt-test",
    input: "read a file",
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
  });
  await setup.gateway.create({
    model: "gpt-test",
    input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "contents" }],
  });
  setup.fake.toolMode = false;
  const continued = await setup.gateway.create({
    model: "gpt-test",
    input: [
      { role: "user", content: "old question" },
      { type: "function_call_output", call_id: first.output[0].call_id, output: "contents" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" },
    ],
  });
  assert.equal(continued.output_text, "hello");
  assert.deepEqual(setup.fake.turnInput, [{ type: "text", text: "assistant: old answer\n\nuser: new question" }]);
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
