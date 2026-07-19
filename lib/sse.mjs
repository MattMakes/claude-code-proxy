/** Server-Sent Events hub: one Set of clients, one serialized frame per
 * broadcast. Dead clients drop on "close" or the first failed write. */

const HEARTBEAT_MS = 25_000; // keep proxies from timing out idle streams

export function createSseHub() {
  const clients = new Set();
  // unref'd so an idle hub never keeps the process (or tests) alive.
  const timer = setInterval(() => {
    for (const res of clients) {
      try { res.write(": ping\n\n"); } catch { clients.delete(res); }
    }
  }, HEARTBEAT_MS);
  timer.unref();

  function handle(res) {
    res.writeHead(200, { "content-type": "text/event-stream",
      "cache-control": "no-store", "connection": "keep-alive" });
    res.write("retry: 3000\n\n");
    clients.add(res);
    res.on("close", () => clients.delete(res));
  }

  function broadcast(obj) {
    const frame = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }

  return { handle, broadcast, size: () => clients.size };
}
