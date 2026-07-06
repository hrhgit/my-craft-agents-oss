/**
 * Chunked RPC — send large payloads over WebSocket in small pieces.
 *
 * Splits a single large RPC argument into base64 chunks (~2.7MB each),
 * sends them via the transfer:start/chunk/commit protocol, and the
 * remote server reassembles and executes the original RPC handler.
 *
 * Each chunk is retried up to 3 times on failure to handle transient
 * connection issues through proxies/tunnels.
 */

import {
  CHUNKED_TRANSFER_THRESHOLD,
  CHUNK_SIZE,
  getChunkCount,
  invokeChunked,
  prepareChunkedPayload,
  type PreparedChunkedPayload,
} from '../transport/chunked-payload'

export {
  CHUNKED_TRANSFER_THRESHOLD,
  CHUNK_SIZE,
  getChunkCount,
  invokeChunked,
  prepareChunkedPayload,
  type PreparedChunkedPayload,
}