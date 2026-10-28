// Benchmark: can the screen pipe (Screen Sharing socket -> WebSocket) carry more than Apple's server ever sends?
// A fake RFB server streams raw 2560x1440 frames (14.7 MB each) as fast as the pipe takes them; a WebSocket client
// counts bytes. Run: bun server/bench/screen-pipe.ts   (no network beyond loopback, no Mac login involved)
import { screenSocket, upgradeScreen } from "../modules/screen";
import type { ScreenData } from "../modules/screen";

const FRAME = 2560 * 1440 * 4, CHUNK = 64 * 1024, SECONDS = 4;
const frame = new Uint8Array(FRAME).fill(7);
const fake = Bun.listen<{ off: number }>({ hostname: "127.0.0.1", port: 0, socket: {
  open(s) { s.data = { off: 0 }; pump(s); },
  drain(s) { pump(s); },
  data() {}, close() {}, error() {},
} });
function pump(s: any) {
  const d = s.data as { off: number };
  for (;;) {
    const chunk = frame.subarray(d.off, Math.min(d.off + CHUNK, FRAME)), n = s.write(chunk);
    if (n < chunk.length) { d.off += n; return; } // socket is full: continue on drain
    d.off = (d.off + n) % FRAME;
  }
}
const cfg = { host: "127.0.0.1", port: fake.port, portFixed: true, idleMinutes: 5, maxMinutes: 30, debug: false };
const server = Bun.serve<ScreenData>({ port: 0, hostname: "127.0.0.1", websocket: screenSocket,
  fetch(req, srv) { return upgradeScreen(req, srv, { actor: "bench", ip: "127.0.0.1", cfg }, true) ?? undefined; } });
let bytes = 0;
const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`, ["binary"]);
ws.binaryType = "arraybuffer";
ws.onmessage = (e) => { bytes += (e.data as ArrayBuffer).byteLength; };
await new Promise((r) => (ws.onopen = r));
await Bun.sleep(SECONDS * 1000);
const mbps = bytes / 1024 / 1024 / SECONDS;
console.log(`pipe carried ${mbps.toFixed(0)} MB/s = ${(mbps * 8).toFixed(0)} Mbit/s = ${(bytes / FRAME / SECONDS).toFixed(1)} raw 2560x1440 frames/s`);
ws.close(); server.stop(true); fake.stop(true); process.exit(0);
