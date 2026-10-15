/**
 * Anthropic Messages API through the company AI gateway (sub2api), raw fetch (no SDK dependency in the judge layer).
 * The key comes from the caller (stdin), is never logged or written. Same client and price table as the bastion's
 * MCP exam (admin/baolei tools/mcp-exam/runner/model-client.ts), plus an optional unix-socket transport for running
 * inside a network-less sandbox (gate/gateway-proxy.mjs forwards the socket to the gateway). Judge layer.
 */
import http from 'node:http';

/** USD per million tokens (input, output); cache write 1.25x input, cache read 0.1x input */
export const PRICES = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

export function costUsd(model, u) {
  const p = PRICES[model] ?? { input: 2, output: 10 };
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  return (u.input_tokens * p.input + write * p.input * 1.25 + read * p.input * 0.1 + u.output_tokens * p.output) / 1e6;
}

/** POST over a unix socket; returns a fetch-like { status, ok, text(), json() } */
function postUnix(socketPath, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: 'POST', headers: { ...headers, host: 'aigw', 'content-length': Buffer.byteLength(body) }, timeout: 180_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('model request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export class ModelClient {
  /** socketPath: optional unix socket forwarding to the gateway (inside the gate's network-less sandbox) */
  constructor(baseUrl, key, model, socketPath = null) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.key = key;
    this.model = model;
    this.socketPath = socketPath;
  }

  async create(body) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const headers = { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' };
        const payload = JSON.stringify({ model: this.model, ...body });
        const res = this.socketPath
          ? await postUnix(this.socketPath, '/v1/messages', headers, payload)
          : await fetch(`${this.baseUrl}/v1/messages`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(180_000) });
        if (res.status === 429 || res.status >= 500) {
          last = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        return await res.json();
      } catch (error) {
        last = error;
        if (error instanceof Error && /HTTP 4\d\d/.test(error.message) && !/HTTP 429/.test(error.message)) throw error;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}
