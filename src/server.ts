import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ResponsesGateway, type ResponseEvent } from "./gateway.ts";

export type BridgeServer = {
  close: () => Promise<void>;
  endpoint: string;
};

export async function startServer(gateway = new ResponsesGateway()): Promise<BridgeServer> {
  const host = "127.0.0.1";
  const port = Number(process.env.BRIDGE_PORT || 9099);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("BRIDGE_PORT must be a valid TCP port");

  const server = createServer(async (request, response) => {
    setCommonHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    try {
      await route(gateway, request, response, `http://${host}:${port}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (response.headersSent) {
        response.write(`event: error\ndata: ${JSON.stringify({
          type: "error",
          sequence_number: 0,
          error: { type: "server_error", code: "bridge_error", message, param: null },
        })}\n\n`);
        response.end();
        return;
      }
      sendJson(response, 400, { error: { message, type: "invalid_request_error", code: null } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    endpoint: `http://${host}:${port}/v1`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await gateway.close();
    },
  };
}

async function route(gateway: ResponsesGateway, request: IncomingMessage, response: ServerResponse, origin: string): Promise<void> {
  const url = new URL(request.url || "/", origin);
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true, endpoint: `${origin}/v1` });
    return;
  }
  if (request.method === "GET" && url.pathname === "/bridge/status") {
    sendJson(response, 200, { ok: true, endpoint: `${origin}/v1`, ...(await gateway.account()) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/bridge/login") {
    const body = await readJson(request);
    sendJson(response, 200, await gateway.login(body.mode === "device" ? "device" : "browser"));
    return;
  }
  if (request.method === "POST" && url.pathname === "/bridge/logout") {
    await gateway.logout();
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, await gateway.models());
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/responses") {
    const body = await readJson(request);
    if (body.stream === true) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      const emit = (event: ResponseEvent) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      await gateway.create(body, emit);
      response.write("data: [DONE]\n\n");
      response.end();
    } else {
      sendJson(response, 200, await gateway.create(body));
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/responses/compact") {
    sendJson(response, 200, await gateway.compact(await readJson(request)));
    return;
  }
  const responseMatch = request.method === "GET" ? url.pathname.match(/^\/v1\/responses\/([^/]+)$/) : null;
  if (responseMatch) {
    const found = await gateway.retrieve(decodeURIComponent(responseMatch[1]));
    if (!found) sendJson(response, 404, { error: { message: "Response not found", type: "invalid_request_error", code: null } });
    else sendJson(response, 200, found);
    return;
  }
  sendJson(response, 404, { error: { message: "Not found", type: "invalid_request_error", code: null } });
}

async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16 * 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
  return value;
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, OpenAI-Beta");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}
