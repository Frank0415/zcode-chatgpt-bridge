import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureZCodeLunaMaxAgent,
  configureZCodeReasoning,
  gpt56LunaReasoningVariants,
  gpt56SolReasoningVariants,
} from "../src/zcode.ts";

test("adds Max to matching ZCode bridge models without changing unrelated provider data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-reasoning-test-"));
  const configPath = join(directory, "config.json");
  const config = {
    provider: {
      bridge: {
        name: "ChatGPT Bridge",
        options: { baseURL: "http://127.0.0.1:9099/v1/", apiKey: "preserve-me" },
        models: {
          "gpt-5.6-sol": { reasoning: null, limit: { context: 1_050_000 } },
          "gpt-5.6-luna": { reasoning: { enabled: true, variants: ["high"], defaultVariant: "high", aliases: { extra: "xhigh" } } },
          "gpt-5.5": { reasoning: null },
        },
      },
      unrelated: { options: { baseURL: "https://example.com/v1", apiKey: "untouched" }, models: {} },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });
  const first = await configureZCodeReasoning(configPath);
  assert.equal(first.changed, true);
  assert.deepEqual(new Set(first.models), new Set(["gpt-5.6-sol", "gpt-5.6-luna"]));

  const updated = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(updated.provider.bridge.models["gpt-5.6-sol"].reasoning.variants, [...gpt56SolReasoningVariants]);
  assert.deepEqual(updated.provider.bridge.models["gpt-5.6-luna"].reasoning.variants, [...gpt56LunaReasoningVariants]);
  assert.equal(updated.provider.bridge.models["gpt-5.6-sol"].reasoning.defaultVariant, "high");
  assert.equal(updated.provider.bridge.models["gpt-5.6-luna"].reasoning.defaultVariant, "max");
  assert.deepEqual(updated.provider.bridge.models["gpt-5.6-luna"].reasoning.aliases, { extra: "xhigh" });
  assert.equal(updated.provider.bridge.options.apiKey, "preserve-me");
  assert.equal(updated.provider.unrelated.options.apiKey, "untouched");
  assert.equal(updated.provider.bridge.models["gpt-5.5"].reasoning, null);
  assert.equal((await stat(configPath)).mode & 0o777, 0o640);

  const second = await configureZCodeReasoning(configPath);
  assert.equal(second.changed, false);
});

test("is a no-op when ZCode has no matching bridge provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-reasoning-noop-test-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, '{"provider":{}}\n');
  assert.deepEqual(await configureZCodeReasoning(configPath), { changed: false, configPath, models: [] });
});

test("installs an isolated native ZCode Luna Max subagent idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-agent-test-"));
  const agentPath = join(directory, "agents", "chatgpt-bridge-luna-max.md");
  const first = await configureZCodeLunaMaxAgent(agentPath);
  assert.deepEqual(first, { changed: true, agentPath, conflict: false });

  const contents = await readFile(agentPath, "utf8");
  assert.match(contents, /name: chatgpt-bridge-luna-max/);
  assert.match(contents, /model: gpt-5\.6-luna/);
  assert.match(contents, /thoughtLevel: max/);
  assert.match(contents, /injectAgentsMd: false/);
  assert.match(contents, /Do not call SendMessage to \/root/);
  assert.equal((await stat(agentPath)).mode & 0o777, 0o600);

  assert.deepEqual(await configureZCodeLunaMaxAgent(agentPath), { changed: false, agentPath, conflict: false });
});

test("preserves an unmanaged ZCode subagent file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-agent-conflict-test-"));
  const agentPath = join(directory, "chatgpt-bridge-luna-max.md");
  await writeFile(agentPath, "user-owned\n", { mode: 0o640 });

  assert.deepEqual(await configureZCodeLunaMaxAgent(agentPath), { changed: false, agentPath, conflict: true });
  assert.equal(await readFile(agentPath, "utf8"), "user-owned\n");
  assert.equal((await stat(agentPath)).mode & 0o777, 0o640);
});
