import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type BridgeRuntimePaths = {
  root: string;
  codexHome: string;
  workspace: string;
};

const isolatedConfig = `# Managed by zcode-chatgpt-bridge. Keep this profile isolated from machine defaults.
cli_auth_credentials_store = "file"

[features]
hooks = false
multi_agent = false
multi_agent_v2 = false

[history]
persistence = "none"
`;

export function bridgeRuntimePaths(
  userHome = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): BridgeRuntimePaths {
  const root = environment.BRIDGE_RUNTIME_ROOT || join(userHome, ".local", "share", "zcode-chatgpt-bridge");
  return {
    root,
    codexHome: environment.BRIDGE_CODEX_HOME || join(root, "codex-home"),
    workspace: environment.BRIDGE_CWD || join(root, "workspace"),
  };
}

export async function prepareBridgeRuntime(
  paths = bridgeRuntimePaths(),
  sourceCodexHome = join(homedir(), ".codex"),
): Promise<{ authMigrated: boolean; paths: BridgeRuntimePaths }> {
  if (resolve(paths.codexHome) === resolve(sourceCodexHome)) {
    throw new Error("BRIDGE_CODEX_HOME must not point at the machine's default Codex home");
  }
  if (resolve(paths.codexHome) === resolve(paths.workspace)) {
    throw new Error("Bridge Codex home and workspace must be separate directories");
  }
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 });
  await chmod(paths.codexHome, 0o700);
  await chmod(paths.workspace, 0o700);
  await writeManagedConfig(join(paths.codexHome, "config.toml"));

  const targetAuth = join(paths.codexHome, "auth.json");
  const sourceAuth = join(sourceCodexHome, "auth.json");
  let authMigrated = false;
  try {
    await copyFile(sourceAuth, targetAuth, constants.COPYFILE_EXCL);
    await chmod(targetAuth, 0o600);
    authMigrated = true;
  } catch (error: any) {
    if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
  }

  return { authMigrated, paths };
}

async function writeManagedConfig(path: string): Promise<void> {
  try {
    if (await readFile(path, "utf8") === isolatedConfig) {
      await chmod(path, 0o600);
      return;
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, isolatedConfig, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
