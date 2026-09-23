#!/usr/bin/env node
// Local-only WebSocket -> TCP bridge so the Neon serverless driver can talk to
// a plain Postgres on this machine (tests and the tour check, never production).
// The driver opens ws://127.0.0.1:<port>/v1?address=<host>:<port> and streams
// raw Postgres protocol bytes; this pipes them to that TCP address.
//
//   node scripts/local-db/ws-proxy.mjs [--port 5491]
//
// Only loopback targets are allowed, so it can never reach a remote database.
import net from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");

const argPort = process.argv.indexOf("--port");
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.NEON_LOCAL_PROXY_PORT || 5491);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "/", "http://local");
  const address = url.searchParams.get("address") ?? "localhost:5432";
  const idx = address.lastIndexOf(":");
  const host = address.slice(0, idx);
  const port = Number(address.slice(idx + 1));
  if (!LOOPBACK.has(host)) {
    socket.close(1008, "loopback only");
    return;
  }
  const tcp = net.connect({ host: host === "localhost" ? "127.0.0.1" : host, port });
  tcp.on("data", (chunk) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  });
  tcp.on("close", () => socket.close());
  tcp.on("error", () => socket.close());
  socket.on("message", (data) => tcp.write(data));
  socket.on("close", () => tcp.destroy());
  socket.on("error", () => tcp.destroy());
});
wss.on("listening", () => console.log(`local neon ws proxy on 127.0.0.1:${PORT}`));
