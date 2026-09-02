import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { errorFields, log } from "./log.ts";

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
};

type PendingRequest = {
  method: string;
  startedAt: number;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type ServerRequest = {
  id: number | string;
  method: string;
  params: any;
  respond: (result: unknown) => void;
  reject: (code: number, message: string) => void;
};

export class CodexClient {
  private child?: ChildProcessWithoutNullStreams;
  private readonly events = new EventEmitter();
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private ready?: Promise<void>;

  onNotification(listener: (message: RpcMessage) => void): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  onServerRequest(listener: (request: ServerRequest) => void): () => void {
    this.events.on("request", listener);
    return () => this.events.off("request", listener);
  }

  async start(): Promise<void> {
    if (!this.ready) this.ready = this.startProcess();
    return this.ready;
  }

  async request(method: string, params?: unknown, timeoutMs = 300_000): Promise<any> {
    await this.start();
    return this.requestNow(method, params, timeoutMs);
  }

  private requestNow(method: string, params?: unknown, timeoutMs = 300_000): Promise<any> {
    const id = this.nextId++;
    const startedAt = Date.now();
    const result = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        log("error", "codex.rpc.timeout", { rpc_id: id, rpc_method: method, duration_ms: Date.now() - startedAt });
        reject(new Error(`Codex app-server timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { method, startedAt, resolve, reject, timeout });
    });
    log("info", "codex.rpc.request", { rpc_id: id, rpc_method: method, timeout_ms: timeoutMs });
    this.send({ id, method, ...(params === undefined ? {} : { params }) });
    return result;
  }

  async notify(method: string, params: unknown = {}): Promise<void> {
    await this.start();
    this.send({ method, params });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async startProcess(): Promise<void> {
    const contextWindow = positiveIntegerEnvironment("BRIDGE_MODEL_CONTEXT_WINDOW", 1_050_000);
    const autoCompactLimit = positiveIntegerEnvironment("BRIDGE_AUTO_COMPACT_TOKEN_LIMIT", 900_000);
    if (autoCompactLimit >= contextWindow) {
      throw new Error("BRIDGE_AUTO_COMPACT_TOKEN_LIMIT must be smaller than BRIDGE_MODEL_CONTEXT_WINDOW");
    }
    const child = spawn(process.env.CODEX_BIN || "codex", [
      "-c", `model_context_window=${contextWindow}`,
      "-c", `model_auto_compact_token_limit=${autoCompactLimit}`,
      "-c", 'model_auto_compact_token_limit_scope="total"',
      "app-server",
      "--stdio",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    log("info", "codex.process.start", {
      command: process.env.CODEX_BIN || "codex",
      model_context_window: contextWindow,
      auto_compact_token_limit: autoCompactLimit,
    });
    this.child = child;
    child.once("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`);
      log("error", "codex.process.exit", { exit_code: code, signal });
      this.failAll(error);
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
      }
    });
    child.once("error", (error) => {
      log("error", "codex.process.error", errorFields(error));
      this.failAll(error);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    const errors = createInterface({ input: child.stderr });
    errors.on("line", (line) => log("warn", "codex.stderr", { message: line }));

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.requestNow("initialize", {
      clientInfo: {
        name: "zcode_chatgpt_bridge",
        title: "ZCode ChatGPT Bridge",
        version: "local",
      },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
  }

  private send(message: RpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      log("warn", "codex.rpc.invalid_json", { line_length: line.length });
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        log("warn", "codex.rpc.orphan_response", { rpc_id: message.id });
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(String(message.id));
      const fields = {
        rpc_id: message.id,
        rpc_method: pending.method,
        duration_ms: Date.now() - pending.startedAt,
      };
      if (message.error) {
        log("error", "codex.rpc.error", { ...fields, error_code: message.error.code, error_message: message.error.message });
        pending.reject(Object.assign(new Error(message.error.message), message.error));
      } else {
        log("info", "codex.rpc.response", fields);
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      const params = message.params || {};
      log("info", "codex.server_request", {
        rpc_id: message.id,
        rpc_method: message.method,
        thread_id: params.threadId,
        turn_id: params.turnId,
        call_id: params.callId,
        tool: params.tool,
      });
      const respond = (result: unknown) => {
        log("info", "codex.server_request.response", { rpc_id: message.id, rpc_method: message.method });
        this.send({ id: message.id, result });
      };
      const reject = (code: number, text: string) => {
        log("warn", "codex.server_request.rejected", { rpc_id: message.id, rpc_method: message.method, error_code: code, error_message: text });
        this.send({ id: message.id, error: { code, message: text } });
      };
      if (this.events.listenerCount("request")) {
        this.events.emit("request", { id: message.id, method: message.method, params: message.params, respond, reject });
      } else {
        reject(-32601, `Unsupported app-server request: ${message.method}`);
      }
      return;
    }
    if (message.method !== "item/agentMessage/delta") {
      const params = message.params || {};
      log("debug", "codex.notification", {
        rpc_method: message.method,
        thread_id: params.threadId || params.thread?.id,
        parent_thread_id: params.thread?.parentThreadId,
        turn_id: params.turnId || params.turn?.id,
        turn_status: params.turn?.status,
        item_type: params.item?.type,
        sender_thread_id: params.item?.senderThreadId,
        receiver_thread_ids: params.item?.receiverThreadIds,
        collab_tool: params.item?.tool,
        collab_status: params.item?.status,
      });
    }
    this.events.emit("notification", message);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
