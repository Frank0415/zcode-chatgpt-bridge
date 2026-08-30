#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.ts";

const endpoint = "http://127.0.0.1:9099/v1";
const controlOrigin = "http://127.0.0.1:9099";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "serve":
      await serve();
      return;
    case "install":
      await install();
      return;
    case "start":
    case "stop":
    case "restart":
      systemctl(command);
      if (command !== "stop") await waitForService();
      console.log(command === "stop" ? "Service stopped." : `Service running. Endpoint: ${endpoint}`);
      return;
    case "status":
      await status();
      return;
    case "endpoint":
      console.log(endpoint);
      return;
    case "login":
      await login(args[0] === "device" ? "device" : "browser");
      return;
    case "logout":
      await post("/bridge/logout", {});
      console.log("Signed out.");
      return;
    case "models": {
      const result = await get("/v1/models");
      for (const model of result.data || []) console.log(model.id);
      return;
    }
    default:
      printHelp();
  }
}

async function serve(): Promise<void> {
  const server = await startServer();
  console.log(`Listening on ${server.endpoint}`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function install(): Promise<void> {
  const userHome = homedir();
  const installRoot = join(userHome, ".local", "lib", "zcode-chatgpt-bridge");
  const binPath = join(userHome, ".local", "bin", "zcode-chatgpt-bridge");
  const unitPath = join(userHome, ".config", "systemd", "user", "zcode-chatgpt-bridge.service");
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await mkdir(installRoot, { recursive: true });
  if (sourceRoot !== installRoot) {
    await rm(join(installRoot, "src"), { recursive: true, force: true });
    await cp(join(sourceRoot, "src"), join(installRoot, "src"), { recursive: true });
  }
  await mkdir(dirname(binPath), { recursive: true });
  const nodePath = process.execPath;
  await writeFile(binPath, `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(join(installRoot, "src", "main.ts"))} "$@"\n`, { mode: 0o755 });
  await mkdir(dirname(unitPath), { recursive: true });
  await writeFile(unitPath, `[Unit]
Description=Local OpenAI Responses bridge backed by Codex
After=network-online.target

[Service]
Type=simple
Environment=PATH=${join(userHome, ".local", "bin")}:/usr/local/bin:/usr/bin
ExecStart=${nodePath} ${join(installRoot, "src", "main.ts")} serve
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`);

  const oldDesktop = join(userHome, ".local", "share", "applications", "zcode-chatgpt-bridge.desktop");
  try {
    const contents = await readFile(oldDesktop, "utf8");
    if (contents.includes("zcode-chatgpt-bridge")) await rm(oldDesktop);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  systemctl("daemon-reload");
  systemctl("enable", "zcode-chatgpt-bridge.service");
  systemctl("restart", "zcode-chatgpt-bridge.service");
  await waitForService();
  console.log(`Installed and running. Endpoint: ${endpoint}`);
}

async function status(): Promise<void> {
  try {
    const result = await get("/bridge/status");
    console.log(`Service: running\nEndpoint: ${result.endpoint}\nChatGPT: ${result.authenticated ? "signed in" : "not signed in"}`);
    if (result.account?.email) console.log(`Account: ${result.account.email}`);
    if (result.account?.planType) console.log(`Plan: ${result.account.planType}`);
  } catch {
    console.log(`Service: stopped\nEndpoint: ${endpoint}`);
  }
}

async function login(mode: "browser" | "device"): Promise<void> {
  try {
    await get("/healthz");
  } catch {
    systemctl("start");
    await waitForService();
  }
  const result = await post("/bridge/login", { mode });
  if (result.authUrl) {
    console.log(`Open this URL to sign in:\n${result.authUrl}`);
    const child = spawn("xdg-open", [result.authUrl], { detached: true, stdio: "ignore" });
    child.unref();
  } else if (result.verificationUrl && result.userCode) {
    console.log(`Open: ${result.verificationUrl}\nCode: ${result.userCode}`);
  }
  console.log("The service will finish authentication in the background. You may close this terminal.");
}

function systemctl(...args: string[]): void {
  const result = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed`);
}

async function waitForService(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await get("/healthz");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("Service did not become ready");
}

async function get(path: string): Promise<any> {
  const response = await fetch(`${controlOrigin}${path}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
  return body;
}

async function post(path: string, data: unknown): Promise<any> {
  const response = await fetch(`${controlOrigin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
  return body;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function printHelp(): void {
  console.log(`Usage: zcode-chatgpt-bridge <command>

  install          install and start the background user service
  start            start the background service
  stop             stop the background service
  restart          restart the background service
  status           show service and ChatGPT login status
  endpoint         print the OpenAI-compatible base URL
  login [device]   sign in with ChatGPT
  logout           sign out
  models           list models available to this ChatGPT account`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
