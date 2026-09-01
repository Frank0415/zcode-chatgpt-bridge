import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
};

type PendingRequest = {
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
    const result = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex app-server timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timeout });
    });
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
    const contextWindow = positiveIntegerEnvironment("BRIDGE_MODEL_CONTEXT_WINDOW", 1_000_000);
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
    this.child = child;
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("exit", (code, signal) => {
      this.failAll(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
      }
    });
    child.once("error", (error) => this.failAll(error));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));

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
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const respond = (result: unknown) => this.send({ id: message.id, result });
      const reject = (code: number, text: string) => this.send({ id: message.id, error: { code, message: text } });
      if (this.events.listenerCount("request")) {
        this.events.emit("request", { id: message.id, method: message.method, params: message.params, respond, reject });
      } else {
        reject(-32601, `Unsupported app-server request: ${message.method}`);
      }
      return;
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
