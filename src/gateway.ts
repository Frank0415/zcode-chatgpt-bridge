import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CodexClient, type RpcMessage, type ServerRequest } from "./codex.ts";
import { errorFields, log } from "./log.ts";

type JsonObject = Record<string, any>;

type SavedState = {
  responses: Record<string, { threadId: string; model: string; createdAt: number; toolNames?: Record<string, string> }>;
  compactions: Record<string, { threadId: string; model: string; createdAt: number; toolNames?: Record<string, string> }>;
  items: Record<string, { threadId: string; model: string; createdAt: number; toolNames?: Record<string, string> }>;
};

type Phase =
  | { kind: "message"; text: string; error?: string }
  | { kind: "tool"; callId: string; name: string; arguments: string };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type TurnSession = {
  responseId: string;
  threadId: string;
  turnId?: string;
  startedAt: number;
  text: string;
  phase: Deferred<Phase>;
  phaseDone: boolean;
  onDelta?: (delta: string) => void;
};

type PendingTool = {
  session: TurnSession;
  request: ServerRequest;
  timeout: ReturnType<typeof setTimeout>;
};

export type ResponseEvent = { type: string; [key: string]: unknown };

export class ResponsesGateway {
  readonly codex: CodexClient;
  private readonly statePath: string;
  private state: SavedState = { responses: {}, compactions: {}, items: {} };
  private stateLoaded = false;
  private stateWrite = Promise.resolve();
  private readonly loadedThreads = new Set<string>();
  private readonly turns = new Map<string, TurnSession>();
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly toolNamesByThread = new Map<string, Map<string, string>>();
  private readonly parentThreads = new Map<string, string>();
  private readonly turnTimeoutMs = positiveIntegerEnvironment("BRIDGE_TURN_TIMEOUT_MS", 600_000);
  private readonly toolOutputTimeoutMs = positiveIntegerEnvironment("BRIDGE_TOOL_OUTPUT_TIMEOUT_MS", 300_000);

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
    log("info", "response.start", {
      response_id: responseId,
      model,
      stream: Boolean(emit),
      tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
      has_previous_response: typeof body.previous_response_id === "string",
    });
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
    const receivedToolOutputs = extractToolOutputs(body.input);
    const toolOutputs = receivedToolOutputs.filter((output) => this.pendingTools.has(output.callId));
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
        clearTimeout(entry.pending!.timeout);
        log("info", "tool.output.received", {
          response_id: responseId,
          thread_id: session.threadId,
          call_id: entry.output.callId,
        });
        entry.pending!.request.respond({
          success: true,
          contentItems: [{ type: "inputText", text: entry.output.output }],
        });
      }
      this.activatePendingTool(session);
    } else {
      threadId = await this.resolveThread(body, model);
      if (this.turns.has(threadId)) throw new Error("The previous response is still waiting for a tool output");
      session = {
        responseId,
        threadId,
        startedAt: Date.now(),
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
      const input = toCodexInput(this.newInput(body.input), body.instructions);
      if (!input.length) {
        this.turns.delete(threadId);
        if (receivedToolOutputs.length) throw new Error("No pending Codex tool call matches function_call_output");
        throw new Error("input must contain text or an image");
      }
      try {
        const result = await this.codex.request("turn/start", {
          threadId,
          input,
          model,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" } },
          ...(body.reasoning?.effort ? { effort: body.reasoning.effort } : {}),
        });
        session.turnId = result?.turn?.id;
        log("info", "turn.start", { response_id: responseId, thread_id: threadId, turn_id: session.turnId, model });
      } catch (error) {
        this.turns.delete(threadId);
        log("error", "turn.start.failed", { response_id: responseId, thread_id: threadId, ...errorFields(error) });
        throw error;
      }
    }

    const phase = await this.waitForPhase(session, phasePromise);
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
    for (const item of output) {
      if (typeof item.id === "string") this.state.items[item.id] = { threadId, model, createdAt, ...this.savedToolNames(threadId) };
    }
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
    log("info", "response.complete", {
      response_id: responseId,
      thread_id: threadId,
      turn_id: session.turnId,
      phase: phase.kind,
      status: response.status,
      duration_ms: Date.now() - session.startedAt,
    });
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
    log("info", "compaction.start", { thread_id: threadId, model });
    await this.waitForCompaction(threadId);
    const id = `resp_${randomUUID().replaceAll("-", "")}`;
    const handle = `cmp_${randomUUID().replaceAll("-", "")}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const toolNames = this.savedToolNames(threadId);
    this.state.compactions[handle] = { threadId, model, createdAt, ...toolNames };
    this.state.responses[id] = { threadId, model, createdAt, ...toolNames };
    await this.saveState();
    log("info", "compaction.complete", { thread_id: threadId, model, response_id: id, compaction_id: handle });
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
    log("info", "thread.start", { thread_id: threadId, model, tool_count: mappedTools.tools.length });
    return threadId;
  }

  private threadFromBody(body: JsonObject): string | undefined {
    const previous = typeof body.previous_response_id === "string" ? this.state.responses[body.previous_response_id] : undefined;
    if (previous) {
      this.restoreToolNames(previous.threadId, previous.toolNames);
      return previous.threadId;
    }
    const input = Array.isArray(body.input) ? body.input : [];
    for (let index = input.length - 1; index >= 0; index--) {
      const item = input[index];
      if (item?.type === "item_reference" && typeof item.id === "string") {
        const saved = this.state.items[item.id];
        if (saved) {
          this.restoreToolNames(saved.threadId, saved.toolNames);
          return saved.threadId;
        }
      }
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
    log("info", "thread.resume", { thread_id: threadId, model });
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
    if (message.method === "thread/started") {
      const threadId = params.thread?.id;
      const parentThreadId = params.thread?.parentThreadId;
      if (typeof threadId === "string" && typeof parentThreadId === "string") {
        this.parentThreads.set(threadId, parentThreadId);
        log("info", "subagent.thread.started", { thread_id: threadId, parent_thread_id: parentThreadId });
      }
      return;
    }
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
      this.forgetDescendants(session.threadId);
      log(error ? "error" : "info", "turn.complete", {
        response_id: session.responseId,
        thread_id: session.threadId,
        turn_id: params.turn?.id || session.turnId,
        status: params.turn?.status,
        ...(error ? { error_message: error } : {}),
      });
    }
  }

  private onServerRequest(request: ServerRequest): void {
    if (request.method === "item/tool/call") {
      const params = request.params || {};
      const session = this.sessionForToolThread(params.threadId);
      if (!session) {
        log("warn", "tool.call.unroutable", { thread_id: params.threadId, turn_id: params.turnId, call_id: params.callId, tool: params.tool });
        request.reject(-32004, "No active Responses request for this tool call");
        return;
      }
      const callId = String(params.callId);
      const timeout = setTimeout(() => {
        const pending = this.pendingTools.get(callId);
        if (!pending) return;
        this.pendingTools.delete(callId);
        pending.request.reject(-32008, "Timed out waiting for function_call_output");
        log("error", "tool.output.timeout", {
          response_id: session.responseId,
          thread_id: params.threadId,
          root_thread_id: session.threadId,
          call_id: callId,
          tool: params.tool,
          timeout_ms: this.toolOutputTimeoutMs,
        });
      }, this.toolOutputTimeoutMs);
      timeout.unref?.();
      this.pendingTools.set(callId, { session, request, timeout });
      log("info", "tool.call", {
        response_id: session.responseId,
        thread_id: params.threadId,
        root_thread_id: session.threadId,
        turn_id: params.turnId,
        call_id: callId,
        tool: params.tool,
        from_subagent: params.threadId !== session.threadId,
      });
      this.activatePendingTool(session);
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
        items: value?.items && typeof value.items === "object" ? value.items : {},
      };
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  private async saveState(): Promise<void> {
    const write = this.stateWrite.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.statePath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    this.stateWrite = write.catch(() => undefined);
    await write;
  }

  private savedToolNames(threadId: string): { toolNames?: Record<string, string> } {
    const names = this.toolNamesByThread.get(threadId);
    return names?.size ? { toolNames: Object.fromEntries(names) } : {};
  }

  private restoreToolNames(threadId: string, names?: Record<string, string>): void {
    if (names && !this.toolNamesByThread.has(threadId)) this.toolNamesByThread.set(threadId, new Map(Object.entries(names)));
  }

  private newInput(input: unknown): unknown {
    if (!Array.isArray(input)) return input;
    let boundary = -1;
    for (let index = 0; index < input.length; index++) {
      const item = input[index];
      if (item?.type === "item_reference" && typeof item.id === "string" && this.state.items[item.id]) boundary = index;
      if (item?.type === "function_call_output") boundary = index;
    }
    return boundary < 0 ? input : input.slice(boundary + 1);
  }

  private activatePendingTool(session: TurnSession): void {
    if (session.phaseDone) return;
    const entry = [...this.pendingTools.entries()].find(([, pending]) => pending.session === session);
    if (!entry) return;
    const [callId, pending] = entry;
    const params = pending.request.params || {};
    session.phaseDone = true;
    session.phase.resolve({
      kind: "tool",
      callId,
      name: this.toolNamesByThread.get(session.threadId)?.get(String(params.tool)) || String(params.tool),
      arguments: JSON.stringify(params.arguments ?? {}),
    });
  }

  private sessionForToolThread(threadId: unknown): TurnSession | undefined {
    if (typeof threadId !== "string") return undefined;
    let current: string | undefined = threadId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const session = this.turns.get(current);
      if (session) return session;
      current = this.parentThreads.get(current);
    }
    if (this.turns.size === 1) {
      const session = this.turns.values().next().value as TurnSession | undefined;
      if (session) {
        log("warn", "tool.call.single_session_fallback", { thread_id: threadId, root_thread_id: session.threadId });
        return session;
      }
    }
    return undefined;
  }

  private async waitForPhase(session: TurnSession, phase: Promise<Phase>): Promise<Phase> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        phase,
        new Promise<Phase>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Codex turn timed out after ${this.turnTimeoutMs}ms`)), this.turnTimeoutMs);
        }),
      ]);
    } catch (error) {
      this.turns.delete(session.threadId);
      this.rejectPendingTools(session, "Codex turn timed out");
      this.forgetDescendants(session.threadId);
      log("error", "turn.timeout", {
        response_id: session.responseId,
        thread_id: session.threadId,
        turn_id: session.turnId,
        timeout_ms: this.turnTimeoutMs,
      });
      if (session.turnId) {
        void this.codex.request("turn/interrupt", { threadId: session.threadId, turnId: session.turnId }, 30_000).catch((interruptError) => {
          log("warn", "turn.interrupt.failed", { thread_id: session.threadId, turn_id: session.turnId, ...errorFields(interruptError) });
        });
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private rejectPendingTools(session: TurnSession, message: string): void {
    for (const [callId, pending] of this.pendingTools) {
      if (pending.session !== session) continue;
      clearTimeout(pending.timeout);
      this.pendingTools.delete(callId);
      pending.request.reject(-32008, message);
    }
  }

  private forgetDescendants(rootThreadId: string): void {
    for (const threadId of this.parentThreads.keys()) {
      let current: string | undefined = threadId;
      const visited = new Set<string>();
      while (current && !visited.has(current)) {
        visited.add(current);
        const parent = this.parentThreads.get(current);
        if (parent === rootThreadId) {
          this.parentThreads.delete(threadId);
          break;
        }
        current = parent;
      }
    }
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

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
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
