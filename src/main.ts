#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
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
      serviceControl(command);
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
    case "logs":
      await showLogs(args);
      return;
    case "log-path":
      console.log(logPath());
      return;
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
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await mkdir(installRoot, { recursive: true });
  if (sourceRoot !== installRoot) {
    await rm(join(installRoot, "src"), { recursive: true, force: true });
    await cp(join(sourceRoot, "src"), join(installRoot, "src"), { recursive: true });
  }
  await mkdir(dirname(binPath), { recursive: true });
  const nodePath = process.execPath;
  await writeFile(binPath, `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(join(installRoot, "src", "main.ts"))} "$@"\n`, { mode: 0o755 });
  if (platform() === "darwin") {
    await installLaunchAgent(userHome, nodePath, installRoot);
  } else {
    const unitPath = join(userHome, ".config", "systemd", "user", "zcode-chatgpt-bridge.service");
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
    systemctl("daemon-reload");
    systemctl("enable", "zcode-chatgpt-bridge.service");
    systemctl("restart", "zcode-chatgpt-bridge.service");
  }

  const oldDesktop = join(userHome, ".local", "share", "applications", "zcode-chatgpt-bridge.desktop");
  try {
    const contents = await readFile(oldDesktop, "utf8");
    if (contents.includes("zcode-chatgpt-bridge")) await rm(oldDesktop);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

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
    serviceControl("start");
    await waitForService();
  }
  const result = await post("/bridge/login", { mode });
  if (result.authUrl) {
    console.log(`Open this URL to sign in:\n${result.authUrl}`);
    const child = spawn(platform() === "darwin" ? "open" : "xdg-open", [result.authUrl], { detached: true, stdio: "ignore" });
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

const launchAgentLabel = "com.frank0415.zcode-chatgpt-bridge";

function serviceControl(command: "start" | "stop" | "restart"): void {
  if (platform() !== "darwin") {
    systemctl(command);
    return;
  }
  const userHome = homedir();
  const plistPath = join(userHome, "Library", "LaunchAgents", `${launchAgentLabel}.plist`);
  const target = `gui/${process.getuid?.()}/${launchAgentLabel}`;
  const loaded = spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status === 0;
  if (command === "stop" && loaded) {
    launchctl("bootout", target);
  }
  if (command === "start" || command === "restart") {
    if (loaded) launchctl("kickstart", "-k", target);
    else launchctlBootstrap(`gui/${process.getuid?.()}`, plistPath);
  }
}

async function installLaunchAgent(userHome: string, nodePath: string, installRoot: string): Promise<void> {
  const agentsPath = join(userHome, "Library", "LaunchAgents");
  const plistPath = join(agentsPath, `${launchAgentLabel}.plist`);
  const serviceLogPath = logPath(userHome);
  const target = `gui/${process.getuid?.()}/${launchAgentLabel}`;
  const codexPath = commandPath("codex");
  await mkdir(agentsPath, { recursive: true });
  await mkdir(dirname(serviceLogPath), { recursive: true });
  await writeFile(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${launchAgentLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(join(installRoot, "src", "main.ts"))}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")}</string>
    ${codexPath ? `<key>CODEX_BIN</key>\n    <string>${xmlEscape(codexPath)}</string>` : ""}
    <key>BRIDGE_MODEL_CONTEXT_WINDOW</key>
    <string>1050000</string>
    <key>BRIDGE_AUTO_COMPACT_TOKEN_LIMIT</key>
    <string>900000</string>
    <key>BRIDGE_LOG_LEVEL</key>
    <string>info</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(serviceLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(serviceLogPath)}</string>
</dict>
</plist>
`, { mode: 0o600 });
  if (spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status === 0) {
    launchctl("bootout", target);
  }
  launchctlBootstrap(`gui/${process.getuid?.()}`, plistPath);
}

async function showLogs(args: string[]): Promise<void> {
  const follow = args.includes("--follow") || args.includes("-f");
  const countArgument = args.find((value) => /^\d+$/.test(value));
  const count = countArgument || "200";
  const command = platform() === "darwin" ? "tail" : "journalctl";
  const commandArgs = platform() === "darwin"
    ? ["-n", count, ...(follow ? ["-f"] : []), logPath()]
    : ["--user", "-u", "zcode-chatgpt-bridge.service", "-n", count, ...(follow ? ["-f"] : [])];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 || signal === "SIGINT"
      ? resolve()
      : reject(new Error(`${command} exited (${code ?? signal ?? "unknown"})`)));
  });
}

function logPath(userHome = homedir()): string {
  return platform() === "darwin"
    ? join(userHome, "Library", "Logs", "zcode-chatgpt-bridge.log")
    : "journalctl --user -u zcode-chatgpt-bridge.service";
}

function launchctl(...args: string[]): void {
  const result = spawnSync("launchctl", args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`launchctl ${args.join(" ")} failed`);
}

function launchctlBootstrap(domain: string, plistPath: string): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = spawnSync("launchctl", ["bootstrap", domain, plistPath], { encoding: "utf8" });
    if (result.status === 0) return;
    if (attempt < 9) {
      spawnSync("/bin/sleep", ["0.1"]);
      continue;
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  throw new Error(`launchctl bootstrap ${domain} ${plistPath} failed`);
}

function commandPath(command: string): string | undefined {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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
  models           list models available to this ChatGPT account
  logs [N] [-f]    show the latest structured bridge logs
  log-path         show where bridge logs are stored`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
