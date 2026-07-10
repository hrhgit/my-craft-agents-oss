/**
 * Build the client API proxy.
 *
 * Replaces the 329-line preload. The ElectronAPI TypeScript interface still
 * enforces types at compile time — this proxy provides runtime dispatch.
 */

import type { RpcClient } from '@craft-agent/server-core/transport'
import type { ElectronAPI } from '../shared/types'
import {
  CHUNKED_TRANSFER_THRESHOLD,
  invokeChunked,
  prepareChunkedPayload,
} from './chunked-payload'

// ---------------------------------------------------------------------------
// Channel map entry
// ---------------------------------------------------------------------------

export type ChannelMapEntry =
  | { type: 'invoke'; channel: string; transform?: (result: any) => any; largeArgIndex?: number; timeoutMs?: number; serializeByArgIndex?: number }
  | { type: 'listener'; channel: string }

export type ChannelMap = Record<string, ChannelMapEntry>

// ---------------------------------------------------------------------------
// Proxy builder
// ---------------------------------------------------------------------------

export function buildClientApi(
  client: RpcClient,
  channelMap: ChannelMap,
  isChannelAvailable?: (channel: string) => boolean,
): ElectronAPI {
  const api: Record<string, any> = {}
  const nested: Record<string, Record<string, any>> = {}
  const serializedInvokes = new Map<string, Promise<any>>()

  for (const [key, entry] of Object.entries(channelMap)) {
    let fn: (...a: any[]) => any
    if (entry.type === 'listener') {
      fn = (cb: (...args: any[]) => void) => client.on(entry.channel, cb)
    } else {
      const invokeEntry = async (...args: any[]) => {
        const result = await invokeMaybeChunked(client, entry.channel, args, entry.largeArgIndex, entry.timeoutMs)
        return entry.transform ? entry.transform(result) : result
      }
      fn = (...args: any[]) => invokeSerializedIfNeeded(serializedInvokes, entry, args, () => invokeEntry(...args))
    }

    // Dotted keys like "browserPane.create" become nested: api.browserPane.create
    const dotIdx = key.indexOf('.')
    if (dotIdx !== -1) {
      const ns = key.slice(0, dotIdx)
      const method = key.slice(dotIdx + 1)
      if (!nested[ns]) nested[ns] = {}
      nested[ns][method] = fn
    } else {
      api[key] = fn
    }
  }

  // Attach nested namespaces as plain objects
  for (const [ns, methods] of Object.entries(nested)) {
    api[ns] = methods
  }

  // Expose channel availability check for GUI-aware code
  api.isChannelAvailable = isChannelAvailable ?? (() => true)

  return api as ElectronAPI
}

function invokeSerializedIfNeeded(
  queues: Map<string, Promise<any>>,
  entry: Extract<ChannelMapEntry, { type: 'invoke' }>,
  args: any[],
  invoke: () => Promise<any>,
): Promise<any> {
  if (entry.serializeByArgIndex === undefined) {
    return invoke()
  }

  const keyValue = args[entry.serializeByArgIndex]
  const queueKey = `${entry.channel}:${String(keyValue)}`
  const previous = queues.get(queueKey) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(invoke)
  queues.set(queueKey, current)
  void current.finally(() => {
    if (queues.get(queueKey) === current) {
      queues.delete(queueKey)
    }
  }).catch(() => undefined)
  return current
}

async function invokeMaybeChunked(
  client: RpcClient,
  channel: string,
  args: any[],
  largeArgIndex?: number,
  timeoutMs?: number,
): Promise<any> {
  if (largeArgIndex === undefined) {
    if (timeoutMs !== undefined && typeof client.invokeWithOptions === 'function') {
      return client.invokeWithOptions(channel, args, { timeoutMs })
    }
    return client.invoke(channel, ...args)
  }

  const value = args[largeArgIndex]
  if (value === undefined || value === null) {
    if (timeoutMs !== undefined && typeof client.invokeWithOptions === 'function') {
      return client.invokeWithOptions(channel, args, { timeoutMs })
    }
    return client.invoke(channel, ...args)
  }

  const prepared = await prepareChunkedPayload(value)
  if (prepared.bytes.length < CHUNKED_TRANSFER_THRESHOLD) {
    if (timeoutMs !== undefined && typeof client.invokeWithOptions === 'function') {
      return client.invokeWithOptions(channel, args, { timeoutMs })
    }
    return client.invoke(channel, ...args)
  }

  return invokeChunked(client, channel, args, largeArgIndex, undefined, prepared, { finalTimeoutMs: timeoutMs })
}
