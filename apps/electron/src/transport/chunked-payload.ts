import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { ATTACHMENT_INLINE_RPC_LIMIT_BYTES } from '@craft-agent/shared/utils'
import type { RpcClient } from '@craft-agent/server-core/transport'

/**
 * 2MB raw → ~2.7MB after base64 encoding.
 * Larger chunks = fewer round trips while staying under common proxy limits.
 */
export const CHUNK_SIZE = 2 * 1024 * 1024

/** Threshold above which we switch from direct RPC to chunked transfer. */
export const CHUNKED_TRANSFER_THRESHOLD = ATTACHMENT_INLINE_RPC_LIMIT_BYTES

/** Max retries per chunk before giving up. */
const MAX_CHUNK_RETRIES = 3

/** Delay between chunk retries (ms). */
const CHUNK_RETRY_DELAY = 1000

export interface PreparedChunkedPayload {
  bytes: Uint8Array
  checksum: string
  chunkCount: number
}

export function getChunkCount(totalBytes: number): number {
  return Math.ceil(totalBytes / CHUNK_SIZE)
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is not available in this runtime')
  }

  return toHex(await globalThis.crypto.subtle.digest('SHA-256', bytes))
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }

  let binary = ''
  const sliceSize = 0x8000
  for (let i = 0; i < bytes.length; i += sliceSize) {
    const slice = bytes.subarray(i, i + sliceSize)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

export async function prepareChunkedPayload(value: unknown): Promise<PreparedChunkedPayload> {
  const json = JSON.stringify(value)
  const bytes = new TextEncoder().encode(json)
  return {
    bytes,
    checksum: await sha256Hex(bytes),
    chunkCount: getChunkCount(bytes.length),
  }
}

/**
 * Send a large RPC call in chunks over the existing connection.
 */
export async function invokeChunked(
  client: Pick<RpcClient, 'invoke'>,
  channel: string,
  args: any[],
  largeArgIndex: number,
  onProgress?: (sent: number, total: number) => void,
  prepared?: PreparedChunkedPayload,
): Promise<any> {
  const payload = prepared ?? await prepareChunkedPayload(args[largeArgIndex])

  const deferredArgs = [...args]
  deferredArgs[largeArgIndex] = null

  const payloadMB = (payload.bytes.length / (1024 * 1024)).toFixed(1)
  console.log(`[ChunkedRPC] Starting transfer: ${payload.chunkCount} chunks, ${payloadMB}MB, sha256: ${payload.checksum.slice(0, 12)}..., channel: ${channel}`)

  let transferId: string | null = null
  try {
    const startResult = await client.invoke(RPC_CHANNELS.transfer.START, {
      totalBytes: payload.bytes.length,
      chunkCount: payload.chunkCount,
      channel,
      args: deferredArgs,
      largeArgIndex,
      checksum: payload.checksum,
    }) as { transferId: string }

    transferId = startResult.transferId
    console.log(`[ChunkedRPC] Transfer started: ${transferId}`)

    for (let i = 0; i < payload.chunkCount; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, payload.bytes.length)
      const data = bytesToBase64(payload.bytes.subarray(start, end))

      let lastError: Error | null = null
      for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
        try {
          await client.invoke(RPC_CHANNELS.transfer.CHUNK, {
            transferId,
            index: i,
            data,
          })
          lastError = null
          break
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          if (attempt < MAX_CHUNK_RETRIES) {
            console.warn(`[ChunkedRPC] Chunk ${i + 1}/${payload.chunkCount} failed (attempt ${attempt}/${MAX_CHUNK_RETRIES}): ${lastError.message}. Retrying in ${CHUNK_RETRY_DELAY}ms...`)
            await new Promise(r => setTimeout(r, CHUNK_RETRY_DELAY))
          }
        }
      }

      if (lastError) {
        throw new Error(`Chunk ${i + 1}/${payload.chunkCount} failed after ${MAX_CHUNK_RETRIES} attempts: ${lastError.message}`)
      }

      onProgress?.(i + 1, payload.chunkCount)

      if ((i + 1) % 10 === 0 || i === payload.chunkCount - 1) {
        console.log(`[ChunkedRPC] Sent chunk ${i + 1}/${payload.chunkCount}`)
      }
    }

    console.log('[ChunkedRPC] All chunks sent, committing...')
    const result = await client.invoke(RPC_CHANNELS.transfer.COMMIT, { transferId })
    console.log('[ChunkedRPC] Transfer committed successfully')
    transferId = null
    return result
  } catch (error) {
    if (transferId) {
      try {
        await client.invoke(RPC_CHANNELS.transfer.ABORT, { transferId })
      } catch {
        // Best effort cleanup — the server may already have cleaned up.
      }
    }
    throw error
  }
}
