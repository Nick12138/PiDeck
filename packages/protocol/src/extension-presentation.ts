import type { JsonValue } from "./errors.js";
import type { ExtensionPresentation } from "./types.js";

const AUDIENCES = new Set(["agent", "user"]);
const KINDS = new Set(["activity", "progress", "decision", "result", "warning"]);
const STATUSES = new Set(["pending", "running", "resolved", "cancelled", "expired", "failed"]);
const SEVERITIES = new Set(["neutral", "info", "warning", "danger"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, max: number, required = false): value is string {
  if (typeof value !== "string" || value.length > max) return false;
  return !required || value.trim().length > 0;
}

function isOptionalBoundedString(value: unknown, max: number): value is string | undefined {
  return value === undefined || isBoundedString(value, max);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function isExtensionPresentation(value: unknown): value is ExtensionPresentation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "extensionId",
      "audience",
      "kind",
      "correlationId",
      "sourceLabel",
      "status",
      "severity",
      "groupKey",
      "title",
      "summary",
      "actionRequestId",
      "technicalDetails",
    ])
  ) {
    return false;
  }
  if (
    value.version !== 1 ||
    !isBoundedString(value.extensionId, 128, true) ||
    !AUDIENCES.has(String(value.audience)) ||
    !KINDS.has(String(value.kind)) ||
    !isBoundedString(value.correlationId, 256, true) ||
    !isOptionalBoundedString(value.sourceLabel, 120) ||
    !isOptionalBoundedString(value.groupKey, 256) ||
    !isOptionalBoundedString(value.title, 160) ||
    !isOptionalBoundedString(value.summary, 2_000)
  ) {
    return false;
  }
  if (value.status !== undefined && !STATUSES.has(String(value.status))) return false;
  if (value.severity !== undefined && !SEVERITIES.has(String(value.severity))) return false;
  if (
    value.actionRequestId !== undefined &&
    (!isBoundedString(value.actionRequestId, 64, true) ||
      !UUID_PATTERN.test(value.actionRequestId) ||
      value.audience !== "user" ||
      value.kind !== "decision")
  ) {
    return false;
  }
  return value.technicalDetails === undefined || isJsonValue(value.technicalDetails);
}

export function parseExtensionPresentation(value: unknown): ExtensionPresentation | null {
  return isExtensionPresentation(value) ? value : null;
}
