import { useEffect, useRef, useState } from "react";
import {
  Bug,
  FileText,
  FolderSearch,
  PencilLine,
  Plus,
  Puzzle,
  Send,
  Square,
  TestTube,
  X,
} from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  MAX_AGENT_IMAGE_BYTES,
  MAX_AGENT_REQUEST_IMAGES,
  type SerializableImage,
} from "@pideck/protocol";
import { buildAttachedFileBlock } from "./transcript-model";
import { ContextUsageRing, ModelControls } from "./ModelControls";
import { QueuePanel } from "./QueuePanel";
import {
  ExtensionWidgetsPopover,
  ExtensionWidgetsButton,
} from "./ExtensionWidgets";
import { PiMark } from "../../components/PiMark";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { subscribeComposerInsert } from "../../lib/composer-insert";
import { BUILTIN_COMMANDS, matchBuiltinCommand } from "./builtin-commands";
import { abortCompaction, requestCompact } from "./compaction-actions";
import { SessionStatsModal } from "./SessionStatsModal";
import { ForkModal } from "./ForkModal";
import { requestTreePanel } from "../../lib/dock-tree";
import { requestExport } from "../../lib/export-actions";
import { useImeComposition } from "../../lib/use-ime-composition";
import { useLocale, useT, type Translate } from "../../lib/i18n/use-t";

const MAX_FILES = 4;
const MAX_FILE_BYTES = 256 * 1024;

const STARTER_PROMPTS = [
  {
    labelKey: "composerStarterExplore",
    promptKey: "composerStarterExplorePrompt",
    icon: FolderSearch,
  },
  {
    labelKey: "composerStarterIssue",
    promptKey: "composerStarterIssuePrompt",
    icon: Bug,
  },
  {
    labelKey: "composerStarterTests",
    promptKey: "composerStarterTestsPrompt",
    icon: TestTube,
  },
  {
    labelKey: "composerStarterChange",
    promptKey: "composerStarterChangePrompt",
    icon: PencilLine,
  },
] as const;

function ExtensionStatusStrip() {
  const statuses = useAppStore((state) => state.extensionStatuses);
  const entries = Object.entries(statuses);
  if (entries.length === 0) return null;
  return (
    <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[10px] text-muted">
      {entries.map(([key, text]) => (
        <span key={key} className="flex min-w-0 items-center gap-1.5" title={text}>
          <Puzzle size={11} className="shrink-0 text-accent" />
          <span className="max-w-[18rem] truncate">
            {key !== "default" && <span className="mr-1 text-foreground/70">{key}</span>}
            {text}
          </span>
        </span>
      ))}
    </div>
  );
}

type PendingImage = SerializableImage & { id: string };
type PendingFile = { id: string; name: string; size: number; text: string };

function fileToImage(file: File): Promise<PendingImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.slice(result.indexOf(",") + 1);
      if (!base64) return resolve(null);
      resolve({
        id: crypto.randomUUID(),
        mediaType: file.type,
        data: base64,
      });
    };
    reader.readAsDataURL(file);
  });
}

/** UTF-8 decoded content that still contains NULs or a high density of
 * replacement chars is binary, not text. */
function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  let bad = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) bad += 1;
  }
  return text.length > 0 && bad / text.length > 0.02;
}

type CompletionItem = { insert: string; label: string; detail?: string };

function builtinCompletionItems(t: Translate): CompletionItem[] {
  const descriptions = {
    compact: "composerBuiltinCompact",
    session: "composerBuiltinSession",
    tree: "composerBuiltinTree",
    fork: "composerBuiltinFork",
    export: "composerBuiltinExport",
  } as const;
  return BUILTIN_COMMANDS.map((command) => ({
    insert: `/${command.name} `,
    label: `/${command.name}`,
    detail: [
      command.name === "compact"
        ? t("composerBuiltinInstructionsHint")
        : command.argumentHint,
      t(descriptions[command.name as keyof typeof descriptions]),
      `(${t("composerCommandKindBuiltin")})`,
    ]
      .filter(Boolean)
      .join(" — "),
  }));
}
type CompletionState = {
  kind: "command" | "file";
  /** Index in the draft where the trigger token (incl. `/` or `@`) starts. */
  tokenStart: number;
  query: string;
  items: CompletionItem[];
  selected: number;
};

