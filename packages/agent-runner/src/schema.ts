import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSummary } from "./types.js";

export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    changed_files: { type: "array", items: { type: "string" } },
    commands_attempted: { type: "array", items: { type: "string" } },
    known_risks: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "changed_files", "commands_attempted", "known_risks"],
  additionalProperties: false,
} as const;

export async function writeAgentOutputSchema(runRoot: string): Promise<string> {
  const target = path.join(runRoot, "codex-output-schema.json");
  await writeFile(target, `${JSON.stringify(AGENT_OUTPUT_SCHEMA, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return target;
}

export function parseAgentSummary(value: unknown): AgentSummary | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.summary !== "string") return null;
  for (const key of ["changed_files", "commands_attempted", "known_risks"] as const) {
    if (!Array.isArray(item[key]) || !item[key].every((entry) => typeof entry === "string")) {
      return null;
    }
  }
  return {
    summary: item.summary,
    changed_files: [...(item.changed_files as string[])],
    commands_attempted: [...(item.commands_attempted as string[])],
    known_risks: [...(item.known_risks as string[])],
  };
}
