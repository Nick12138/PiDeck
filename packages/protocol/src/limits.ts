/** Maximum number of images accepted by one Agent request. */
export const MAX_AGENT_REQUEST_IMAGES = 4;

/** Maximum decoded-equivalent bytes accepted for one base64 Agent image. */
export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;

/** Maximum number of managed document attachments accepted by one Agent request. */
export const MAX_AGENT_REQUEST_ATTACHMENTS = 4;

/** Maximum bytes accepted for one managed PDF or DOCX attachment. */
export const MAX_AGENT_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Maximum combined bytes of managed documents accepted by one Agent request. */
export const MAX_AGENT_REQUEST_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** UTF-8 bytes in one clipboard text paste before Composer creates a TXT attachment. */
export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 4 * 1024;

/** Maximum UTF-8 bytes accepted by attachment.createText. */
export const MAX_PASTED_TEXT_ATTACHMENT_BYTES = 1024 * 1024;

/** Maximum UTF-8 bytes in one Host-to-Desktop JSONL frame, including newline. */
export const MAX_HOST_JSONL_FRAME_BYTES = 32 * 1024 * 1024;

/** Character limits for one blocking Extension UI request. */
export const MAX_EXTENSION_UI_TITLE_LENGTH = 1_024;
export const MAX_EXTENSION_UI_MESSAGE_LENGTH = 65_536;
export const MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH = 65_536;
export const MAX_EXTENSION_UI_OPTIONS = 1_000;
export const MAX_EXTENSION_UI_OPTION_ID_LENGTH = 1_024;
export const MAX_EXTENSION_UI_OPTION_LABEL_LENGTH = 1_024;
export const MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH = 2_048;
export const MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH = 120;
export const MAX_EXTENSION_UI_CORRELATION_ID_LENGTH = 256;
