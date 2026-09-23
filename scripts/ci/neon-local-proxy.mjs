// Local stand-in for Neon's edge so the app's @neondatabase/serverless driver
// can talk to a plain local Postgres (CI and laptop tests only).
//
//   ws://HOST:PORT/v2?address=db:5432  -> raw TCP to Postgres (Pool/Client)
//   POST http://HOST:PORT/sql          -> Neon's HTTP query protocol
//                                         (neon() and poolQueryViaFetch)
//
// Enable in the app with NEON_LOCAL_PROXY=127.0.0.1:4444 (lib/db/local-proxy.ts).
// Never used in production: without that env the driver talks to Neon as usual.
import http from "node:http";
import net from "node:net";

import ws, { WebSocketServer } from "ws";
import { Client, neonConfig } from "@neondatabase/serverless";

const PORT = Number(process.env.NEON_LOCAL_PROXY_PORT ?? 4444);
const SELF = `127.0.0.1:${PORT}`;

neonConfig.webSocketConstructor = ws;
neonConfig.wsProxy = (host, port) => `${SELF}/v2?address=${host}:${port}`;
neonConfig.useSecureWebSocket = false;
neonConfig.pipelineTLS = false;
neonConfig.pipelineConnect = false;

// Hand values back as Postgres text; the driver parses them by dataTypeID.
const rawText = { getTypeParser: () => (v) => v };

function toResult(r) {
  return {
    command: r.command,
    rowCount: r.rowCount,
    fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
    rows: r.rows,
  };
}

async function runSql(req, body) {
  const cs = req.headers["neon-connection-string"];
  if (!cs) throw Object.assign(new Error("missing Neon-Connection-String"), { status: 400 });
  const client = new Client({ connectionString: cs, types: rawText });
  await client.connect();
  try {
    const q = (x) =>
      client.query({ text: x.query, values: x.params ?? [], rowMode: "array", types: rawText });
    if (Array.isArray(body.queries)) {
      const iso = req.headers["neon-batch-isolation-level"];
      const ro = req.headers["neon-batch-read-only"] === "true";
      const isoSql = iso
        ? ` ISOLATION LEVEL ${String(iso).replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()}`
        : "";
      await client.query(`BEGIN${isoSql}${ro ? " READ ONLY" : ""}`);
      try {
        const results = [];
        for (const x of body.queries) results.push(toResult(await q(x)));
        await client.query("COMMIT");
        return { results };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }
    }
    return toResult(await q(body));
  } finally {
    await client.end().catch(() => {});
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/sql")) {
    res.writeHead(404).end();
    return;
  }
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", async () => {
    try {
      const out = await runSql(req, JSON.parse(data));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    } catch (e) {
      const { message, code, detail, hint, position, severity, constraint, table, column, schema } = e;
      res
        .writeHead(e.status ?? 400, { "content-type": "application/json" })
        .end(JSON.stringify({ message, code, detail, hint, position, severity, constraint, table, column, schema }));
    }
  });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (sock, req) => {
  const address = new URL(req.url ?? "/", "http://x").searchParams.get("address") ?? "127.0.0.1:5432";
  const [host, port] = address.split(":");
  const tcp = net.connect(Number(port || 5432), host === "localhost" ? "127.0.0.1" : host);
  const pending = [];
  let open = false;
  tcp.on("connect", () => {
    open = true;
    for (const b of pending) tcp.write(b);
    pending.length = 0;
  });
  sock.on("message", (m) => (open ? tcp.write(m) : pending.push(m)));
  tcp.on("data", (d) => sock.readyState === sock.OPEN && sock.send(d));
  tcp.on("close", () => sock.close());
  tcp.on("error", () => sock.close());
  sock.on("close", () => tcp.destroy());
  sock.on("error", () => tcp.destroy());
});

server.listen(PORT, "127.0.0.1", () => console.log(`neon-local-proxy listening on ${SELF}`));
