import { parentPort, workerData } from "node:worker_threads";
import { parseAttachment, type AttachmentParseArgs } from "./attachment-parser.js";

if (!parentPort) throw new Error("attachment parser worker requires a parent port");
const port = parentPort;

const args = workerData as Omit<AttachmentParseArgs, "onProgress">;

try {
  const result = await parseAttachment({
    ...args,
    onProgress: (progress) => port.postMessage({ type: "progress", progress }),
  });
  port.postMessage({ type: "result", result });
} catch (error) {
  port.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}
