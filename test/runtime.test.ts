import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bridgeRuntimePaths, prepareBridgeRuntime } from "../src/runtime.ts";

test("prepares an isolated Codex profile and migrates auth only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-test-"));
  const userHome = join(directory, "home");
  const sourceCodexHome = join(userHome, ".codex");
  await mkdir(sourceCodexHome, { recursive: true });
  await writeFile(join(sourceCodexHome, "auth.json"), "source-auth", { mode: 0o600 });

  const paths = bridgeRuntimePaths(userHome, {});
  const first = await prepareBridgeRuntime(paths, sourceCodexHome);
  assert.equal(first.authMigrated, true);
  assert.equal(await readFile(join(paths.codexHome, "auth.json"), "utf8"), "source-auth");

  const config = await readFile(join(paths.codexHome, "config.toml"), "utf8");
  assert.match(config, /cli_auth_credentials_store = "file"/);
  assert.match(config, /hooks = false/);
  assert.match(config, /multi_agent = false/);
  assert.doesNotMatch(config, /plugin|mcp_server|stop-that-shit/i);
  assert.equal((await stat(paths.codexHome)).mode & 0o777, 0o700);
  assert.equal((await stat(join(paths.codexHome, "auth.json"))).mode & 0o777, 0o600);

  await writeFile(join(paths.codexHome, "auth.json"), "bridge-refreshed-auth", { mode: 0o600 });
  await writeFile(join(sourceCodexHome, "auth.json"), "new-global-auth", { mode: 0o600 });
  await chmod(paths.codexHome, 0o755);
  const second = await prepareBridgeRuntime(paths, sourceCodexHome);
  assert.equal(second.authMigrated, false);
  assert.equal(await readFile(join(paths.codexHome, "auth.json"), "utf8"), "bridge-refreshed-auth");
  assert.equal((await stat(paths.codexHome)).mode & 0o777, 0o700);
});

test("supports explicit bridge runtime overrides without consulting the user profile", () => {
  const paths = bridgeRuntimePaths("/unused", {
    BRIDGE_RUNTIME_ROOT: "/bridge/root",
    BRIDGE_CODEX_HOME: "/bridge/codex",
    BRIDGE_CWD: "/bridge/workspace",
  });
  assert.deepEqual(paths, {
    root: "/bridge/root",
    codexHome: "/bridge/codex",
    workspace: "/bridge/workspace",
  });
});

test("refuses an override that would overwrite the machine Codex profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-guard-test-"));
  const paths = { root: directory, codexHome: join(directory, ".codex"), workspace: join(directory, "workspace") };
  await assert.rejects(prepareBridgeRuntime(paths, paths.codexHome), /must not point at the machine's default Codex home/);
});
