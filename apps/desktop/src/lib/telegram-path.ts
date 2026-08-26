/**
 * Telegram 专用工作区路径判断。
 *
 * Telegram 桥运行在独立的真实工作区(`<agentDir>/workspace/telegram`,
 * canonical 路径由 host 的 `telegram.getConfig` 返回)。Host 在 Windows 上
 * 统一小写化 workspace key,这里做同样的归一化比较,避免大小写不一致导致
 * 派生状态在切换后迟迟不翻转。
 */

function platformIsWindows(): boolean {
  return typeof navigator !== "undefined" && /^win/i.test(navigator.platform);
}

function normalizeTelegramPath(path: string): string {
  return platformIsWindows() ? path.toLowerCase() : path;
}

/** 同路径比较(Windows 忽略大小写);任一为空视为不同路径。 */
export function isSameTelegramPath(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return normalizeTelegramPath(a) === normalizeTelegramPath(b);
}
