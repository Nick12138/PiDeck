import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertPiPackageTree,
  assertReleaseProductionManifest,
  assertReleaseSdkEvidence,
  loadReleaseSdkEvidence,
} from "./release-sdk-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const resources = join(root, "apps", "desktop", "src-tauri", "resources");
const lock = JSON.parse(
  readFileSync(join(root, "scripts", "release-runtime.lock.json"), "utf8"),
);
const sdkEvidence = loadReleaseSdkEvidence(root, lock);
const stagedHostRoot = join(resources, "pi-host");
const staging = JSON.parse(readFileSync(join(stagedHostRoot, "STAGING.json"), "utf8"));
const stagedManifest = JSON.parse(
  readFileSync(join(stagedHostRoot, "package.json"), "utf8"),
);
const protocolVersion = JSON.parse(
  readFileSync(join(root, "packages/protocol/package.json"), "utf8"),
).version;
assertReleaseSdkEvidence(staging.sdkEvidence, sdkEvidence, "STAGING SDK evidence");
assertReleaseProductionManifest(
  stagedManifest,
  sdkEvidence,
  { "@pideck/protocol": protocolVersion },
  "staged release Host manifest",
);
const nodePath =
  process.env.PIDECK_STAGED_NODE ?? join(resources, "node", "node.exe");
const hostEntry =
  process.env.PIDECK_STAGED_HOST_ENTRY ?? join(resources, "pi-host", "main.js");
const expectedNodeVersion =
  process.env.PIDECK_EXPECT_NODE_VERSION ?? lock.node.version;
const timeoutMs = parseTimeout(process.env.PIDECK_STAGED_SMOKE_TIMEOUT_MS, 180_000);

function parseTimeout(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid PIDECK_STAGED_SMOKE_TIMEOUT_MS: ${value}`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withStderr(message, stderr) {
  const tail = stderr.trim();
  return tail ? `${message}\nstderr tail:\n${tail}` : message;
}

assert(existsSync(nodePath), `Staged Node is missing: ${nodePath}`);
assert(existsSync(hostEntry), `Staged Host entry is missing: ${hostEntry}`);

const tempRoot = mkdtempSync(join(tmpdir(), "pideck-staged-smoke-"));
const agentDir = join(tempRoot, "agent");
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
for (const name of ["auth.json", "models.json", "settings.json"]) {
  writeFileSync(join(agentDir, name), "{}\n", { encoding: "utf8", mode: 0o600 });
}

const child = spawn(nodePath, [hostEntry], {
  cwd: dirname(hostEntry),
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

let stdoutBuffer = "";
let stderrTail = "";
let streamClosedError = null;
const messages = [];
const messageWaiters = [];
const exitPromise = new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

function rejectMessageWaiters(error) {
  streamClosedError = error;
  for (const waiter of messageWaiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function enqueueMessage(message) {
  const waiter = messageWaiters.shift();
  if (!waiter) {
    messages.push(message);
    return;
  }
  clearTimeout(waiter.timer);
  waiter.resolve(message);
}

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let newline;
  while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      enqueueMessage(JSON.parse(line));
    } catch (error) {
      rejectMessageWaiters(
        new Error(`Staged Host emitted invalid JSONL: ${line}`, { cause: error }),
      );
    }
  }
});

child.stderr.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-32_768);
});
child.once("error", (error) => rejectMessageWaiters(error));
child.once("close", (code, signal) => {
  rejectMessageWaiters(
    new Error(withStderr(`Staged Host closed with code=${code} signal=${signal}`, stderrTail)),
  );
});

function nextMessage(deadline) {
  if (messages.length > 0) return Promise.resolve(messages.shift());
  if (streamClosedError) return Promise.reject(streamClosedError);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("Timed out waiting for staged Host output"));
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = messageWaiters.indexOf(waiter);
        if (index >= 0) messageWaiters.splice(index, 1);
        reject(new Error(withStderr("Timed out waiting for staged Host output", stderrTail)));
      }, remaining),
    };
    messageWaiters.push(waiter);
  });
}

async function waitForEvent(event, deadline) {
  while (Date.now() < deadline) {
    const message = await nextMessage(deadline);
    if (message.event === event) return message;
  }
  throw new Error(`Timed out waiting for event ${event}`);
}

async function request(method, context, params, deadline) {
  const id = randomUUID();
  child.stdin.write(`${JSON.stringify({ protocolVersion: 1, id, method, context, params })}\n`);
  while (Date.now() < deadline) {
    const message = await nextMessage(deadline);
    if (message.id === id) return message;
  }
  throw new Error(`Timed out waiting for response ${method}`);
}

async function waitForExit(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Timed out waiting for staged Host exit");
  let timer;
  try {
    return await Promise.race([
      exitPromise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(withStderr("Timed out waiting for staged Host exit", stderrTail))),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let cleanExit = false;
try {
  const deadline = Date.now() + timeoutMs;
  const ready = await waitForEvent("host.ready", deadline);
  const readyStatus = ready.payload;
  const hostInstanceId = ready.hostInstanceId ?? readyStatus?.hostInstanceId;
  assert(typeof hostInstanceId === "string", "host.ready did not include hostInstanceId");
  assert(
    readyStatus?.sdkVersion === sdkEvidence.sdkVersion,
    `Expected SDK ${sdkEvidence.sdkVersion}, got ${readyStatus?.sdkVersion}`,
  );
  assertPiPackageTree(stagedHostRoot, sdkEvidence, "smoke-extracted staged Host tree");
  assert(
    readyStatus?.nodeVersion === `v${expectedNodeVersion}`,
    `Expected Node v${expectedNodeVersion}, got ${readyStatus?.nodeVersion}`,
  );

  const context = { expectedHostInstanceId: hostInstanceId };
  const status = await request("system.getStatus", context, null, deadline);
  assert(status.ok === true, `system.getStatus failed: ${JSON.stringify(status.error)}`);
  assert(status.result?.hostInstanceId === hostInstanceId, "system.getStatus identity mismatch");

  const rehydrate = await request("system.rehydrate", context, null, deadline);
  assert(rehydrate.ok === true, `system.rehydrate failed: ${JSON.stringify(rehydrate.error)}`);
  assert(Number.isSafeInteger(rehydrate.result?.watermark), "rehydrate watermark is missing");
  assert(rehydrate.result?.host?.hostInstanceId === hostInstanceId, "rehydrate identity mismatch");

  const shutdown = await request("system.shutdown", context, null, deadline);
  assert(shutdown.ok === true, `system.shutdown failed: ${JSON.stringify(shutdown.error)}`);
  assert(shutdown.result?.accepted === true, "system.shutdown was not accepted");

  const exited = await waitForExit(deadline);
  assert(exited.code === 0, withStderr(`Staged Host exited with code=${exited.code}`, stderrTail));
  cleanExit = true;
  console.log(
    JSON.stringify({
      status: "ok",
      sdkVersion: readyStatus.sdkVersion,
      nodeVersion: readyStatus.nodeVersion,
      rehydrateWatermark: rehydrate.result.watermark,
      exitCode: exited.code,
    }),
  );
} finally {
  if (!cleanExit) {
    child.kill();
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
