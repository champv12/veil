import path from "node:path";
import type { JsonValue } from "@veil/contracts";

export interface RedactionOptions {
  secrets?: string[];
  paths?: Array<{ path: string; replacement?: string }>;
  sensitiveKeyPattern?: RegExp;
}

const DEFAULT_SENSITIVE_KEY_PATTERN = /(?:secret|token|password|private[_-]?key|credential|authorization)/i;

export function redactText(input: string, options: RedactionOptions = {}): string {
  let output = input;
  for (const secret of options.secrets ?? []) {
    if (secret.length > 0) output = output.replaceAll(secret, "<redacted>");
  }
  const pathRules = [...(options.paths ?? [])].sort((left, right) => right.path.length - left.path.length);
  for (const rule of pathRules) {
    const absolute = path.resolve(rule.path);
    output = output.replaceAll(absolute, rule.replacement ?? "<private-path>");
  }
  return output;
}

export function redactJson(value: JsonValue, options: RedactionOptions = {}): JsonValue {
  if (typeof value === "string") return redactText(value, options);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => redactJson(item, options));
  const sensitivePattern = options.sensitiveKeyPattern ?? DEFAULT_SENSITIVE_KEY_PATTERN;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    matchesSensitiveKey(sensitivePattern, key) ? "<redacted>" : redactJson(item, options),
  ]));
}

function matchesSensitiveKey(pattern: RegExp, key: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(key);
}
