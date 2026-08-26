import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RATE_LIMIT_RULES, MemoryRateLimiter } from '../src/lib/rateLimit.js';

function request(route: string, ip: string, body?: unknown) {
  return { routeOptions: { url: route }, ip, body } as never;
}

function reply() {
  const headers = new Map<string, string>();
  return { header(name: string, value: string) { headers.set(name, value); }, headers };
}

describe('MemoryRateLimiter', () => {
  it('isolates buckets by the configured key', () => {
    const limiter = new MemoryRateLimiter({ '/auth/verify': {
      max: 1,
      windowMs: 60_000,
      key: (req) => `${req.ip}:${(req.body as { address: string }).address}`,
    }});
    limiter.check(request('/auth/verify', '127.0.0.1', { address: 'A' }), reply() as never);
    expect(() => limiter.check(request('/auth/verify', '127.0.0.1', { address: 'A' }), reply() as never)).toThrow();
    expect(() => limiter.check(request('/auth/verify', '127.0.0.1', { address: 'B' }), reply() as never)).not.toThrow();
  });

  it('resets an expired window and emits retry-after when limited', () => {
    vi.useFakeTimers();
    try {
      const limiter = new MemoryRateLimiter({ '/x': { max: 1, windowMs: 1_000 } });
      const firstReply = reply();
      limiter.check(request('/x', '127.0.0.1'), firstReply as never);
      const limitedReply = reply();
      expect(() => limiter.check(request('/x', '127.0.0.1'), limitedReply as never)).toThrow();
      expect(limitedReply.headers.get('retry-after')).toBe('1');
      vi.advanceTimersByTime(1_001);
      expect(() => limiter.check(request('/x', '127.0.0.1'), reply() as never)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates ordinary authenticated writes by credential', () => {
    const rule = DEFAULT_RATE_LIMIT_RULES['/forge'];
    expect(rule).toBeDefined();
    const limiter = new MemoryRateLimiter({ '/forge': { ...rule!, max: 1 } });
    const firstRequest = request('/forge', '127.0.0.1') as unknown as Record<string, unknown>;
    const secondRequest = request('/forge', '127.0.0.1') as unknown as Record<string, unknown>;
    const first = { ...firstRequest, headers: { authorization: 'Bearer session-a' } } as never;
    const second = { ...secondRequest, headers: { authorization: 'Bearer session-b' } } as never;
    limiter.check(first, reply() as never);
    expect(() => limiter.check(first, reply() as never)).toThrow();
    expect(() => limiter.check(second, reply() as never)).not.toThrow();
  });
});
