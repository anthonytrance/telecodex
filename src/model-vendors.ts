/**
 * Model vendor registry.
 *
 * A "vendor" here is the endpoint a model is served from, not the agent CLI.
 * TeleCode already uses "provider" for Claude vs Codex (see AgentProviderKind and
 * src/providers/), so that word is deliberately not reused. Vendors are selected
 * implicitly by naming a model: `/model qwen3.8-max` picks both the model and the
 * endpoint that serves it. No second command, no second concept to remember.
 *
 * Models that are not registered here keep today's behaviour untouched: Codex talks
 * to its own backend, Claude talks to the Anthropic subscription.
 *
 * A vendor is inert until a credential exists for it. Without one, resolution still
 * succeeds but `isAvailable` is false, so the command layer can explain the gap
 * instead of launching a session that would fail on the first request.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where per-vendor API keys live, as a flat { vendorId: key } JSON object. */
export const VENDOR_CREDENTIALS_FILENAME = "model_vendor_credentials.json";

export interface ModelVendor {
  id: string;
  label: string;
  /** Env var carrying this vendor's key, read before the credentials file. */
  apiKeyEnv: string;
  /**
   * Codex side. `codexProviderId` must match a [model_providers.<id>] table in
   * ~/.codex/config.toml. `codexConfig` is merged into the Codex client config,
   * which the SDK flattens into `--config key=value` overrides.
   */
  codex?: {
    providerId: string;
    config?: Record<string, string>;
  };
  /**
   * Claude side. `baseUrl` and the model pins go into the --settings overlay;
   * the key goes into the child environment as ANTHROPIC_AUTH_TOKEN.
   */
  claude?: {
    baseUrl: string;
    /**
     * Model to pin into the Haiku slot. Claude Code reaches for Haiku on cheap
     * background work, so on a metered plan that should be the cheap model
     * rather than whichever model the session is nominally running.
     */
    haikuModel?: string;
    /** Extra settings-file env entries, applied on top of the model pins. */
    env?: Record<string, string>;
  };
}

export interface VendorModel {
  slug: string;
  vendorId: string;
  aliases: string[];
  /** Only set when the vendor documents it. Drives CLAUDE_CODE_MAX_CONTEXT_TOKENS. */
  contextWindow?: number;
  /** False when this model cannot be driven by that agent CLI at all. */
  codex: boolean;
  claude: boolean;
}

const VENDORS: ModelVendor[] = [
  {
    id: "modelstudio",
    // QwenCloud Token Plan (Personal Edition). Its host is neither the
    // pay-as-you-go dashscope-intl host nor the Coding Plan coding-intl host:
    // an sk-sp- Token Plan key is rejected by both (verified 2026-08-07).
    label: "QwenCloud Token Plan",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    codex: {
      providerId: "modelstudio",
      config: {
        // Confines the replacement catalog to sessions that actually use this
        // vendor. model_catalog_json REPLACES the built-in catalog rather than
        // merging with it, so it must never become a global setting.
        model_catalog_json: join(homedir(), ".codex", "model-catalog.qwen.json"),
      },
    },
    claude: {
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      haikuModel: "qwen3.6-flash",
    },
  },
];

/**
 * Registered from the plan's own /compatible-mode/v1/models response
 * (verified 2026-08-07). The image and audio models it also lists are omitted:
 * neither agent CLI can drive them.
 */
const VENDOR_MODELS: VendorModel[] = [
  {
    slug: "qwen3.8-max",
    vendorId: "modelstudio",
    aliases: ["qwen", "qwenmax", "qwen38", "qwen38max", "qwen3.8max"],
    contextWindow: 1_000_000,
    codex: true,
    claude: true,
  },
  {
    slug: "qwen3.7-max",
    vendorId: "modelstudio",
    aliases: ["qwen37max", "qwen3.7max"],
    codex: true,
    claude: true,
  },
  {
    slug: "qwen3.7-plus",
    vendorId: "modelstudio",
    aliases: ["qwenplus", "qwen37plus", "qwen3.7plus"],
    codex: true,
    claude: true,
  },
  {
    slug: "qwen3.6-flash",
    vendorId: "modelstudio",
    aliases: ["qwenflash", "qwen36flash", "qwen3.6flash"],
    codex: true,
    claude: true,
  },
  {
    slug: "glm-5.2",
    vendorId: "modelstudio",
    aliases: ["glm", "glm52"],
    codex: true,
    claude: true,
  },
  {
    slug: "deepseek-v4-pro",
    vendorId: "modelstudio",
    aliases: ["deepseek", "deepseekpro"],
    codex: true,
    claude: true,
  },
  {
    slug: "deepseek-v4-flash-0731",
    vendorId: "modelstudio",
    aliases: ["deepseekflash"],
    // The plan's own model table marks this one "Responses API not yet
    // supported", and Codex speaks nothing else since it dropped wire_api="chat".
    codex: false,
    claude: true,
  },
];

