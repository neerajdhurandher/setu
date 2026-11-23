import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { test } from "node:test";
import { io as connect, type Socket } from "socket.io-client";
import {
  isTrustedProxy,
  loadDeploymentConfig,
  publicClientIP,
  type PublicConfig,
} from "../services/public-config";
import { createPublicSignalingServer } from "../services/public-signaling";
import type { Welcome } from "../lib/protocol";

const env = {
  SETU_MODE: "public",
  SETU_PUBLIC_URL: "https://setu.example",
  SETU_SESSION_SECRET: randomBytes(32).toString("base64url"),
  SETU_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
};
const headers = {
  Host: "setu.example",
  Origin: "https://setu.example",
  "X-Forwarded-Host": "setu.example",
  "X-Forwarded-Proto": "https",
  "X-Forwarded-For": "203.0.113.7",
};

async function fixture(
  overrides: Record<string, string | undefined> = {},
  options: Parameters<typeof createPublicSignalingServer>[2] = {},
) {
  const config = loadDeploymentConfig({ ...env, ...overrides }) as PublicConfig;
  const http = createServer((req, res) => {
    if (!backend.handleRequest(req, res)) res.writeHead(200).end("Application");
  });
  const backend = createPublicSignalingServer(http, config, options);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const clients: Socket[] = [];
  async function request(
    path: string,
    method = "GET",
    body?: string,
    changes: Record<string, string | undefined> = {},
  ) {
    return new Promise<{ status: number; body: string; cookie?: string }>(
      (resolve, reject) => {
        const all: Record<string, string | undefined> = {
          ...headers,
          ...changes,
        };
        for (const name of Object.keys(all))
          if (all[name] === undefined) delete all[name];
        const req = httpRequest(
          `${url}${path}`,
          { method, headers: all },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                body: data,
                cookie: res.headers["set-cookie"]?.[0],
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      },
    );
  }
  async function session(changes: Record<string, string | undefined> = {}) {
    const result = await request("/api/session", "POST", "{}", {
      "Content-Type": "application/json",
      "X-Setu-Request": "1",
      ...changes,
    });
    assert.equal(result.status, 200, result.body);
    assert(result.cookie);
    return result.cookie.split(";")[0];
  }
  function client(
    cookie: string,
    changes: Record<string, string | undefined> = {},
    authChanges: Record<string, unknown> = {},
    transports = ["websocket"],
    pollingPort?: number,
  ) {
    return new Promise<{ socket: Socket; welcome: Welcome }>(
      (resolve, reject) => {
        const socket = connect(url, {
          forceNew: true,
          reconnection: false,
          transports,
          transportOptions: pollingPort
            ? { polling: { hostname: "127.0.0.1", port: pollingPort } }
            : {},
          extraHeaders: Object.fromEntries(
            Object.entries({ ...headers, Cookie: cookie, ...changes }).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          auth: {
            sessionId: randomUUID(),
            name: "Device",
            platform: "desktop",
            os: "Test",
            pin: "",
            ...authChanges,
          },
          timeout: 2000,
        });
        clients.push(socket);
        socket.once("welcome", (welcome: Welcome) =>
          resolve({ socket, welcome }),
        );
        socket.once("connect_error", reject);
      },
    );
  }
  async function close() {
    clients.forEach((c) => c.disconnect());
    await new Promise<void>((resolve) => backend.io.close(() => resolve()));
  }
  return { request, session, client, close, backend, config, url };
}

type Result = {
  ok: boolean;
  error?: string;
  invitation?: string;
  expiresAt?: number;
};
function emit(
  socket: Socket,
  event: string,
  payload?: unknown,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const ack = (error: Error | null, result: Result) =>
      error ? reject(error) : resolve(result);
    if (payload === undefined) socket.timeout(2000).emit(event, ack);
    else socket.timeout(2000).emit(event, payload, ack);
  });
}
function received<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${event}`)), 2000);
    socket.once(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

test("public startup configuration fails closed and defaults to LAN / no STUN", () => {
  assert.deepEqual(loadDeploymentConfig({}), { mode: "lan" });
  assert.deepEqual((loadDeploymentConfig(env) as PublicConfig).iceServers, []);
  assert.deepEqual(
    (
      loadDeploymentConfig({
        ...env,
        SETU_STUN_URLS: "stun:stun.example:3478,stuns:stun.example:5349",
      }) as PublicConfig
    ).iceServers,
    [{ urls: ["stun:stun.example:3478", "stuns:stun.example:5349"] }],
  );
  for (const changes of [
    { SETU_MODE: "other" },
    { SETU_PUBLIC_URL: "" },
    { SETU_PUBLIC_URL: "http://setu.example" },
    { SETU_PUBLIC_URL: "https://setu.example/path" },
    { SETU_PUBLIC_URL: "https://setu.example/" },
    { SETU_PUBLIC_URL: "https://user:password@setu.example" },
    { SETU_SESSION_SECRET: "short" },
    { SETU_SESSION_SECRET: "a".repeat(40) },
    { SETU_TRUSTED_PROXY_CIDRS: "" },
    { SETU_TRUSTED_PROXY_CIDRS: "0.0.0.0/0" },
    { SETU_TRUSTED_PROXY_CIDRS: "172.30.50.2/33" },
    { SETU_STUN_URLS: "turn:turn.example:3478" },
    { SETU_STUN_URLS: "stun:user:secret@stun.example" },
    { SETU_STUN_URLS: "https://stun.example" },
    { SETU_SESSION_TTL_MS: "86400001" },
    { SETU_SOCKET_MAX_BYTES: "65537" },
  ])
    assert.throws(() => loadDeploymentConfig({ ...env, ...changes }));
});

test("trusted proxies match exact peers and IPv4/IPv6 CIDRs, never prefix strings", () => {
  assert(isTrustedProxy("::ffff:172.30.50.2", ["172.30.50.2/32"]));
  assert(!isTrustedProxy("172.30.50.20", ["172.30.50.2/32"]));
  assert(!isTrustedProxy("172.30.50.3", ["172.30.50.2/32"]));
  assert(isTrustedProxy("2001:db8:abcd::2", ["2001:db8:abcd::/48"]));
  assert(!isTrustedProxy("2001:db8:abce::2", ["2001:db8:abcd::/48"]));
  assert(isTrustedProxy("::1", ["::1/128"]));
  assert(!isTrustedProxy("::2", ["::1/128"]));
  assert(!isTrustedProxy("10.0.0.1", ["::/1"]));
  assert(!isTrustedProxy("garbage", ["127.0.0.1/32"]));
});

test("HTTP config/health/session are nonsensitive, strict and bounded", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const config = await f.request("/api/config");
  assert.equal(config.status, 200);
  assert.deepEqual(JSON.parse(config.body), { mode: "public", iceServers: [] });
  assert(!config.body.includes(env.SETU_SESSION_SECRET));
  assert.deepEqual(
    JSON.parse(
      (
        await f.request("/healthz", "GET", undefined, {
          Host: "localhost",
          Origin: undefined,
        })
      ).body,
    ),
    { ok: true },
  );
  assert.equal((await f.request("/api/session", "GET")).status, 405);
  for (const changes of [
    { Origin: "https://evil.example" },
    { Origin: undefined },
    { "X-Setu-Request": undefined },
    { "Content-Type": "text/plain" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) {
    assert.equal(
      (
        await f.request("/api/session", "POST", "{}", {
          "Content-Type": "application/json",
          "X-Setu-Request": "1",
          ...changes,
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await f.request("/api/session", "POST", '{"content":"private"}', {
        "Content-Type": "application/json",
        "X-Setu-Request": "1",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/session", "POST", "x".repeat(1025), {
        "Content-Type": "application/json",
        "X-Setu-Request": "1",
      })
    ).status,
    413,
  );
  const issued = await f.request("/api/session", "POST", "{}", {
    "Content-Type": "application/json",
    "X-Setu-Request": "1",
  });
  assert.equal(issued.status, 200);
  assert.match(issued.cookie!, /__Host-setu-session=/);
  for (const flag of [
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=86400",
  ])
    assert(issued.cookie!.includes(flag));
  const value = JSON.parse(issued.body);
  assert(value.expiresAt <= Date.now() + 86400000);
  assert.deepEqual(Object.keys(value).sort(), ["expiresAt", "ok"]);
  for (let i = 0; i < 15; i++)
    await f.request("/api/session", "POST", "{}", {
      "Content-Type": "application/json",
      "X-Setu-Request": "1",
    });
  assert.equal(
    (
      await f.request("/api/session", "POST", "{}", {
        "Content-Type": "application/json",
        "X-Setu-Request": "1",
      })
    ).status,
    429,
  );
});

test("spoofed proxy, origin, host and forwarded client chains cannot authorize HTTP or sockets", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const cookie = await f.session();
  for (const changes of [
    { Host: "evil.example" },
    { Origin: "https://evil.example" },
    { "X-Forwarded-Host": "evil.example" },
    { "X-Forwarded-Proto": "http" },
    { "X-Forwarded-For": "203.0.113.7, 127.0.0.1" },
    { Forwarded: "for=127.0.0.1;proto=https" },
  ]) {
    assert.equal(
      (await f.request("/api/config", "GET", undefined, changes)).status,
      403,
    );
    await assert.rejects(f.client(cookie, changes));
  }
  assert.equal(
    (
      await f.request("/api/config", "GET", undefined, {
        "X-Forwarded-Host": undefined,
      })
    ).status,
    403,
  );
  const untrusted = await fixture({
    SETU_TRUSTED_PROXY_CIDRS: "172.30.50.2/32",
  });
  t.after(untrusted.close);
  assert.equal((await untrusted.request("/api/config")).status, 403);
  await assert.rejects(untrusted.client(cookie));
  // Test the guard directly using an actual HTTP request to assert duplicate headers fail closed.
  const duplicate = createServer((req, res) => {
    assert.equal(publicClientIP(req, f.config, true), undefined);
    res.end();
  });
  await new Promise<void>((resolve) =>
    duplicate.listen(0, "127.0.0.1", resolve),
  );
  const address = duplicate.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: address.port,
        headers: [
          "Host",
          "setu.example",
          "Origin",
          "https://setu.example",
          "X-Forwarded-Host",
          "setu.example",
          "X-Forwarded-Proto",
          "https",
          "X-Forwarded-For",
          "203.0.113.7",
          "X-Forwarded-For",
          "203.0.113.8",
        ],
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end();
  });
  await new Promise<void>((resolve) => duplicate.close(() => resolve()));
});

test("socket cookie authorization ignores forged browser identities and expires ongoing sockets", async (t) => {
  let time = Date.now();
  const f = await fixture(
    { SETU_SESSION_TTL_MS: "1000" },
    { now: () => time, cleanupIntervalMs: 10 },
  );
  t.after(f.close);
  const cookie = await f.session();
  await assert.rejects(f.client(""));
  await assert.rejects(
    f.client(cookie.slice(0, -1) + (cookie.endsWith("a") ? "b" : "a")),
  );
  await assert.rejects(f.client(cookie, {}, { name: "", platform: "invalid" }));
  const a = await f.client(cookie);
  assert.deepEqual(a.welcome.history, []);
  assert.deepEqual(a.welcome.addresses, []);
  assert.equal(a.welcome.devices.length, 1);
  assert.equal(a.welcome.selfId, a.socket.id);
  const disconnected = received(a.socket, "disconnect");
  time += 1001;
  await disconnected;
  await assert.rejects(f.client(cookie));
});

test("accountless rooms isolate discovery, rename and signaling; leave/close revoke membership", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const cookie = await f.session();
  const a = await f.client(cookie),
    b = await f.client(cookie),
    outsider = await f.client(cookie);
  assert.equal(b.welcome.devices.length, 1);
  let outsiderDevices = 0,
    outsiderSignals = 0;
  outsider.socket.on("devices", () => outsiderDevices++);
  outsider.socket.on("peer:signal", () => outsiderSignals++);
  const created = await emit(a.socket, "room:create");
  assert(created.ok && created.invitation && created.expiresAt);
  assert.match(created.invitation, /^[\w-]{32}$/);
  assert(created.expiresAt > Date.now() + 3590000);
  const devices = received<Welcome["devices"]>(a.socket, "devices");
  assert(
    (await emit(b.socket, "room:join", { invitation: created.invitation })).ok,
  );
  assert.equal((await devices).length, 2);
  const renamed = received<Welcome["devices"]>(a.socket, "devices");
  assert((await emit(b.socket, "rename", "Phone")).ok);
  assert(
    (await renamed).some((d) => d.id === b.socket.id && d.name === "Phone"),
  );
  const incoming = received(a.socket, "peer:signal");
  assert(
    (
      await emit(b.socket, "peer:signal", {
        recipientId: a.socket.id,
        description: { type: "offer", sdp: "v=0\r\n" },
      })
    ).ok,
  );
  assert.deepEqual(await incoming, {
    senderId: b.socket.id,
    description: { type: "offer", sdp: "v=0\r\n" },
  });
  assert.equal(
    (
      await emit(b.socket, "peer:signal", {
        recipientId: outsider.socket.id,
        candidate: { candidate: "" },
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await emit(outsider.socket, "peer:signal", {
        recipientId: a.socket.id,
        candidate: { candidate: "" },
      })
    ).ok,
    false,
  );
  assert.equal((await emit(b.socket, "room:close")).ok, false);
  assert((await emit(b.socket, "room:leave")).ok);
  assert.equal(
    (
      await emit(b.socket, "peer:signal", {
        recipientId: a.socket.id,
        candidate: { candidate: "" },
      })
    ).ok,
    false,
  );
  assert(
    (await emit(b.socket, "room:join", { invitation: created.invitation })).ok,
  );
  const ended = received<{ error: string }>(b.socket, "room:ended");
  assert((await emit(a.socket, "room:close")).ok);
  assert.equal(typeof (await ended).error, "string");
  assert.equal(
    (await emit(b.socket, "room:join", { invitation: created.invitation })).ok,
    false,
  );
  assert.equal(outsiderDevices, 0);
  assert.equal(outsiderSignals, 0);
});

test("rooms expire, reject old invitations and disconnect owner closes membership", async (t) => {
  let time = Date.now();
  const f = await fixture(
    {},
    { now: () => time, roomTtlMs: 1000, cleanupIntervalMs: 10 },
  );
  t.after(f.close);
  const cookie = await f.session();
  const a = await f.client(cookie),
    b = await f.client(cookie);
  const created = await emit(a.socket, "room:create");
  assert(
    (await emit(b.socket, "room:join", { invitation: created.invitation })).ok,
  );
  const ended = received<{ error: string }>(b.socket, "room:ended");
  time += 1001;
  assert.equal((await ended).error, "Room expired.");
  assert.equal(
    (await emit(b.socket, "room:join", { invitation: created.invitation })).ok,
    false,
  );
  assert.equal(
    (
      await emit(b.socket, "peer:signal", {
        recipientId: a.socket.id,
        candidate: { candidate: "" },
      })
    ).ok,
    false,
  );
  const fresh = await emit(a.socket, "room:create");
  assert(
    (await emit(b.socket, "room:join", { invitation: fresh.invitation })).ok,
  );
  const closed = received(b.socket, "room:ended");
  a.socket.disconnect();
  await closed;
});

test("signaling payloads are exact, bounded and never carry legacy content events", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const cookie = await f.session();
  const a = await f.client(cookie),
    b = await f.client(cookie);
  const room = await emit(a.socket, "room:create");
  assert(
    (await emit(b.socket, "room:join", { invitation: room.invitation })).ok,
  );
  let forwarded = 0;
  b.socket.on("peer:signal", () => forwarded++);
  for (const payload of [
    {},
    { recipientId: b.socket.id },
    { recipientId: a.socket.id, candidate: { candidate: "" } },
    { recipientId: "missing", candidate: { candidate: "" } },
    { recipientId: b.socket.id, description: { type: "pranswer", sdp: "v=0" } },
    {
      recipientId: b.socket.id,
      description: { type: "offer", sdp: "x".repeat(32769) },
    },
    {
      recipientId: b.socket.id,
      description: { type: "offer", sdp: "😀".repeat(9000) },
    },
    {
      recipientId: b.socket.id,
      description: { type: "offer", sdp: "v=0", content: "private" },
    },
    { recipientId: b.socket.id, candidate: { candidate: "x".repeat(2049) } },
    {
      recipientId: b.socket.id,
      candidate: { candidate: "", sdpMLineIndex: -1 },
    },
    {
      recipientId: b.socket.id,
      candidate: { candidate: "", usernameFragment: 5 },
    },
    {
      recipientId: b.socket.id,
      candidate: { candidate: "", other: "private" },
    },
    {
      recipientId: b.socket.id,
      candidate: { candidate: "" },
      senderId: a.socket.id,
    },
    {
      recipientId: b.socket.id,
      candidate: { candidate: "" },
      content: "private",
    },
  ])
    assert.equal((await emit(a.socket, "peer:signal", payload)).ok, false);
  for (const event of ["offer", "chunk", "control", "clear-history"]) {
    let contentEvents = 0;
    b.socket.on(event, () => contentEvents++);
    const result = await emit(
      a.socket,
      event,
      event === "clear-history"
        ? undefined
        : {
            recipientId: b.socket.id,
            content: "private",
            data: Buffer.from("private"),
          },
    );
    assert.equal(result.ok, false);
    assert.match(result.error!, /signaling only/);
    assert.equal(contentEvents, 0);
  }
  assert.equal(forwarded, 0);
  const incoming = received(b.socket, "peer:signal");
  const candidate = {
    candidate: "",
    sdpMid: null,
    sdpMLineIndex: null,
    usernameFragment: null,
  };
  assert(
    (
      await emit(a.socket, "peer:signal", {
        recipientId: b.socket.id,
        candidate,
      })
    ).ok,
  );
  assert.deepEqual(await incoming, { senderId: a.socket.id, candidate });
});

test("room membership and socket/session capacity are bounded", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const cookie = await f.session();
  const owner = await f.client(cookie);
  const room = await emit(owner.socket, "room:create");
  for (let i = 0; i < 7; i++) {
    const peer = await f.client(cookie);
    assert(
      (await emit(peer.socket, "room:join", { invitation: room.invitation }))
        .ok,
    );
  }
  await assert.rejects(f.client(cookie));
  const extra = await f.client(
    await f.session({ "X-Forwarded-For": "203.0.113.8" }),
    { "X-Forwarded-For": "203.0.113.8" },
  );
  assert.equal(
    (await emit(extra.socket, "room:join", { invitation: room.invitation })).ok,
    false,
  );
});

test("creation/join/signaling limits are session scoped, expire and cannot be bypassed with socket identities", async (t) => {
  let time = Date.now();
  const f = await fixture({}, { now: () => time });
  t.after(f.close);
  const cookie = await f.session();
  const a = await f.client(cookie),
    b = await f.client(cookie);
  for (let i = 0; i < 30; i++) {
    const result = await emit(i % 2 ? a.socket : b.socket, "room:join", {
      invitation: randomBytes(24).toString("base64url"),
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /expired or unavailable/);
  }
  assert.match(
    (
      await emit(b.socket, "room:join", {
        invitation: randomBytes(24).toString("base64url"),
      })
    ).error!,
    /Too many/,
  );
  time += 60001;
  const room = await emit(a.socket, "room:create");
  assert(room.ok);
  assert(
    (await emit(b.socket, "room:join", { invitation: room.invitation })).ok,
  );
  for (let i = 0; i < 240; i++) {
    const from = i % 2 ? a.socket : b.socket,
      to = i % 2 ? b.socket : a.socket;
    assert(
      (
        await emit(from, "peer:signal", {
          recipientId: to.id,
          candidate: { candidate: "" },
        })
      ).ok,
    );
  }
  assert.match(
    (
      await emit(a.socket, "peer:signal", {
        recipientId: b.socket.id,
        candidate: { candidate: "" },
      })
    ).error!,
    /Too many/,
  );
  time += 60001;
  assert(
    (
      await emit(a.socket, "peer:signal", {
        recipientId: b.socket.id,
        candidate: { candidate: "" },
      })
    ).ok,
  );
  assert((await emit(a.socket, "room:close")).ok);
  for (let i = 0; i < 10; i++) {
    assert((await emit(a.socket, "room:create")).ok);
    // A leave also closes an owned room, without exhausting the separate close limiter.
    assert((await emit(a.socket, "room:leave")).ok);
  }
  assert.match((await emit(b.socket, "room:create")).error!, /Too many/);
  time += 60001;
  assert((await emit(b.socket, "room:create")).ok);
});

test("Socket.IO transport rejects payloads above the default 64 KiB ceiling", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal(f.config.maxSocketBytes, 65536);
  const a = await f.client(await f.session());
  const disconnected = received(a.socket, "disconnect");
  a.socket.emit("peer:signal", {
    recipientId: "unknown",
    description: { type: "offer", sdp: "x".repeat(65536) },
  });
  await disconnected;
});

test("browser same-origin polling without Origin is authorized and upgrades securely", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const cookie = await f.session();
  // Node's XHR client overwrites Host, so model the canonical reverse proxy.
  const proxy = createServer((req, res) => {
    const upstream = httpRequest(
      `${f.url}${req.url}`,
      {
        method: req.method,
        headers: { ...req.headers, host: f.config.host },
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502).end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress !== "string");
  const pollingHeaders = {
    Origin: undefined,
    "Sec-Fetch-Site": "same-origin",
    Cookie: cookie,
  };
  const initial = await f.request(
    "/socket.io/?EIO=4&transport=polling",
    "GET",
    undefined,
    pollingHeaders,
  );
  assert.equal(initial.status, 200);
  assert.match(initial.body, /^0\{/);
  const polling = await f.client(
    cookie,
    { Origin: undefined, "Sec-Fetch-Site": "same-origin" },
    {},
    ["polling"],
    proxyAddress.port,
  );
  assert.equal(polling.welcome.devices.length, 1);
  assert((await emit(polling.socket, "room:create")).ok);
  const upgrading = await f.client(
    cookie,
    { "Sec-Fetch-Site": "same-origin" },
    {},
    ["polling", "websocket"],
    proxyAddress.port,
  );
  if (upgrading.socket.io.engine.transport.name !== "websocket")
    await received(upgrading.socket.io.engine as unknown as Socket, "upgrade");
  assert.equal(upgrading.socket.io.engine.transport.name, "websocket");
  for (const changes of [
    { "Sec-Fetch-Site": undefined },
    { "Sec-Fetch-Site": "cross-site" },
    { Origin: "https://evil.example" },
    { Cookie: "" },
    { Host: "evil.example" },
    { "X-Forwarded-For": "127.0.0.1, 203.0.113.7" },
  ]) {
    assert.equal(
      (
        await f.request(
          "/socket.io/?EIO=4&transport=polling",
          "GET",
          undefined,
          { ...pollingHeaders, ...changes },
        )
      ).status,
      400,
    );
  }
  await assert.rejects(
    f.client(cookie, { Origin: undefined, "Sec-Fetch-Site": "same-origin" }),
  );
});
