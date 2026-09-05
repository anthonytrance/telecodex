import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  GLM_READER_SCRIPT,
  QWEN_READER_PYTHON,
  QWEN_READER_SCRIPT,
  USAGE_READERS,
  hasUsageReader,
  usageReaderCommandFor,
} from "../src/usage-vendors.js";

describe("usage vendor readers", () => {
  it("registers the QwenCloud Token Plan reader under modelstudio", () => {
    expect(hasUsageReader("modelstudio")).toBe(true);
    expect(USAGE_READERS.modelstudio.cmd).toEqual([
      QWEN_READER_PYTHON,
      QWEN_READER_SCRIPT,
    ]);
  });

  it("registers the Z.AI GLM Coding Plan reader under zai", () => {
    expect(hasUsageReader("zai")).toBe(true);
    expect(USAGE_READERS.zai.label).toBe("Z.AI GLM Coding Plan");
    expect(USAGE_READERS.zai.cmd).toEqual([QWEN_READER_PYTHON, GLM_READER_SCRIPT]);
    expect(GLM_READER_SCRIPT).toBe(join(homedir(), "codetest", "glm_usage.py"));
  });

  it("reports no reader for native vendors", () => {
    for (const vendorId of ["codex", "claude", "anthropic", ""]) {
      expect(hasUsageReader(vendorId)).toBe(false);
      expect(usageReaderCommandFor(vendorId)).toBe("");
    }
  });
});
