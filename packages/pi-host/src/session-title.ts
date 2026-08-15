import {
  completeSimple,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

const DEFAULT_SESSION_TITLE = "新会话";
const DEFAULT_TITLE_EMOJI = "💬";
const MAX_SESSION_TITLE_LENGTH = 28;

/**
 * Topic keyword -> emoji mapping, ordered from most to least specific.
 * Used to pick a topic-relevant emoji when the model omits one, so titles
 * stay varied instead of all defaulting to a single emoji.
 */
const TITLE_EMOJI_BY_KEYWORD: ReadonlyArray<{ pattern: RegExp; emoji: string }> = [
  { pattern: /修复|bug|错误|报错|崩溃|缺陷|fix|error|crash|issue/i, emoji: "🐛" },
  { pattern: /测试|test|用例|验证|spec/i, emoji: "🧪" },
  { pattern: /安全|权限|登录|认证|auth|漏洞|login|security/i, emoji: "🔒" },
  { pattern: /性能|优化|提速|perf|speed|加快/i, emoji: "⚡" },
  { pattern: /重构|refactor|清理|简化|整理|cleanup/i, emoji: "🧹" },
  { pattern: /配置|设置|config|选项|参数/i, emoji: "⚙️" },
  { pattern: /界面|样式|布局|ui|design|皮肤|主题|外观/i, emoji: "🎨" },
  { pattern: /数据库|db|sql|存储|缓存|cache|数据/i, emoji: "🗄️" },
  { pattern: /网络|请求|接口|api|http|服务|server|远程/i, emoji: "🌐" },
  { pattern: /git|提交|commit|分支|branch|合并|merge|仓库/i, emoji: "🌿" },
  { pattern: /构建|编译|打包|发布|部署|build|deploy|release|上线/i, emoji: "🚀" },
  { pattern: /文档|doc|readme|注释|说明/i, emoji: "📝" },
  { pattern: /文件|目录|folder|file|fs|路径/i, emoji: "📁" },
  { pattern: /依赖|安装|install|package|模块|依赖项/i, emoji: "📦" },
  { pattern: /升级|更新|迁移|upgrade|migrate|同步|sync/i, emoji: "🔄" },
  { pattern: /搜索|查找|查询|过滤|filter|search/i, emoji: "🔍" },
  { pattern: /会话|聊天|对话|消息|chat|session/i, emoji: "💬" },
];

function pickEmojiForTitle(value: string): string {
  return TITLE_EMOJI_BY_KEYWORD.find(({ pattern }) => pattern.test(value))?.emoji ??
    DEFAULT_TITLE_EMOJI;
}

type TitleModelRegistry = {
  getApiKeyAndHeaders: (model: Model<Api>) => Promise<
    | {
        ok: true;
        apiKey?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
      }
    | { ok: false; error: string }
  >;
};

type CompleteTitle = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

function truncateTitle(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= MAX_SESSION_TITLE_LENGTH) return value;
  return `${chars.slice(0, MAX_SESSION_TITLE_LENGTH - 1).join("")}…`;
}

function cleanTitle(value: string): string {
  const cleaned = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:session\s+title|title|会话标题|标题)\s*[:：-]\s*/i, "")
    .replace(/^[#>*_`'"“”‘’]+|[#>*_`'"“”‘’]+$/g, "")
    .replace(/[。.!?！？;；:：]+$/u, "")
    .trim();
  const leadingEmoji = /^(\p{Extended_Pictographic})/u.exec(cleaned)?.[1];
  // Keep at most the leading emoji; strip any emoji (and ZWJ sequences)
  // elsewhere so the final title always has exactly one emoji.
  const rest = cleaned
    .slice(leadingEmoji?.length ?? 0)
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\u200D/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return leadingEmoji ? `${leadingEmoji} ${rest}`.trim() : rest;
}

function startsWithEmoji(value: string): boolean {
  return /^\p{Extended_Pictographic}/u.test(value);
}

function ensureLeadingEmoji(value: string): string {
  return startsWithEmoji(value) ? value : `${pickEmojiForTitle(value)} ${value}`;
}

export function sanitizeSessionTitle(
  value: string,
  fallback = DEFAULT_SESSION_TITLE,
): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => cleanTitle(line))
    .find(Boolean);
  return truncateTitle(ensureLeadingEmoji(firstLine || fallback));
}

export function createProvisionalSessionTitle(prompt: string): string {
  const firstSentence = prompt.split(/[\r\n。！？!?]/u).find((part) => part.trim());
  return sanitizeSessionTitle(firstSentence ?? prompt);
}

export function extractLatestAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: unknown;
      content?: unknown;
    };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) continue;
    return message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(
            part &&
              typeof part === "object" &&
              (part as { type?: unknown }).type === "text" &&
              typeof (part as { text?: unknown }).text === "string",
          ),
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

export async function generateRefinedSessionTitle(args: {
  model: Model<Api>;
  modelRegistry: TitleModelRegistry;
  userPrompt: string;
  assistantText: string;
  complete?: CompleteTitle;
}): Promise<string> {
  const auth = await args.modelRegistry.getApiKeyAndHeaders(args.model);
  if (!auth.ok) throw new Error(auth.error);

  const context: Context = {
    systemPrompt: [
      "Create a concise title for this coding-agent conversation.",
      "Use the same language as the user.",
      "Use 4-10 words or 8-20 CJK characters.",
      "Begin with exactly one emoji that matches the topic, and use no other emoji.",
      "Do not use quotes, markdown, labels, or ending punctuation.",
      "Return only the title.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: [
          `User request:\n${args.userPrompt.slice(0, 2_000)}`,
          args.assistantText
            ? `Assistant response:\n${args.assistantText.slice(0, 2_000)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        timestamp: Date.now(),
      },
    ],
  };
  const response = await (args.complete ?? completeSimple)(args.model, context, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    maxTokens: 64,
    reasoning: "minimal",
    timeoutMs: 15_000,
    maxRetries: 0,
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `Title generation ${response.stopReason}`);
  }
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return sanitizeSessionTitle(text, createProvisionalSessionTitle(args.userPrompt));
}
