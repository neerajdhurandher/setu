import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

// A self-signed certificate is used only by this isolated local test fixture.
const directory = mkdtempSync(join(tmpdir(), "setu-public-test-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ],
  { stdio: "ignore" },
);
const app = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: "3201",
    SETU_MODE: "public",
    SETU_PUBLIC_URL: "https://localhost:3443",
    SETU_SESSION_SECRET: "isolated-browser-test-secret-not-for-production",
    SETU_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    SETU_STUN_URLS: "",
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
function headers(request: IncomingMessage) {
  request.headers.host = "localhost:3443";
  request.headers["x-forwarded-host"] = "localhost:3443";
  request.headers["x-forwarded-proto"] = "https";
  request.headers["x-forwarded-for"] = "127.0.0.1";
}
const server = createServer(
  {
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  },
  (request, response) => {
    headers(request);
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: 3201,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      console.error("Test proxy failed:", error.message);
      response.writeHead(502).end();
    });
    request.pipe(upstream);
  },
);
server.on("upgrade", (request, socket, head) => {
  headers(request);
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: 3201,
    path: request.url,
    headers: request.headers,
  });
  upstream.on("upgrade", (reply, connection, upstreamHead) => {
    socket.write(
      `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${Object.entries(
        reply.headers,
      )
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n")}\r\n\r\n`,
    );
    if (head.length) connection.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    connection.on("error", (error) => {
      console.error(error.message);
      socket.destroy();
    });
    socket.on("error", (error) => {
      console.error(error.message);
      connection.destroy();
    });
    connection.pipe(socket).pipe(connection);
  });
  upstream.on("response", (reply) => {
    console.error(`Test upgrade refused: ${reply.statusCode}`);
    socket.destroy();
    reply.resume();
  });
  upstream.on("error", (error) => {
    console.error(error.message);
    socket.destroy();
  });
  upstream.end();
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  app.kill("SIGTERM");
  server.close();
  rmSync(directory, { recursive: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 1000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
app.on("exit", (code) => {
  if (!stopping) {
    console.error(`Test app exited: ${code}`);
    stop();
    process.exitCode = 1;
  }
});
async function start() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch("http://127.0.0.1:3201/healthz")).ok) {
        server.listen(3443, "127.0.0.1");
        return;
      }
    } catch (error) {
      if (attempt === 119) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Public test app did not become healthy.");
}
void start().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
  stop();
});
