import { tCurrent } from "./i18n/use-t";

const DEFAULT_MAX_LENGTH = 220;

function firstSentence(value: string): string {
  const sentenceEnd = value.indexOf(". ");
  return sentenceEnd >= 0 ? value.slice(0, sentenceEnd + 1) : value;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

/** Keeps fatal UI text readable while native stderr remains available in the console. */
export function summarizeHostFailure(message: string, maxLength = DEFAULT_MAX_LENGTH): string {
  const exitMatch = message.match(/^Pi Host exited \(([^)]+)\)/);
  const prefix = exitMatch
    ? tCurrent("hostFailureExited", { code: exitMatch[1] })
    : tCurrent("hostFailureFailed");
  const stderrMarker = ". stderr: ";
  const stderr = message.includes(stderrMarker)
    ? message.slice(message.indexOf(stderrMarker) + stderrMarker.length)
    : message;
  let detail = stderr;
  for (const segment of stderr.split(" | ").reverse()) {
    try {
      const record = JSON.parse(segment) as {
        level?: unknown;
        message?: unknown;
        meta?: { error?: unknown };
      };
      if (record.level !== "error") continue;
      detail =
        typeof record.meta?.error === "string"
          ? record.meta.error
          : typeof record.message === "string"
            ? record.message
            : detail;
      break;
    } catch {
      // A stderr segment can be plain text; continue looking for structured error output.
    }
  }
  return truncate(`${prefix}: ${firstSentence(detail.trim())}`, maxLength);
}
