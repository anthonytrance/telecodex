import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildVendorClaudeEnv,
  buildVendorClaudeSettingsEnv,
  buildVendorCodexConfig,
  buildVendorCodexEnv,
  canonicalizeVendorModel,
  describeVendorModel,
  isVendorAvailable,
  listVendorModels,
  resolveVendorApiKey,
  resolveVendorModel,
  VENDOR_CREDENTIALS_FILENAME,
} from "../src/model-vendors.js";
import { buildClaudePtyEnv } from "../src/providers/claude-pty.js";

function requireResolved(raw: string): NonNullable<ReturnType<typeof resolveVendorModel>> {
  const resolved = resolveVendorModel(raw);
  if (!resolved) {
    throw new Error(`expected ${raw} to resolve to a vendor model`);
  }
  return resolved;
}

function withCredentialsDir(vendorId: string, key: string): string {
  const dir = mkdtempSync(join(tmpdir(), "telecode-vendor-"));
  writeFileSync(join(dir, VENDOR_CREDENTIALS_FILENAME), JSON.stringify({ [vendorId]: key }), "utf8");
  return dir;
}

describe("model vendor resolution", () => {
  it("resolves a vendor model by slug and by every alias", () => {
    for (const name of ["qwen3.8-max", "qwen", "qwenmax", "qwen38", "QWEN38MAX", " Qwen "]) {
      expect(resolveVendorModel(name)?.model.slug).toBe("qwen3.8-max");
    }
  });

  it("canonicalizes vendor aliases before they reach an API request", () => {
    expect(canonicalizeVendorModel("qwen")).toBe("qwen3.8-max");
    expect(canonicalizeVendorModel("qwenmax")).toBe("qwen3.8-max");
    expect(canonicalizeVendorModel("claude-opus-5")).toBe("claude-opus-5");
  });

  it("leaves native models alone so today's behaviour is untouched", () => {
    for (const name of ["gpt-5.6-terra", "opus", "sonnet", "haiku", "default", "", "  "]) {
      expect(resolveVendorModel(name)).toBeNull();
    }
  });

  it("exposes every registered model with a vendor that exists", () => {
    const models = listVendorModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(resolveVendorModel(model.slug)?.vendor.id).toBe(model.vendorId);
    }
  });

  it("describes a model with its vendor label", () => {
    expect(describeVendorModel(requireResolved("qwen"))).toBe(
      "qwen3.8-max (QwenCloud Token Plan)",
    );
  });
});

describe("vendor credentials", () => {
  it("prefers the environment over the credentials file", () => {
    const resolved = requireResolved("qwen");
    const dir = withCredentialsDir(resolved.vendor.id, "from-file");
    try {
      const key = resolveVendorApiKey(resolved.vendor, {
        workspace: dir,
        env: { [resolved.vendor.apiKeyEnv]: "from-env" },
      });
      expect(key).toBe("from-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the credentials file in the workspace", () => {
    const resolved = requireResolved("qwen");
    const dir = withCredentialsDir(resolved.vendor.id, "from-file");
    try {
      expect(resolveVendorApiKey(resolved.vendor, { workspace: dir, env: {} })).toBe("from-file");
      expect(isVendorAvailable(resolved.vendor, { workspace: dir, env: {} })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports unavailable rather than throwing when no credential exists", () => {
    const resolved = requireResolved("qwen");
    const dir = mkdtempSync(join(tmpdir(), "telecode-vendor-empty-"));
    try {
      expect(resolveVendorApiKey(resolved.vendor, { workspace: dir, env: {} })).toBeNull();
      expect(isVendorAvailable(resolved.vendor, { workspace: dir, env: {} })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an unreadable credentials file as no credential", () => {
    const resolved = requireResolved("qwen");
    const dir = mkdtempSync(join(tmpdir(), "telecode-vendor-bad-"));
    writeFileSync(join(dir, VENDOR_CREDENTIALS_FILENAME), "{ not json", "utf8");
    try {
      expect(resolveVendorApiKey(resolved.vendor, { workspace: dir, env: {} })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("codex vendor wiring", () => {
  it("points model_provider at the provider table and keeps the catalog scoped", () => {
    const config = buildVendorCodexConfig(requireResolved("qwen"));
    expect(config.model_provider).toBe("modelstudio");
    // model_catalog_json REPLACES the built-in catalog, so it must only ever be
    // applied to a session that is already on this vendor.
    expect(config.model_catalog_json).toMatch(/model-catalog\.qwen\.json$/);
  });

  it("carries the vendor key under the env var the provider table reads", () => {
    const resolved = requireResolved("qwen");
    const env = buildVendorCodexEnv(resolved, { env: { DASHSCOPE_API_KEY: "sk-test" } });
    expect(env).toEqual({ DASHSCOPE_API_KEY: "sk-test" });
  });

  it("contributes no env at all when the vendor has no credential", () => {
    const dir = mkdtempSync(join(tmpdir(), "telecode-vendor-none-"));
    try {
      expect(buildVendorCodexEnv(requireResolved("qwen"), { workspace: dir, env: {} })).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claude vendor wiring", () => {
  it("pins every model slot so nothing falls back to a slug the vendor cannot serve", () => {
    const env = buildVendorClaudeSettingsEnv(requireResolved("qwen"));
    expect(env.ANTHROPIC_BASE_URL).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    );
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      expect(env[key]).toBe("qwen3.8-max");
    }
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
  });

  it("keeps the Haiku slot on the cheap model, since the plan is metered", () => {
    const env = buildVendorClaudeSettingsEnv(requireResolved("qwen"));
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("qwen3.6-flash");
  });

  it("claims a context window only for the model that documents one", () => {
    const undocumented = buildVendorClaudeSettingsEnv(requireResolved("glm-5.2"));
    expect(undocumented.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(undocumented.ANTHROPIC_MODEL).toBe("glm-5.2");
  });

  it("keeps a model Codex cannot reach out of the Codex config but usable by Claude", () => {
    const flash = requireResolved("deepseek-v4-flash-0731");
    expect(flash.model.codex).toBe(false);
    expect(buildVendorCodexConfig(flash)).toEqual({});
    expect(buildVendorClaudeSettingsEnv(flash).ANTHROPIC_MODEL).toBe("deepseek-v4-flash-0731");
  });

  it("never puts the auth token in the settings overlay", () => {
    const env = buildVendorClaudeSettingsEnv(requireResolved("qwen"));
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("sends only the token through the child environment", () => {
    const env = buildVendorClaudeEnv(requireResolved("qwen"), {
      env: { DASHSCOPE_API_KEY: "sk-test" },
    });
    expect(env).toEqual({ ANTHROPIC_AUTH_TOKEN: "sk-test" });
  });

  it("survives the CLAUDE_CODE_* scrub in the PTY environment", () => {
    const resolved = requireResolved("qwen");
    const built = buildClaudePtyEnv(
      {
        bin: "claude",
        args: [],
        cwd: "C:\\workspace",
        extraEnv: buildVendorClaudeEnv(resolved, { env: { DASHSCOPE_API_KEY: "sk-test" } }),
      },
      { CLAUDE_CODE_SOMETHING: "stripped", PATH: "/usr/bin" },
    );
    expect(built.CLAUDE_CODE_SOMETHING).toBeUndefined();
    expect(built.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(built.PATH).toBe("/usr/bin");
  });
});
