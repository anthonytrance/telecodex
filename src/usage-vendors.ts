/**
 * External subscription usage readers for TeleCode's /usage command.
 *
 * The built-in /usage knows three providers: OpenAI Codex rate-limit
 * headers, Claude's OAuth usage panel, and (via Hermes) OpenRouter. A
 * third-party Token Plan like QwenCloud returns nothing through those, so
 * this module owns a registry that maps a model vendor id to a reader
 * command. When the command for a context is running on a vendor that has a
 * registered reader, /usage shows that service's live usage instead of the
 * dark built-in panels.
 *
 * Extensibility: another subscription is one entry appended to USAGE_READERS
 * keyed by its model-vendor id (see model-vendors.ts VENDORS). Add the vendor
 * there if it doesn't exist yet, drop the reader command here, done.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where per-service reader commands run from (the shared codetest venv). */
export const QWEN_READER_PYTHON = join(
  homedir(),
  "codetest",
  "venv",
  "Scripts",
  "python.exe",
);
export const QWEN_READER_SCRIPT = join(homedir(), "codetest", "qwen_usage.py");
/** Z.AI GLM Coding Plan reader (queries Z.AI's monitor endpoints). */
export const GLM_READER_SCRIPT = join(homedir(), "codetest", "glm_usage.py");

export interface UsageReader {
  /** Human label shown at the top of the report. */
  label: string;
  /** Command list run to fetch the report (stdout is the report). */
  cmd: string[];
  /** Timeout seconds before the reader is killed. */
  timeout: number;
}

/**
 * Registry: model-vendor id -> usage reader. modelstudio is the QwenCloud
 * Token Plan vendor (see model-vendors.ts). Native vendors (codex, claude,
 * anthropic) are intentionally absent — the built-in paths handle them.
 */
export const USAGE_READERS: Record<string, UsageReader> = {
  modelstudio: {
    label: "QwenCloud Token Plan",
    cmd: [QWEN_READER_PYTHON, QWEN_READER_SCRIPT],
    timeout: 60,
  },
  zai: {
    label: "Z.AI GLM Coding Plan",
    cmd: [QWEN_READER_PYTHON, GLM_READER_SCRIPT],
    timeout: 60,
  },
};

/** True when a usage reader exists for this vendor id. */
export function hasUsageReader(vendorId: string): boolean {
  return Boolean(USAGE_READERS[vendorId]);
}

/** Run a reader command and resolve with its trimmed stdout. */
export function readVendorUsage(vendorId: string): Promise<string> {
  const reader = USAGE_READERS[vendorId];
  if (!reader) {
    return Promise.reject(new Error(`No usage reader for vendor '${vendorId}'`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(reader.cmd[0], reader.cmd.slice(1), {
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        // Never let the Hermes/TelCode venv PYTHONPATH leak into the child.
        PYTHONPATH: "",
        VIRTUAL_ENV: "",
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Usage reader for '${vendorId}' timed out after ${reader.timeout}s`,
        ),
      );
    }, reader.timeout * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        const detail = (stderr || stdout || "").trim() || `exit code ${code}`;
        reject(new Error(`Usage reader for '${vendorId}' failed: ${detail}`));
      }
    });
  });
}

/** Read a reader command's path as bare string (for logging/errors), no exec. */
export function usageReaderCommandFor(vendorId: string): string {
  const reader = USAGE_READERS[vendorId];
  return reader ? `${reader.cmd[0]} ${reader.cmd.slice(1).join(" ")}` : "";
}
