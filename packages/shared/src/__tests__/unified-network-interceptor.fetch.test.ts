import { describe, expect, it } from 'bun:test';
import { createCraftFetchInterceptor } from '../unified-network-interceptor.ts';

describe('createCraftFetchInterceptor fetch input handling', () => {
  it('passes through fetch-like inputs without a usable URL instead of crashing', async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const baseFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ input, init });
      return new Response('ok');
    }) as typeof fetch;

    const wrapped = createCraftFetchInterceptor(baseFetch) as unknown as (
      input: unknown,
      init?: RequestInit,
    ) => Promise<Response>;
    const input = { method: 'POST' };

    const response = await wrapped(input, { method: 'POST', body: '{}' });

    expect(await response.text()).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(input);
  });
});
