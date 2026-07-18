export const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export const LEGACY_CODEX_REASONING_EFFORTS: CodexReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === "string" && CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
}
