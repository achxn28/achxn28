import assert from 'node:assert/strict';
import test from 'node:test';
import { githubRequest } from './update-recent-languages.mjs';

const route = '/users/achxn28/events/public?per_page=100&page=1';
const response = (status = 200, headers = {}) => new Response(
  JSON.stringify(status === 200 ? { ok: true } : { message: 'Request failed' }),
  { status, headers },
);

function fixture(outcomes) {
  const calls = [];
  const delays = [];
  return {
    calls,
    delays,
    fetchImpl: async (...args) => {
      calls.push(args);
      const outcome = outcomes.shift();
      assert.notEqual(outcome, undefined, 'Unexpected additional request');
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    sleepImpl: async (milliseconds) => { delays.push(milliseconds); },
  };
}

test('successful requests preserve authorization and include a timeout signal', async () => {
  const request = fixture([response()]);
  assert.deepEqual(await githubRequest(route, { ...request, token: 'test-token' }), { ok: true });
  assert.equal(request.calls.length, 1);
  assert.deepEqual(request.delays, []);
  const [url, options] = request.calls[0];
  assert.equal(url, `https://api.github.com${route}`);
  assert.equal(options.headers.Authorization, 'Bearer test-token');
  assert.equal(options.headers.Accept, 'application/vnd.github+json');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
});

test('a transient fetch failure retries and returns the successful response', async () => {
  const request = fixture([new TypeError('fetch failed'), response()]);
  assert.deepEqual(await githubRequest(route, request), { ok: true });
  assert.equal(request.calls.length, 2);
  assert.deepEqual(request.delays, [1000]);
});

test('persistent network failures stop after four attempts with route and cause', async () => {
  const failure = new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
  const request = fixture(Array(4).fill(failure));
  await assert.rejects(githubRequest(route, request), (error) => {
    assert.ok(error.message.includes(route));
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(request.calls.length, 4);
  assert.deepEqual(request.delays, [1000, 2000, 4000]);
});

test('a request timeout can recover on the next attempt', async () => {
  const request = fixture([new DOMException('Request timed out', 'TimeoutError'), response()]);
  assert.deepEqual(await githubRequest(route, request), { ok: true });
  assert.equal(request.calls.length, 2);
  assert.deepEqual(request.delays, [1000]);
});

test('server errors and request timeouts retry', async (t) => {
  for (const status of [408, 500, 503]) {
    await t.test(String(status), async () => {
      const request = fixture([response(status), response()]);
      assert.deepEqual(await githubRequest(route, request), { ok: true });
      assert.equal(request.calls.length, 2);
      assert.deepEqual(request.delays, [1000]);
    });
  }
});

test('Retry-After seconds override the exponential delay', async () => {
  const request = fixture([response(429, { 'Retry-After': '2' }), response()]);
  assert.deepEqual(await githubRequest(route, request), { ok: true });
  assert.equal(request.calls.length, 2);
  assert.deepEqual(request.delays, [2000]);
});

test('Retry-After HTTP dates are respected', async (t) => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const request = fixture([
    response(429, { 'Retry-After': new Date(now + 5000).toUTCString() }),
    response(),
  ]);
  assert.deepEqual(await githubRequest(route, request), { ok: true });
  assert.deepEqual(request.delays, [5000]);
});

test('long rate-limit waits fail immediately with their status', async () => {
  const request = fixture([response(429, { 'Retry-After': '61' })]);
  await assert.rejects(githubRequest(route, request), (error) => error.status === 429);
  assert.equal(request.calls.length, 1);
  assert.deepEqual(request.delays, []);
});

test('authentication and missing-resource errors are not retried', async (t) => {
  for (const status of [401, 403, 404]) {
    await t.test(String(status), async () => {
      const request = fixture([response(status)]);
      await assert.rejects(githubRequest(route, request), (error) => error.status === status);
      assert.equal(request.calls.length, 1);
      assert.deepEqual(request.delays, []);
    });
  }
});

test('a rejected retry delay stops further requests', async () => {
  const request = fixture([new TypeError('fetch failed')]);
  const stopped = new Error('Delay cancelled');
  request.sleepImpl = async () => { throw stopped; };
  await assert.rejects(githubRequest(route, request), stopped);
  assert.equal(request.calls.length, 1);
});

test('repeated rate limits without headers stop before an excessive wait', async () => {
  const request = fixture([response(429), response(429)]);
  await assert.rejects(githubRequest(route, request), (error) => error.status === 429);
  assert.equal(request.calls.length, 2);
  assert.deepEqual(request.delays, [60_000]);
});

test('an exhausted primary rate limit waits until its reset time', async (t) => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const request = fixture([
    response(403, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String((now + 15_000) / 1000) }),
    response(),
  ]);
  assert.deepEqual(await githubRequest(route, request), { ok: true });
  assert.equal(request.calls.length, 2);
  assert.deepEqual(request.delays, [15_000]);
});

test('a distant primary rate-limit reset fails without an early retry', async (t) => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const request = fixture([
    response(403, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String((now + 90_000) / 1000) }),
  ]);
  await assert.rejects(githubRequest(route, request), (error) => error.status === 403);
  assert.equal(request.calls.length, 1);
  assert.deepEqual(request.delays, []);
});

test('a network failure while reading the response body retries', async () => {
  const interrupted = new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('Connection terminated')); },
  }));
  const request = fixture([interrupted, response()]);
  assert.deepEqual(await githubRequest(route, request), { ok: true });
  assert.equal(request.calls.length, 2);
  assert.deepEqual(request.delays, [1000]);
});

test('invalid JSON fails immediately without retrying the request', async () => {
  const request = fixture([new Response('{')]);
  await assert.rejects(githubRequest(route, request), (error) => {
    assert.ok(error.message.includes(route));
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
  assert.equal(request.calls.length, 1);
  assert.deepEqual(request.delays, []);
});
