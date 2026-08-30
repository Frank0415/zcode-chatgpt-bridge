import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CodexClient, type RpcMessage, type ServerRequest } from "./codex.ts";

type JsonObject = Record<string, any>;

type SavedState = {
  responses: Record<string, { threadId: string; model: string; createdAt: number; toolNames?: Record<string, string> }>;
  compactions: Record<string, { threadId: string; model: string; createdAt: number; toolNames?: Record<string, string> }>;
};

type Phase =
  | { kind: "message"; text: string; error?: string }
  | { kind: "tool"; callId: string; name: string; arguments: string };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type TurnSession = {
  threadId: string;
  turnId?: string;
  text: string;
  phase: Deferred<Phase>;
  phaseDone: boolean;
  onDelta?: (delta: string) => void;
};

type PendingTool = {
  session: TurnSession;
  request: ServerRequest;
};

export type ResponseEvent = { type: string; [key: string]: unknown };

export class ResponsesGateway {
  readonly codex: CodexClient;
  private readonly statePath: string;
  private state: SavedState = { responses: {}, compactions: {} };
  private stateLoaded = false;
  private readonly loadedThreads = new Set<string>();
  private readonly turns = new Map<string, TurnSession>();
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly toolNamesByThread = new Map<string, Map<string, string>>();

  constructor(codex = new CodexClient(), statePath = join(homedir(), ".config", "zcode-chatgpt-bridge", "responses.json")) {
    this.codex = codex;
    this.statePath = statePath;
    codex.onNotification((message) => this.onNotification(message));
    codex.onServerRequest((request) => this.onServerRequest(request));
  }

  async models(): Promise<JsonObject> {
    const result = await this.codex.request("model/list", { limit: 100, includeHidden: false });
    return {
      object: "list",
      data: (result?.data || []).map((model: JsonObject) => ({
        id: model.id || model.model,
        object: "model",
        created: 0,
        owned_by: "openai",
      })),
    };
  }

  async account(): Promise<JsonObject> {
    const result = await this.codex.request("account/read", { refreshToken: false });
    return {
      authenticated: Boolean(result?.account),
      account: result?.account ?? null,
      requires_openai_auth: result?.requiresOpenaiAuth ?? true,
    };
  }

