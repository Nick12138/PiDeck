import type { JsonValue, SerializableImage } from "@pideck/protocol";
import { useAppStore } from "./stores/app-store";
import { hostClient } from "./bridge/host-client";
import { activeSessionContext } from "./bridge/host-context";
import { localizeHostError } from "./bridge/localize-host-error";
import { tCurrent } from "./i18n/use-t";
import {
  buildAttachedFileBlock,
  parseUserAttachments,
  type TranscriptRow,
} from "../features/chat/transcript-model";

/**
 * Re-send a user message after its answer failed or was aborted. Rebuilds the
 * exact prompt (text, text-file attachments, documents, images) and prompts
 * the active session — so the retry runs against whichever model is currently
 * selected, letting the user switch models before retrying. Returns true when
 * the prompt was accepted; the caller hides the failed bubble on success.
 */
export async function requestRetry(row: TranscriptRow): Promise<boolean> {
  const { host, workspace, session, pushNotification, setAuthBlocked } = useAppStore.getState();
  if (!host || !workspace || !session) return false;
  if (!session.isIdle) {
    pushNotification(tCurrent("notifRetryWait"), "info");
    return false;
  }

  const parsed = parseUserAttachments(row.copyText);
  const outgoingText = parsed.files.reduce(
    (text, file) => `${text}${text ? "\n\n" : ""}${buildAttachedFileBlock(file.name, file.content)}`,
    parsed.text,
  );
  const images: SerializableImage[] = row.blocks.flatMap((block) =>
    block.kind === "image" ? [{ mediaType: block.mimeType, data: block.data }] : [],
  );
  const imageParams = images.length > 0 ? { images } : {};
  const attachmentParams =
    parsed.documents.length > 0
      ? { attachmentIds: parsed.documents.map((document) => document.id) }
      : {};

  const handleFailure = (error: { code: string; message: string; details?: JsonValue } | undefined) => {
    if (error?.code === "AUTH_REQUIRED") {
      const details = error.details;
      setAuthBlocked({
        providerId:
          details && typeof details === "object" && !Array.isArray(details)
            ? typeof details.providerId === "string"
              ? details.providerId
              : null
            : null,
      });
    } else {
      pushNotification(localizeHostError(error, tCurrent), "error");
    }
  };

  try {
    const res = await hostClient.request(
      "agent.prompt",
      activeSessionContext(host, workspace, session),
      { text: outgoingText, ...imageParams, ...attachmentParams },
      null,
    );
    if (!res.ok) {
      handleFailure(res.error);
      return false;
    }
    setAuthBlocked(null);
    return true;
  } catch (error) {
    pushNotification(error instanceof Error ? error.message : tCurrent("composerSendFailed"), "error");
    return false;
  }
}
