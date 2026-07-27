/** Maximum number of images accepted by one Agent request. */
export const MAX_AGENT_REQUEST_IMAGES = 4;

/** Maximum decoded-equivalent bytes accepted for one base64 Agent image. */
export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;

/** Maximum UTF-8 bytes in one Host-to-Desktop JSONL frame, including newline. */
export const MAX_HOST_JSONL_FRAME_BYTES = 32 * 1024 * 1024;
