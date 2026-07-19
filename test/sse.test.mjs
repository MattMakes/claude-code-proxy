import test from "node:test";
import assert from "node:assert/strict";
import { createSseHub } from "../lib/sse.mjs";

/** Minimal fake response: records headers/chunks, captures "close" listeners. */
function fakeRes() {
  const res = {
    status: 0, headers: null, chunks: [], listeners: {}, broken: false,
    writeHead(code, headers) { res.status = code; res.headers = headers; },
    write(chunk) { if (res.broken) throw new Error("EPIPE"); res.chunks.push(chunk); },
    on(ev, cb) { (res.listeners[ev] ??= []).push(cb); },
    emit(ev) { for (const cb of res.listeners[ev] ?? []) cb(); },
  };
  return res;
}

test("handle registers client and writes SSE headers + retry hint", () => {
  const hub = createSseHub();
  const res = fakeRes();
  hub.handle(res);
  assert.equal(hub.size(), 1);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.chunks[0], "retry: 3000\n\n");
});

test("broadcast writes one data frame to every client", () => {
  const hub = createSseHub();
  const a = fakeRes(), b = fakeRes();
  hub.handle(a); hub.handle(b);
  hub.broadcast({ n: 1 });
  assert.equal(a.chunks.at(-1), 'data: {"n":1}\n\n');
  assert.equal(b.chunks.at(-1), 'data: {"n":1}\n\n');
});

test("client removed on close; broken-write client dropped", () => {
  const hub = createSseHub();
  const gone = fakeRes(), broken = fakeRes(), ok = fakeRes();
  hub.handle(gone); hub.handle(broken); hub.handle(ok);
  gone.emit("close");
  assert.equal(hub.size(), 2);
  broken.broken = true;
  hub.broadcast({ n: 2 });
  assert.equal(hub.size(), 1);
  assert.equal(ok.chunks.at(-1), 'data: {"n":2}\n\n');
});
