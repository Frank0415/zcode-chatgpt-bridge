import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureZCodeReasoning, gpt56ReasoningVariants } from "../src/zcode.ts";

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
  for (const id of ["gpt-5.6-sol", "gpt-5.6-luna"]) {
    assert.deepEqual(updated.provider.bridge.models[id].reasoning.variants.slice(0, 5), [...gpt56ReasoningVariants]);
  }
  assert.equal(updated.provider.bridge.models["gpt-5.6-luna"].reasoning.defaultVariant, "high");
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
