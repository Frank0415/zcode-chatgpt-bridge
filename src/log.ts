export type LogLevel = "debug" | "info" | "warn" | "error";

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const configured = (process.env.BRIDGE_LOG_LEVEL || "info").toLowerCase() as LogLevel;
  const threshold = priorities[configured] ?? priorities.info;
  if (priorities[level] < threshold) return;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
    ...normalize(fields),
  };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      ...("code" in error ? { error_code: String(error.code) } : {}),
    };
  }
  return { error_message: String(error) };
}

function normalize(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (value instanceof Error) return [[key, value.message]];
    if (typeof value === "bigint") return [[key, String(value)]];
    return [[key, value]];
  }));
}
