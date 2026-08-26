import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Runtime toggle for enabled MCP servers configured in ~/.codex/config.toml.
 * Those servers cold-start
 * on every Codex thread start/resume (measured >15s) and their tool schemas are
 * injected into every turn, so they stay OFF by default and are enabled on
 * demand via /mcp on.
 *
 * When OFF, every codex spawn gets `-c mcp_servers.<name>.enabled=false` for
 * each server not already disabled in config.toml. Names are read from the file
 * at spawn time because disabling a name that is not configured makes Codex
 * fail config loading entirely ("invalid transport").
 */

let mcpEnabled = false;

export function isCodexMcpEnabled(): boolean {
  return mcpEnabled;
}

export function setCodexMcpEnabled(enabled: boolean): void {
  mcpEnabled = enabled;
}

export function codexConfigTomlPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(codexHome, "config.toml");
}

export function listConfiguredCodexMcpServers(): string[] {
  const configPath = codexConfigTomlPath();
  if (!existsSync(configPath)) {
    return [];
  }

  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }

  const enabledByName = new Map<string, boolean>();
  let currentServer: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\[mcp_servers\.(.+)\]\s*(?:#.*)?$/);
    if (match?.[1]) {
      const rawKey = match[1].trim();
      const name = firstKeySegment(rawKey);
      currentServer = name && isBaseServerTable(rawKey) ? name : null;
      if (currentServer && !enabledByName.has(currentServer)) {
        enabledByName.set(currentServer, true);
      }
      continue;
    }
    if (currentServer && /^\s*enabled\s*=\s*false\s*(?:#.*)?$/i.test(line)) {
      enabledByName.set(currentServer, false);
    }
  }
  return [...enabledByName.entries()]
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

/**
 * Extra `codex` CLI args that disable every eligible MCP server. Empty when the
 * toggle is ON (config.toml applies as-is).
 */
export function buildCodexMcpOverrideArgs(): string[] {
  if (mcpEnabled) {
    return [];
  }
  const args: string[] = [];
  for (const name of listConfiguredCodexMcpServers()) {
    args.push("-c", `${mcpOverrideKey(name)}=false`);
  }
  return args;
}

/**
 * Same overrides as dotted config keys for the Codex SDK's `config` option
 * (each entry becomes a `--config key=value` flag).
 */
export function buildCodexMcpOverrideConfig(): Record<string, boolean> {
  if (mcpEnabled) {
    return {};
  }
  const config: Record<string, boolean> = {};
  for (const name of listConfiguredCodexMcpServers()) {
    config[mcpOverrideKey(name)] = false;
  }
  return config;
}

function mcpOverrideKey(name: string): string {
  // Bare keys with hyphens are accepted by codex's override parser; anything
  // beyond [A-Za-z0-9_-] gets TOML double-quoting to survive the dotted path.
  const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : `"${name.replace(/"/g, '\\"')}"`;
  return `mcp_servers.${key}.enabled`;
}

/** First dotted-key segment of a TOML table header, respecting quoted names. */
function firstKeySegment(raw: string): string | null {
  if (!raw) {
    return null;
  }
  const quote = raw[0];
  if (quote === "'" || quote === '"') {
    const end = raw.indexOf(quote, 1);
    return end > 1 ? raw.slice(1, end) : null;
  }
  const dot = raw.indexOf(".");
  const name = (dot === -1 ? raw : raw.slice(0, dot)).trim();
  return name || null;
}

function isBaseServerTable(raw: string): boolean {
  const quote = raw[0];
  if (quote === "'" || quote === '"') {
    const end = raw.indexOf(quote, 1);
    return end > 1 && raw.slice(end + 1).trim() === "";
  }
  return !raw.includes(".");
}