/** `/name` at the very start of the draft, token touching the caret. */
export function commandTokenAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /^\/([\w:-]*)$/.exec(before);
  return match ? { start: 0, query: match[1] } : null;
}

/** `@token` preceded by whitespace/start, token touching the caret. */
export function fileTokenAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

/** LiveAgent-style rank: filename prefix < path prefix < filename substring
 * < rest, then shallower, then dirs before files. */
export function fileSortKey(
  entry: { path: string; kind: "file" | "dir" },
  query: string,
): [number, number, number] {
  const path = entry.path.toLocaleLowerCase();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const rank = !query
    ? 3
    : name.startsWith(query)
      ? 0
      : path.startsWith(query)
        ? 1
        : name.includes(query)
          ? 2
          : 3;
  return [rank, entry.path.split("/").length, entry.kind === "dir" ? 0 : 1];
}

export function Composer({
  disabled,
  welcomeWorkspaceName,
}: {
  disabled?: boolean;
  welcomeWorkspaceName?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const text = useAppStore((s) =>
    session ? (s.sessionDrafts[session.sessionId] ?? "") : "",
  );
  const extensionWidgetsOpen = useAppStore((s) => s.extensionWidgetsOpen);
  const setExtensionWidgetsOpen = useAppStore((s) => s.setExtensionWidgetsOpen);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const setSessionDraft = useAppStore((s) => s.setSessionDraft);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const extensionWidgetAnchorRef = useRef<HTMLDivElement>(null);
  const templatesRef = useRef<{ key: string; items: CompletionItem[] } | null>(null);
  const fileSnapshotRef = useRef<{
    query: string;
    entries: { path: string; kind: "file" | "dir" }[];
    truncated: boolean;
  } | null>(null);
  const fileSearchSeq = useRef(0);
  const ime = useImeComposition();
  const busy = session ? !session.isIdle : false;
  const sessionId = session?.sessionId ?? null;

  useEffect(
    () =>
      subscribeComposerInsert((insert) => {
        const current = useAppStore.getState();
        const target = current.session;
        if (!target) return false;
        const draft = current.sessionDrafts[target.sessionId] ?? "";
        const textarea = textareaRef.current;
        const start = textarea?.selectionStart ?? draft.length;
        const end = textarea?.selectionEnd ?? start;
        const before = draft.slice(0, start);
        const after = draft.slice(end);
        const prefix = before && !/\s$/.test(before) ? " " : "";
        const suffix = after && !/^\s/.test(after) ? " " : "";
        const inserted = `${prefix}${insert}${suffix}`;
        const next = before + inserted + after;
        current.setSessionDraft(target.sessionId, next);
        const caret = before.length + inserted.length;
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(caret, caret);
        });
        return true;
      }),
    [],
  );

  // Attachments are per-conversation; drop them when the session changes.
  useEffect(() => {
    setImages([]);
    setFiles([]);
    setDragOver(false);
    setCompletion(null);
    setStatsOpen(false);
    setForkOpen(false);
    fileSnapshotRef.current = null;
  }, [sessionId]);

  function closeExtensionWidgets() {
    setExtensionWidgetsOpen(false);
  }

  function toggleExtensionWidgets() {
    setExtensionWidgetsOpen(!extensionWidgetsOpen);
  }

  async function loadCommandItems(): Promise<CompletionItem[]> {
    if (!host || !workspace || !session) return [];
    const key = `${locale}:${session.sessionId}:${session.revision}`;
    if (templatesRef.current?.key === key) return templatesRef.current.items;
    const res = await hostClient.request(
      "session.getCommands",
      activeSessionContext(host, workspace, session),
      null,
    );
    const builtins = builtinCompletionItems(t);
    if (!res.ok) return builtins;
    const kindLabel = {
      template: t("composerCommandKindPrompt"),
      command: t("composerCommandKindExtension"),
      skill: t("composerCommandKindSkill"),
    } as const;
    const items = [
      ...res.result.commands.map((command) => ({
        insert: `/${command.invocation} `,
        label: `/${command.invocation}`,
        detail: [command.argumentHint, command.description, `(${kindLabel[command.kind]})`]
          .filter(Boolean)
          .join(" — "),
      })),
      ...builtins,
    ];
    templatesRef.current = { key, items };
    return items;
  }

  function updateCompletion(nextText: string, caret: number) {
    const command = commandTokenAt(nextText, caret);
    if (command) {
      void loadCommandItems().then((all) => {
        const query = command.query.toLocaleLowerCase();
        // Prefix matches rank first, substring matches anywhere follow
        // (so /con still finds fast-context); stable sort keeps the
        // template/command/skill grouping within each rank.
        const items = all
          .map((item) => {
            const name = item.label.toLocaleLowerCase();
            const rank = !query
              ? 0
              : name.startsWith(`/${query}`)
                ? 0
                : name.includes(query)
                  ? 1
                  : 2;
            return { item, rank };
          })
          .filter(({ rank }) => rank < 2)
          .sort((a, b) => a.rank - b.rank)
          .map(({ item }) => item);
        setCompletion(
          items.length > 0
            ? { kind: "command", tokenStart: command.start, query: command.query, items, selected: 0 }
            : null,
        );
      });
      return;
    }
    const file = fileTokenAt(nextText, caret);
    if (file && host && workspace) {
      const seq = ++fileSearchSeq.current;
      const query = file.query.toLocaleLowerCase();

      const applySnapshot = (snapshot: {
        query: string;
        entries: { path: string; kind: "file" | "dir" }[];
        truncated: boolean;
      }) => {
        if (seq !== fileSearchSeq.current) return;
        const matches = snapshot.entries
          .filter((entry) => entry.path.toLocaleLowerCase().includes(query))
          .map((entry) => ({ entry, key: fileSortKey(entry, query) }))
          .sort(
            (a, b) =>
              a.key[0] - b.key[0] ||
              a.key[1] - b.key[1] ||
              a.key[2] - b.key[2] ||
              (a.entry.path < b.entry.path ? -1 : 1),
          )
          .slice(0, 30)
          .map(({ entry }) => ({
            // Files replace the whole @token with the bare path; directories
            // keep the @ so the mention stays active for drilling deeper.
            insert: entry.kind === "dir" ? `@${entry.path}/` : `${entry.path} `,
            label: entry.kind === "dir" ? `${entry.path}/` : entry.path,
          }));
        setCompletion(
          matches.length > 0
            ? { kind: "file", tokenStart: file.start, query: file.query, items: matches, selected: 0 }
            : null,
        );
      };

      // Session snapshot: one host fetch per @-session; keystrokes filter the
      // snapshot client-side. Refetch only when the query stops extending the
      // snapshot's query (or the snapshot was truncated).
      const cached = fileSnapshotRef.current;
      if (cached && !cached.truncated && query.startsWith(cached.query)) {
        applySnapshot(cached);
        return;
      }
      const context = {
        expectedHostInstanceId: host.hostInstanceId,
        expectedWorkspaceId: host.workspaceId,
        expectedWorkspaceRevision: host.workspaceRevision,
      };
      void hostClient
        .request("workspace.searchFiles", context, { query: file.query, limit: 3000 })
        .then((res) => {
          if (!res.ok) return;
          const snapshot = {
            query,
            entries: res.result.files,
            truncated: res.result.truncated,
          };
          fileSnapshotRef.current = snapshot;
          applySnapshot(snapshot);
        })
        .catch(() => undefined);
      return;
    }
    setCompletion(null);
  }

  function acceptCompletion(state: CompletionState, index: number) {
    const item = state.items[index];
    if (!item || !session) return;
    const caret = textareaRef.current?.selectionStart ?? text.length;
    const nextText = text.slice(0, state.tokenStart) + item.insert + text.slice(caret);
    setSessionDraft(session.sessionId, nextText);
    setCompletion(null);
    const nextCaret = state.tokenStart + item.insert.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
    // Accepting a directory keeps the mention open so the user drills deeper.
    if (state.kind === "file" && item.insert.endsWith("/")) {
      updateCompletion(nextText, nextCaret);
    }
  }

  async function addFiles(incoming: Iterable<File>) {
    const imageFiles: File[] = [];
    const textFiles: File[] = [];
    for (const file of incoming) {
      if (file.type.startsWith("image/")) {
        if (file.size > MAX_AGENT_IMAGE_BYTES) {
          pushNotification(
            t("composerImageTooLarge", {
              max: Math.round(MAX_AGENT_IMAGE_BYTES / 1024 / 1024),
            }),
            "warning",
          );
          continue;
        }
        imageFiles.push(file);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        pushNotification(
          t("composerFileTooLarge", {
            name: file.name,
            max: Math.round(MAX_FILE_BYTES / 1024),
          }),
          "warning",
        );
        continue;
      }
      textFiles.push(file);
    }

    if (imageFiles.length > 0) {
      const loaded = (await Promise.all(imageFiles.map(fileToImage))).filter(
        (image): image is PendingImage => image !== null,
      );
      setImages((current) => {
        const next = [...current, ...loaded];
        if (next.length > MAX_AGENT_REQUEST_IMAGES) {
          pushNotification(
            t("composerImageLimit", { max: MAX_AGENT_REQUEST_IMAGES }),
            "warning",
          );
        }
        return next.slice(0, MAX_AGENT_REQUEST_IMAGES);
      });
    }

    if (textFiles.length > 0) {
      const loaded: PendingFile[] = [];
      for (const file of textFiles) {
        try {
          const text = await file.text();
          if (looksBinary(text)) {
            pushNotification(t("composerBinaryUnsupported", { name: file.name }), "warning");
            continue;
          }
          loaded.push({
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            text,
          });
        } catch {
          pushNotification(t("composerReadFileFailed", { name: file.name }), "warning");
        }
      }
      if (loaded.length > 0) {
        setFiles((current) => {
          const next = [...current, ...loaded];
          if (next.length > MAX_FILES) {
            pushNotification(t("composerFileLimit", { max: MAX_FILES }), "warning");
          }
          return next.slice(0, MAX_FILES);
        });
      }
    }
  }

  async function send() {
    if (!host || !workspace || !session || disabled) return;
    if (!text.trim() && images.length === 0 && files.length === 0) return;

    const builtin = matchBuiltinCommand(text);
    if (builtin?.name === "session") {
      setSessionDraft(session.sessionId, "");
      setCompletion(null);
      setStatsOpen(true);
      return;
    }
    if (builtin?.name === "tree") {
      setSessionDraft(session.sessionId, "");
      setCompletion(null);
      requestTreePanel();
      return;
    }
    if (builtin?.name === "fork") {
      setSessionDraft(session.sessionId, "");
      setCompletion(null);
      setForkOpen(true);
      return;
    }
    if (builtin?.name === "export") {
      const arg = builtin.args?.trim().toLowerCase();
      if (arg && arg !== "html" && arg !== "jsonl") {
        pushNotification(t("composerExportUsage"), "error");
        return;
      }
      setSessionDraft(session.sessionId, "");
      setCompletion(null);
      void requestExport(arg === "jsonl" ? "jsonl" : "html");
      return;
    }
    if (builtin?.name === "compact") {
      if (busy) {
        // requestCompact surfaces the busy notification; keep the draft.
        void requestCompact(builtin.args);
        return;
      }
      const targetSessionId = session.sessionId;
      const draftText = text;
      setSessionDraft(targetSessionId, "");
      setCompletion(null);
      if (!(await requestCompact(builtin.args))) {
        setSessionDraft(targetSessionId, draftText);
      }
      return;
    }

    const value = text;
    const sentImages = images;
    const sentFiles = files;
    const targetSessionId = session.sessionId;
    setSessionDraft(targetSessionId, "");
    setImages([]);
    setFiles([]);
    const context = activeSessionContext(host, workspace, session);
    const outgoingText =
      sentFiles.length > 0
        ? [value.trimEnd(), ...sentFiles.map((f) => buildAttachedFileBlock(f.name, f.text))]
            .filter(Boolean)
            .join("\n\n")
        : value;
    const imageParams =
      sentImages.length > 0
        ? { images: sentImages.map(({ mediaType, data }) => ({ mediaType, data })) }
        : {};
    const restoreDraft = () => {
      setSessionDraft(targetSessionId, value);
      setImages(sentImages);
      setFiles(sentFiles);
    };

    try {
      if (busy) {
        // Busy sends append to the waiting queue (follow-up), never run concurrently.
        const res = await hostClient.request("agent.followUp", context, {
          text: outgoingText,
          ...imageParams,
        });
        if (!res.ok) {
          pushNotification(res.error?.message ?? t("composerSendFailed"), "error");
          restoreDraft();
        }
        return;
      }

      const res = await hostClient.request(
        "agent.prompt",
        context,
        { text: outgoingText, ...imageParams },
        null,
      );
      if (!res.ok) {
        pushNotification(res.error?.message ?? t("composerPromptFailed"), "error");
        restoreDraft();
      }
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("composerSendFailed"),
        "error",
      );
      restoreDraft();
    }
  }

  async function abort() {
    if (!host || !workspace || !session) return;
    const generation = captureRequestGeneration(host);
    const res = await hostClient.request(
      "agent.abort",
      activeSessionContext(host, workspace, session),
      null,
    );
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return;
    }
    if (!res.ok) {
      pushNotification(res.error?.message ?? t("composerAbortFailed"), "error");
      return;
    }
    setSession(res.result.session);
    if (res.result.error) {
      pushNotification(res.result.error.message, "error");
    }
  }

  const canSend =
    !disabled && (Boolean(text.trim()) || images.length > 0 || files.length > 0);

  function selectStarterPrompt(prompt: string) {
    if (!session || disabled) return;
    setSessionDraft(session.sessionId, prompt);
    setCompletion(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  return (
    <div
      className={
        welcomeWorkspaceName
          ? "flex min-h-0 flex-1 flex-col justify-center px-5 pb-14 pt-6"
          : "shrink-0 px-5 pb-5 pt-2"
      }
    >
      {welcomeWorkspaceName && (
        <div className="new-conversation-copy mx-auto mb-6 flex max-w-3xl flex-col items-center text-center">
          <PiMark className="mb-4 size-10" />
          <h2 className="max-w-full truncate text-xl font-medium text-foreground">
            {t("composerStartIn", { workspace: welcomeWorkspaceName })}
          </h2>
          <p className="mt-2 text-sm text-muted">{t("composerQuestion")}</p>
        </div>
      )}
      <QueuePanel />
      <div
        ref={extensionWidgetAnchorRef}
        className="relative mx-auto w-full max-w-3xl"
        data-extension-widget-anchor
      >
        <ExtensionStatusStrip />
        <div
          className={`rounded-xl border bg-surface-raised p-2 shadow-sm transition-colors ${
            dragOver ? "border-accent" : "border-border"
          }`}
          onDragOver={(event) => {
            if (disabled) return;
            if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
              event.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            if (disabled) return;
            event.preventDefault();
            setDragOver(false);
            void addFiles(event.dataTransfer.files);
          }}
        >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-1.5">
            {files.map((file) => (
              <div
                key={file.id}
                className="group flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs"
                title={`${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`}
              >
                <FileText size={12} className="shrink-0 text-muted" />
                <span className="max-w-40 truncate">{file.name}</span>
                <button
                  type="button"
                  title={t("composerRemoveFile")}
                  aria-label={t("composerRemoveNamedFile", { name: file.name })}
                  className="text-muted hover:text-danger"
                  onClick={() =>
                    setFiles((current) => current.filter((it) => it.id !== file.id))
                  }
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2 pt-1.5">
            {images.map((image) => (
              <div key={image.id} className="group relative">
                <img
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt={t("transcriptAttachmentAlt")}
                  className="size-16 rounded-md border border-border object-cover"
                />
                <button
                  type="button"
                  title={t("composerRemoveImage")}
                  aria-label={t("composerRemoveImage")}
                  className="absolute -right-1.5 -top-1.5 hidden size-5 items-center justify-center rounded-full border border-border bg-surface-raised text-muted shadow group-hover:flex hover:text-danger"
                  onClick={() =>
                    setImages((current) => current.filter((it) => it.id !== image.id))
                  }
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
          {completion && (
            <div className="absolute bottom-full left-2 z-30 mb-1 max-h-64 w-[420px] max-w-[90%] overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg">
              {completion.items.map((item, index) => (
                <button
                  key={`${item.label}:${index}`}
                  type="button"
                  title={item.detail ? `${item.label}\n${item.detail}` : item.label}
                  ref={(node) => {
                    if (node && index === completion.selected) {
                      node.scrollIntoView({ block: "nearest" });
                    }
                  }}
                  className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs ${
                    index === completion.selected
                      ? "bg-surface-overlay text-foreground"
                      : "text-foreground/85 hover:bg-surface-overlay/60"
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    acceptCompletion(completion, index);
                  }}
                >
                  <span className="shrink-0 font-medium">{item.label}</span>
                  {item.detail && (
                    <span className="min-w-0 truncate text-muted">{item.detail}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="chat-composer-input min-h-[60px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
            placeholder={disabled ? t("composerUnavailable") : t("composerPlaceholder")}
            value={text}
            disabled={disabled}
            onChange={(event) => {
              if (!session) return;
              setSessionDraft(session.sessionId, event.target.value);
              updateCompletion(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              );
            }}
            onBlur={() => setCompletion(null)}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.items]
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (pasted.length > 0) {
                event.preventDefault();
                void addFiles(pasted);
              }
            }}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(event) => {
              if (ime.isImeKey(event)) return;
              if (completion) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  setCompletion((current) =>
                    current
                      ? {
                          ...current,
                          selected:
                            (current.selected + delta + current.items.length) %
                            current.items.length,
                        }
                      : null,
                  );
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  acceptCompletion(completion, completion.selected);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCompletion(null);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
        </div>
        <div className="flex h-8 items-center gap-2 px-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            title={t("composerAttach")}
            aria-label={t("composerAttach")}
            className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
            disabled={
              disabled ||
              (images.length >= MAX_AGENT_REQUEST_IMAGES && files.length >= MAX_FILES)
            }
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus size={16} />
          </button>
          <ModelControls />
          <div className="ml-auto flex items-center gap-1.5">
            <ExtensionWidgetsButton
              open={extensionWidgetsOpen}
              onToggle={toggleExtensionWidgets}
            />
            <ContextUsageRing />
            {busy ? (
              canSend ? (
                <button
                  type="button"
                  title={t("composerQueueMessageShortcut")}
                  aria-label={t("composerQueueMessage")}
                  className="flex size-8 items-center justify-center rounded-md bg-foreground text-surface transition-colors hover:opacity-85"
                  onClick={() => void send()}
                >
                  <Send size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  title={session?.isCompacting ? t("composerStopCompaction") : t("composerStop")}
                  aria-label={session?.isCompacting ? t("composerStopCompaction") : t("composerStop")}
                  className="flex size-8 items-center justify-center rounded-md bg-danger/15 text-danger hover:bg-danger/20"
                  onClick={() =>
                    void (session?.isCompacting ? abortCompaction() : abort())
                  }
                >
                  <Square size={14} fill="currentColor" />
                </button>
              )
            ) : (
              <button
                type="button"
                title={t("composerSend")}
                aria-label={t("composerSend")}
                className="flex size-8 items-center justify-center rounded-md bg-foreground text-surface transition-colors hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
                disabled={!canSend}
                onClick={() => void send()}
              >
                <Send size={15} />
              </button>
            )}
          </div>
          </div>
        </div>
        <ExtensionWidgetsPopover
          anchorRef={extensionWidgetAnchorRef}
          open={extensionWidgetsOpen}
          onClose={closeExtensionWidgets}
        />
        <SessionStatsModal open={statsOpen} onClose={() => setStatsOpen(false)} />
        <ForkModal open={forkOpen} onClose={() => setForkOpen(false)} />
      </div>
      {welcomeWorkspaceName && (
        <div
          className={`mx-auto mt-3 flex min-h-9 w-full max-w-3xl flex-wrap justify-center gap-1.5 ${
            canSend ? "invisible pointer-events-none" : ""
          }`}
          aria-hidden={canSend || undefined}
        >
          {STARTER_PROMPTS.map(({ labelKey, promptKey, icon: Icon }) => {
            const label = t(labelKey);
            const prompt = t(promptKey);
            return (
              <button
                key={labelKey}
                type="button"
                disabled={disabled}
                className="flex h-8 items-center justify-center gap-2 rounded-lg px-3 text-xs text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => selectStarterPrompt(prompt)}
              >
                <Icon size={14} className="shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
