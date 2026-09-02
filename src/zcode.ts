import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const gpt56ReasoningVariants = ["low", "medium", "high", "xhigh", "max"] as const;

export type ZCodeReasoningUpdate = {
  changed: boolean;
  configPath: string;
  models: string[];
};

export type ZCodeAgentUpdate = {
  changed: boolean;
  agentPath: string;
  conflict: boolean;
};

const managedAgentMarker = "<!-- Managed by zcode-chatgpt-bridge. -->";
const lunaMaxAgent = `---
name: chatgpt-bridge-luna-max
description: Use GPT-5.6 Luna with Max reasoning for focused research, implementation, and other bounded delegated tasks.
model: gpt-5.6-luna
thoughtLevel: max
injectAgentsMd: false
---

${managedAgentMarker}

Complete the assigned task directly and return a concise, evidence-backed result to the parent Agent.

Do not spawn another agent. Do not claim a different model or reasoning level. Your model is fixed by this profile.

Your final message is returned automatically. Do not call SendMessage to /root. Only use SendMessage when the parent explicitly supplies a live recipient whose ID starts with agent_.
`;

export async function configureZCodeReasoning(
  configPath = join(homedir(), ".zcode", "v2", "config.json"),
): Promise<ZCodeReasoningUpdate> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return { changed: false, configPath, models: [] };
    throw error;
  }
  const config = JSON.parse(source);
  const updatedModels: string[] = [];
  for (const provider of Object.values(config?.provider || {}) as any[]) {
    if (normalizeUrl(provider?.options?.baseURL) !== "http://127.0.0.1:9099/v1") continue;
    for (const [modelId, model] of Object.entries(provider?.models || {}) as Array<[string, any]>) {
      if (modelId !== "gpt-5.6-sol" && modelId !== "gpt-5.6-luna") continue;
      const existing = model?.reasoning && typeof model.reasoning === "object" ? model.reasoning : {};
      const variants = mergeVariants(existing.variants);
      const reasoning = {
        ...existing,
        enabled: true,
        variants,
        defaultVariant: modelId === "gpt-5.6-luna" ? "max" : "high",
      };
      if (JSON.stringify(model.reasoning) === JSON.stringify(reasoning)) continue;
      model.reasoning = reasoning;
      updatedModels.push(modelId);
    }
  }
  if (!updatedModels.length) return { changed: false, configPath, models: [] };

  const fileMode = (await stat(configPath)).mode & 0o777;
  const temporary = join(dirname(configPath), `.config.json.zcode-chatgpt-bridge-${process.pid}`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: fileMode });
  await rename(temporary, configPath);
  await chmod(configPath, fileMode);
  return { changed: true, configPath, models: [...new Set(updatedModels)] };
}

export async function configureZCodeLunaMaxAgent(
  agentPath = join(homedir(), ".zcode", "agents", "chatgpt-bridge-luna-max.md"),
): Promise<ZCodeAgentUpdate> {
  try {
    const existing = await readFile(agentPath, "utf8");
    if (existing === lunaMaxAgent) {
      await chmod(agentPath, 0o600);
      return { changed: false, agentPath, conflict: false };
    }
    if (!existing.includes(managedAgentMarker)) {
      return { changed: false, agentPath, conflict: true };
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  await mkdir(dirname(agentPath), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(agentPath), `.chatgpt-bridge-luna-max.md.${process.pid}.tmp`);
  await writeFile(temporary, lunaMaxAgent, { mode: 0o600 });
  await rename(temporary, agentPath);
  await chmod(agentPath, 0o600);
  return { changed: true, agentPath, conflict: false };
}

function mergeVariants(value: unknown): string[] {
  const existing = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const normalized = new Set(existing.map((entry) => entry.trim()).filter(Boolean));
  for (const variant of gpt56ReasoningVariants) normalized.add(variant);
  return [...gpt56ReasoningVariants, ...normalized].filter((variant, index, all) => all.indexOf(variant) === index);
}

function normalizeUrl(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}
