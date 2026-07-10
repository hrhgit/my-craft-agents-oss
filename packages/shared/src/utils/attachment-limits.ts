/** Max size for one attachment accepted by UI/server validation. */
export const ATTACHMENT_SINGLE_FILE_LIMIT_BYTES = 50 * 1024 * 1024;

/** Max combined size of all attachments attached to one user message. */
export const ATTACHMENT_MESSAGE_TOTAL_LIMIT_BYTES = 100 * 1024 * 1024;

/** Max raw JSON payload size before switching to chunked RPC transfer. */
export const ATTACHMENT_INLINE_RPC_LIMIT_BYTES = 5 * 1024 * 1024;

/** Max text file size that can be inlined into an attachment payload. */
export const ATTACHMENT_TEXT_INLINE_LIMIT_BYTES = 2 * 1024 * 1024;