export interface ResolvedVendorModel {
  model: VendorModel;
  vendor: ModelVendor;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function listVendorModels(): VendorModel[] {
  return VENDOR_MODELS.map((model) => ({ ...model }));
}

export function getVendor(vendorId: string): ModelVendor | null {
  return VENDORS.find((vendor) => vendor.id === vendorId) ?? null;
}

/** Resolve a slug or alias to its vendor. Returns null for native models. */
export function resolveVendorModel(raw: string): ResolvedVendorModel | null {
  const normalized = normalize(raw);
  if (!normalized) {
    return null;
  }
  const model = VENDOR_MODELS.find(
    (candidate) =>
      normalize(candidate.slug) === normalized ||
      candidate.aliases.some((alias) => normalize(alias) === normalized),
  );
  if (!model) {
    return null;
  }
  const vendor = getVendor(model.vendorId);
  return vendor ? { model, vendor } : null;
}

/** Replace a registered vendor alias with the exact API model slug. */
export function canonicalizeVendorModel(raw: string): string {
  return resolveVendorModel(raw)?.model.slug ?? raw;
}

/**
 * Read a vendor key from the environment, then from the credentials file in the
 * workspace. Returns null when neither exists, which is the normal state for a
 * vendor whose subscription has not been bought yet.
 */
export function resolveVendorApiKey(
  vendor: ModelVendor,
  options: { workspace?: string; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = options.env ?? process.env;
  const fromEnv = env[vendor.apiKeyEnv]?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const workspace = options.workspace ?? process.cwd();
  const path = join(workspace, VENDOR_CREDENTIALS_FILENAME);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const value = parsed[vendor.id];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function isVendorAvailable(
  vendor: ModelVendor,
  options: { workspace?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  return resolveVendorApiKey(vendor, options) !== null;
}

/** Codex client `config` overrides that point a session at this vendor. */
export function buildVendorCodexConfig(resolved: ResolvedVendorModel): Record<string, string> {
  if (!resolved.vendor.codex || !resolved.model.codex) {
    return {};
  }
  return {
    model_provider: resolved.vendor.codex.providerId,
    ...(resolved.vendor.codex.config ?? {}),
  };
}

/** Codex child-process env additions carrying this vendor's key. */
export function buildVendorCodexEnv(
  resolved: ResolvedVendorModel,
  options: { workspace?: string; env?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  const key = resolveVendorApiKey(resolved.vendor, options);
  return key ? { [resolved.vendor.apiKeyEnv]: key } : {};
}

/**
 * The `env` block merged into Claude Code's --settings overlay. Every model slot
 * is pinned because the endpoint has no model catalog to discover from, and
 * because an unpinned subagent would otherwise fall back to an Anthropic slug the
 * vendor does not serve.
 */
export function buildVendorClaudeSettingsEnv(
  resolved: ResolvedVendorModel,
): Record<string, string> {
  const { vendor, model } = resolved;
  if (!vendor.claude || !model.claude) {
    return {};
  }
  return {
    ANTHROPIC_BASE_URL: vendor.claude.baseUrl,
    ANTHROPIC_MODEL: model.slug,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.slug,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.slug,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: vendor.claude.haikuModel ?? model.slug,
    CLAUDE_CODE_SUBAGENT_MODEL: model.slug,
    // Only claimed where the vendor documents it. Claude Code otherwise keeps
    // its 200K default, which every model here comfortably exceeds.
    ...(model.contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.contextWindow) } : {}),
    ...(vendor.claude.env ?? {}),
  };
}

/**
 * Claude child-process env additions. Only the token goes here: buildClaudePtyEnv
 * strips every CLAUDE_CODE_* variable from the inherited environment, so anything
 * in that namespace has to travel through the settings overlay instead.
 */
export function buildVendorClaudeEnv(
  resolved: ResolvedVendorModel,
  options: { workspace?: string; env?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  if (!resolved.vendor.claude || !resolved.model.claude) {
    return {};
  }
  const key = resolveVendorApiKey(resolved.vendor, options);
  return key ? { ANTHROPIC_AUTH_TOKEN: key } : {};
}

/** Human-readable list for /model output, e.g. "qwen3.8-max (Alibaba Cloud Model Studio)". */
export function describeVendorModel(resolved: ResolvedVendorModel): string {
  return `${resolved.model.slug} (${resolved.vendor.label})`;
}
