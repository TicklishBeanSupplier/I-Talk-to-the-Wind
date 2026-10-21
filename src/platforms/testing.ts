// A scripted stand-in for the network, used by tests.
import type { FetchFn } from "../runtime/types";
import type { MediaReader } from "./types";

export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
type Route = { method: string; match: RegExp; reply: Reply | ((r: Recorded) => Reply); times?: number };

export class FakeNet {
  readonly calls: Recorded[] = [];
  private routes: Route[] = [];

  on(method: string, match: RegExp, reply: Route["reply"], times?: number): this {
    this.routes.push({ method, match, reply, times });
    return this;
  }

  readonly fetch: FetchFn = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const rec: Recorded = { method, url, headers, body: decodeBody(init.body) };
    this.calls.push(rec);

    const route = this.routes.find((r) => r.method === method && r.match.test(decodeURIComponent(url.href)) && (r.times === undefined || r.times > 0));
    if (!route) return new Response(JSON.stringify({ error: { message: `No fake route for ${method} ${url.href}` } }), { status: 404 });
    if (route.times !== undefined) route.times--;
    const reply = typeof route.reply === "function" ? route.reply(rec) : route.reply;
    const status = reply.status ?? 200;
    const body = status === 204 || status === 308 ? null : JSON.stringify(reply.json ?? {});
    return new Response(body, { status, headers: reply.headers });
  };

  find(method: string, match: RegExp): Recorded[] {
    return this.calls.filter((c) => c.method === method && match.test(decodeURIComponent(c.url.href)));
  }
}

function decodeBody(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return Object.fromEntries(new URLSearchParams(body));
    }
  }
  if (body instanceof FormData) {
    const out: Record<string, unknown> = {};
    body.forEach((v, k) => (out[k] = typeof v === "string" ? v : `<blob ${v.size}>`));
    return out;
  }
  if (body instanceof Uint8Array) return `<bytes ${body.byteLength}>`;
  return body;
}

export const fakeMedia: MediaReader = {
  bytes: async (m) => new Uint8Array(m.sizeBytes),
  chunk: async (_m, _offset, length) => new Uint8Array(length),
  jpeg: async () => new Uint8Array(10),
};