  async login(mode: "browser" | "device" = "browser"): Promise<JsonObject> {
    return this.codex.request("account/login/start", mode === "device"
      ? { type: "chatgptDeviceCode" }
      : { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" });
  }

  async logout(): Promise<void> {
    await this.codex.request("account/logout");
  }

  async create(body: JsonObject, emit?: (event: ResponseEvent) => void): Promise<JsonObject> {
    await this.loadState();
    const model = requiredString(body.model, "model");
    const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
    let messageStreamStarted = false;
    const startMessageStream = () => {
      if (messageStreamStarted) return;
      messageStreamStarted = true;
      emit?.({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      emit?.({
        type: "response.content_part.added",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    };
    const toolOutputs = extractToolOutputs(body.input);
    let threadId: string;
    let phasePromise: Promise<Phase>;
    let session: TurnSession;

    emit?.({ type: "response.created", response: responseShell(responseId, model, createdAt, "in_progress") });
    emit?.({ type: "response.in_progress", response: responseShell(responseId, model, createdAt, "in_progress") });

    if (toolOutputs.length) {
      const pending = toolOutputs.map((output) => ({ output, pending: this.pendingTools.get(output.callId) }));
      if (pending.some((entry) => !entry.pending)) throw new Error("No pending Codex tool call matches function_call_output");
      session = pending[0].pending!.session;
      if (pending.some((entry) => entry.pending!.session !== session)) throw new Error("Tool outputs belong to different Codex turns");
      session.text = "";
      session.phase = deferred<Phase>();
      session.phaseDone = false;
      session.onDelta = (delta) => emit?.({
        ...(startMessageStream(), {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta,
        }),
      });
      threadId = session.threadId;
      phasePromise = session.phase.promise;
      for (const entry of pending) {
        this.pendingTools.delete(entry.output.callId);
        entry.pending!.request.respond({
          success: true,
          contentItems: [{ type: "inputText", text: entry.output.output }],
        });
      }
    } else {
      threadId = await this.resolveThread(body, model);
      if (this.turns.has(threadId)) throw new Error("The previous response is still waiting for a tool output");
      session = {
        threadId,
        text: "",
        phase: deferred<Phase>(),
        phaseDone: false,
      };
      session.onDelta = (delta) => emit?.({
        ...(startMessageStream(), {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta,
        }),
      });
      this.turns.set(threadId, session);
      phasePromise = session.phase.promise;
      const input = toCodexInput(body.input, body.instructions);
      if (!input.length) throw new Error("input must contain text or an image");
      const result = await this.codex.request("turn/start", {
        threadId,
        input,
        model,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" } },
        ...(body.reasoning?.effort ? { effort: body.reasoning.effort } : {}),
      });
      session.turnId = result?.turn?.id;
    }

    const phase = await phasePromise;
    const output = phase.kind === "tool"
      ? [{
          id: `fc_${randomUUID().replaceAll("-", "")}`,
          type: "function_call",
          status: "completed",
          call_id: phase.callId,
          name: phase.name,
          arguments: phase.arguments,
        }]
      : [{
          id: messageId,
          type: "message",
          status: phase.error ? "incomplete" : "completed",
          role: "assistant",
          content: [{ type: "output_text", text: phase.text, annotations: [] }],
        }];

    const response = {
      ...responseShell(responseId, model, createdAt, phase.error ? "failed" : "completed"),
      output,
      output_text: phase.kind === "message" ? phase.text : "",
      error: phase.kind === "message" && phase.error ? { code: "codex_error", message: phase.error } : null,
      incomplete_details: null,
      usage: emptyUsage(),
    };
    this.state.responses[responseId] = {
      threadId,
      model,
      createdAt,
      ...this.savedToolNames(threadId),
    };
    await this.saveState();

    if (phase.kind === "tool") {
      const item = output[0];
      emit?.({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
      emit?.({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: phase.arguments });
      emit?.({ type: "response.output_item.done", output_index: 0, item });
    } else {
      startMessageStream();
      emit?.({ type: "response.output_text.done", item_id: messageId, output_index: 0, content_index: 0, text: phase.text });
      emit?.({ type: "response.content_part.done", item_id: messageId, output_index: 0, content_index: 0, part: output[0].content[0] });
      emit?.({ type: "response.output_item.done", output_index: 0, item: output[0] });
    }
    emit?.({ type: "response.completed", response });
    return response;
  }

  async retrieve(responseId: string): Promise<JsonObject | undefined> {
    await this.loadState();
    const saved = this.state.responses[responseId];
    if (!saved) return undefined;
    return { id: responseId, object: "response", created_at: saved.createdAt, model: saved.model, status: "completed" };
  }

  async compact(body: JsonObject): Promise<JsonObject> {
    await this.loadState();
    const model = requiredString(body.model, "model");
    const threadId = this.threadFromBody(body);
    if (!threadId) throw new Error("previous_response_id or a bridge compaction item is required");
    await this.ensureThread(threadId, model);
    await this.waitForCompaction(threadId);
    const id = `resp_${randomUUID().replaceAll("-", "")}`;
    const handle = `cmp_${randomUUID().replaceAll("-", "")}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const toolNames = this.savedToolNames(threadId);
    this.state.compactions[handle] = { threadId, model, createdAt, ...toolNames };
    this.state.responses[id] = { threadId, model, createdAt, ...toolNames };
    await this.saveState();
    return {
      id,
      object: "response.compaction",
      created_at: createdAt,
      output: [{ id: handle, type: "compaction", encrypted_content: handle }],
      usage: emptyUsage(),
    };
  }

  async close(): Promise<void> {
    await this.codex.close();
  }

  private async resolveThread(body: JsonObject, model: string): Promise<string> {
    const existing = this.threadFromBody(body);
    if (existing) {
      await this.ensureThread(existing, model);
      return existing;
    }
    const mappedTools = mapTools(body.tools);
    const result = await this.codex.request("thread/start", {
      model,
      modelProvider: "openai",
      cwd: process.env.BRIDGE_CWD || homedir(),
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "zcode_chatgpt_bridge",
      ...(mappedTools.tools.length ? { dynamicTools: mappedTools.tools } : {}),
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error("Codex did not return a thread id");
    this.loadedThreads.add(threadId);
    this.toolNamesByThread.set(threadId, mappedTools.names);
    return threadId;
  }

  private threadFromBody(body: JsonObject): string | undefined {
    const previous = typeof body.previous_response_id === "string" ? this.state.responses[body.previous_response_id] : undefined;
    if (previous) {
      this.restoreToolNames(previous.threadId, previous.toolNames);
      return previous.threadId;
    }
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (item?.type === "compaction" && typeof item.encrypted_content === "string") {
        const saved = this.state.compactions[item.encrypted_content];
        if (saved) {
          this.restoreToolNames(saved.threadId, saved.toolNames);
          return saved.threadId;
        }
      }
    }
    return undefined;
  }

  private async ensureThread(threadId: string, model: string): Promise<void> {
    if (this.loadedThreads.has(threadId)) return;
    await this.codex.request("thread/resume", { threadId, model });
    this.loadedThreads.add(threadId);
  }

  private async waitForCompaction(threadId: string): Promise<void> {
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        dispose();
        reject(new Error("Codex compaction timed out"));
      }, 300_000);
      const dispose = this.codex.onNotification((message) => {
        const params = message.params || {};
        if (message.method === "item/completed" && params.threadId === threadId && params.item?.type === "contextCompaction") {
          clearTimeout(timeout);
          dispose();
          resolve();
        }
        if (message.method === "turn/completed" && params.threadId === threadId && params.turn?.status === "failed") {
          clearTimeout(timeout);
          dispose();
          reject(new Error(params.turn?.error?.message || "Codex compaction failed"));
        }
      });
    });
    await this.codex.request("thread/compact/start", { threadId });
    await completed;
  }

  private onNotification(message: RpcMessage): void {
    const params = message.params || {};
    const session = typeof params.threadId === "string" ? this.turns.get(params.threadId) : undefined;
    if (!session) return;
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      session.text += params.delta;
      session.onDelta?.(params.delta);
      return;
    }
    if (message.method === "item/completed" && params.item?.type === "agentMessage" && !session.text) {
      session.text = params.item.text || params.item.content?.map((part: JsonObject) => part.text || "").join("") || "";
      return;
    }
    if (message.method === "turn/completed") {
      if (session.phaseDone) return;
      session.phaseDone = true;
      const error = params.turn?.status === "failed" ? params.turn?.error?.message || "Codex turn failed" : undefined;
      session.phase.resolve({ kind: "message", text: session.text, ...(error ? { error } : {}) });
      this.turns.delete(session.threadId);
    }
  }

  private onServerRequest(request: ServerRequest): void {
    if (request.method === "item/tool/call") {
      const params = request.params || {};
      const session = this.turns.get(params.threadId);
      if (!session) {
        request.reject(-32004, "No active Responses request for this tool call");
        return;
      }
      const callId = String(params.callId);
      this.pendingTools.set(callId, { session, request });
      if (!session.phaseDone) {
        session.phaseDone = true;
        session.phase.resolve({
          kind: "tool",
          callId,
          name: this.toolNamesByThread.get(session.threadId)?.get(String(params.tool)) || String(params.tool),
          arguments: JSON.stringify(params.arguments ?? {}),
        });
      }
      return;
    }
    if (request.method === "currentTime/read") {
      request.respond({ currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    if (request.method === "item/permissions/requestApproval") {
      request.respond({ permissions: [], scope: "turn" });
      return;
    }
    if (request.method.includes("requestApproval")) {
      request.respond({ decision: "decline" });
      return;
    }
    request.reject(-32601, `Unsupported app-server request: ${request.method}`);
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8"));
      this.state = {
        responses: value?.responses && typeof value.responses === "object" ? value.responses : {},
        compactions: value?.compactions && typeof value.compactions === "object" ? value.compactions : {},
      };
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  private async saveState(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  private savedToolNames(threadId: string): { toolNames?: Record<string, string> } {
    const names = this.toolNamesByThread.get(threadId);
    return names?.size ? { toolNames: Object.fromEntries(names) } : {};
  }

  private restoreToolNames(threadId: string, names?: Record<string, string>): void {
    if (names && !this.toolNamesByThread.has(threadId)) this.toolNamesByThread.set(threadId, new Map(Object.entries(names)));
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function responseShell(id: string, model: string, createdAt: number, status: string): JsonObject {
  return {
    id,
    object: "response",
    created_at: createdAt,
    model,
    status,
    background: false,
    output: [],
    parallel_tool_calls: true,
    store: true,
  };
}

function emptyUsage(): JsonObject {
  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  };
}

function mapTools(tools: unknown): { tools: JsonObject[]; names: Map<string, string> } {
  const names = new Map<string, string>();
  if (!Array.isArray(tools)) return { tools: [], names };
  const mapped = tools.flatMap((tool, index) => {
    if (!tool || tool.type !== "function") return [];
    const source = tool.function && typeof tool.function === "object" ? tool.function : tool;
    if (typeof source.name !== "string") return [];
    const safeName = safeToolName(source.name, index);
    names.set(safeName, source.name);
    return [{
      type: "function",
      name: safeName,
      description: `[ZCode tool: ${source.name}] ${typeof source.description === "string" ? source.description : ""}`,
      inputSchema: source.parameters || { type: "object", properties: {} },
    }];
  });
  return { tools: mapped, names };
}

function safeToolName(name: string, index: number): string {
  const sanitized = name.replace(/[^A-Za-z0-9_-]/g, "_");
  const suffix = `_${index}`;
  return `zcode_${sanitized}`.slice(0, 64 - suffix.length) + suffix;
}

function extractToolOutputs(input: unknown): Array<{ callId: string; output: string }> {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => item?.type === "function_call_output" && typeof item.call_id === "string"
    ? [{ callId: item.call_id, output: typeof item.output === "string" ? item.output : JSON.stringify(item.output) }]
    : []);
}

export function formatInput(input: unknown, instructions?: unknown): string {
  return toCodexInput(input, instructions)
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n\n");
}

export function toCodexInput(input: unknown, instructions?: unknown): JsonObject[] {
  const result: JsonObject[] = [];
  const chunks: string[] = [];
  if (typeof instructions === "string" && instructions.trim()) chunks.push(`Developer instructions:\n${instructions}`);
  if (typeof input === "string") chunks.push(input);
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || item.type === "function_call_output" || item.type === "compaction") continue;
      const role = typeof item.role === "string" ? item.role : "user";
      if (item.type === "input_image") {
        result.push(imageInput(item));
      } else if (typeof item.content === "string") chunks.push(`${role}: ${item.content}`);
      else if (Array.isArray(item.content)) {
        const text = item.content
          .map((part: JsonObject) => typeof part?.text === "string" ? part.text : "")
          .filter(Boolean)
          .join("\n");
        if (text) chunks.push(`${role}: ${text}`);
        for (const part of item.content) {
          if (part?.type === "input_image") result.push(imageInput(part));
        }
      } else if (typeof item.text === "string") chunks.push(`${role}: ${item.text}`);
    }
  }
  if (chunks.length) result.unshift({ type: "text", text: chunks.join("\n\n") });
  return result;
}

function imageInput(part: JsonObject): JsonObject {
  if (typeof part.image_url !== "string" || !part.image_url) {
    throw new Error("input_image.image_url must be a URL or data URL");
  }
  return {
    type: "image",
    url: part.image_url,
    ...(typeof part.detail === "string" ? { detail: part.detail } : {}),
  };
}
