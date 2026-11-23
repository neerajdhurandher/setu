import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { after, before, test } from "node:test";
import { io as connect, type Socket } from "socket.io-client";
import { HistoryStore } from "../database/history";
import nextConfig from "../next.config";
import { createSignalingServer, isLocalAddress } from "../services/signaling";
import {
  MAX_FILE_SIZE,
  type Reply,
  type Transfer,
  type Welcome,
} from "../lib/protocol";

const database = new HistoryStore(":memory:");
const http = createServer();
let advertisedAddresses = ["http://10.215.107.127:3000"];
const server = createSignalingServer(http, database, () => advertisedAddresses);
const clients: Socket[] = [];
let url: string;

before(async () => {
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  clients.forEach((client) => client.disconnect());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
});

function client(name: string, pin = "") {
  return new Promise<{ socket: Socket; welcome: Welcome }>(
    (resolve, reject) => {
      const socket = connect(url, {
        forceNew: true,
        transports: ["websocket"],
        auth: {
          sessionId: randomUUID(),
          name,
          platform: "desktop",
          os: "Test",
          pin,
        },
      });
      clients.push(socket);
      socket.once("welcome", (welcome: Welcome) =>
        resolve({ socket, welcome }),
      );
      socket.once("connect_error", reject);
    },
  );
}

function emit<T>(socket: Socket, event: string, payload: unknown) {
  return new Promise<Reply<T>>((resolve, reject) => {
    socket
      .timeout(3000)
      .emit(event, payload, (error: Error | null, result: Reply<T>) => {
        if (error) reject(error);
        else resolve(result);
      });
  });
}

test("private IPv4 and IPv6 addresses only", () => {
  for (const ip of [
    "127.0.0.1",
    "::1",
    "192.168.1.2",
    "::ffff:10.0.0.3",
    "172.16.0.1",
    "fd00::1",
  ])
    assert(isLocalAddress(ip));
  for (const ip of [
    "8.8.8.8",
    "172.32.0.1",
    "192.169.1.1",
    "2001:4860:4860::8888",
    "invalid",
  ])
    assert(!isLocalAddress(ip));
});

test("Next.js development origins include the host's LAN interfaces", () => {
  const interfaces = Object.values(networkInterfaces()).flat();
  for (const address of interfaces) {
    if (address?.family === "IPv4" && !address.internal) {
      assert(nextConfig.allowedDevOrigins?.includes(address.address));
    }
  }
  assert(!nextConfig.allowedDevOrigins?.includes("*"));
});

test(
  "pairing addresses refresh for new and already connected devices",
  { timeout: 10_000 },
  async () => {
    const existing = await client("Existing device");
    assert.deepEqual(existing.welcome.addresses, [
      "http://10.215.107.127:3000",
    ]);
    const updated = new Promise<string[]>((resolve) =>
      existing.socket.once("network-addresses", resolve),
    );
    advertisedAddresses = ["http://192.168.1.11:3000"];
    const joining = await client("New device");
    assert.deepEqual(joining.welcome.addresses, advertisedAddresses);
    assert.deepEqual(await updated, advertisedAddresses);
  },
);

test("discovery isolates PIN rooms and rejects cross-room offers", async () => {
  const first = await client("First", "1234");
  const second = await client("Second", "5678");
  assert.equal(first.welcome.devices.length, 1);
  assert.equal(second.welcome.devices.length, 1);
  const result = await emit(first.socket, "offer", {
    kind: "text",
    recipientId: second.socket.id,
    content: "secret",
  });
  assert.equal(result.ok, false);
});

test("approved chunks transfer byte-for-byte, support pause/resume, and persist history", async () => {
  const sender = await client("Laptop");
  const receiver = await client("Phone");
  assert(
    receiver.welcome.devices.some((device) => device.id === sender.socket.id),
  );
  const bytes = Buffer.from("A real local transfer.");
  const offer = await emit<{ transfer: Transfer }>(sender.socket, "offer", {
    kind: "file",
    recipientId: receiver.socket.id,
    name: "hello.txt",
    size: bytes.length,
    mime: "text/plain",
  });
  assert(offer.ok);
  const id = offer.transfer.id;
  assert.equal(
    (await emit(sender.socket, "chunk", { id, offset: 0, data: bytes })).ok,
    false,
  );
  assert.equal(
    (await emit(sender.socket, "control", { id, action: "accept" })).ok,
    false,
  );
  assert((await emit(receiver.socket, "control", { id, action: "accept" })).ok);
  assert((await emit(sender.socket, "control", { id, action: "pause" })).ok);
  assert.equal(
    (await emit(sender.socket, "chunk", { id, offset: 0, data: bytes })).ok,
    false,
  );
  assert((await emit(sender.socket, "control", { id, action: "resume" })).ok);
  assert.equal(
    (await emit(sender.socket, "chunk", { id, offset: 99, data: bytes })).ok,
    false,
  );
  const received: Buffer[] = [];
  receiver.socket.on(
    "chunk",
    (chunk: { data: Buffer }, ack: (reply: { ok: boolean }) => void) => {
      received.push(Buffer.from(chunk.data));
      ack({ ok: true });
    },
  );
  const activity = new Promise<Transfer>((resolve) =>
    receiver.socket.once("activity", resolve),
  );
  assert(
    (await emit(sender.socket, "chunk", { id, offset: 0, data: bytes })).ok,
  );
  assert.equal(Buffer.concat(received).toString(), bytes.toString());
  assert.equal((await activity).status, "completed");
});

test("unsafe URLs and oversized files are rejected; text is delivered instantly", async () => {
  const sender = await client("Desktop");
  const receiver = await client("Tablet");
  for (const offer of [
    { kind: "link", content: "javascript:alert(1)" },
    {
      kind: "file",
      name: "large.zip",
      size: MAX_FILE_SIZE + 1,
      mime: "application/zip",
    },
  ]) {
    assert.equal(
      (
        await emit(sender.socket, "offer", {
          ...offer,
          recipientId: receiver.socket.id,
        })
      ).ok,
      false,
    );
  }
  const delivered = new Promise<Transfer>((resolve) =>
    receiver.socket.once("activity", resolve),
  );
  assert(
    (
      await emit(sender.socket, "offer", {
        kind: "text",
        recipientId: receiver.socket.id,
        content: "Hello from Setu",
      })
    ).ok,
  );
  assert.equal((await delivered).content, "Hello from Setu");
});

test("SQLite history is scoped, expires, and clears", () => {
  const db = new HistoryStore(":memory:");
  const activity = {
    id: randomUUID(),
    createdAt: Date.now(),
    direction: "sent",
  } as unknown as import("../lib/protocol").Activity;
  db.add("one", activity);
  db.add("two", { ...activity, id: randomUUID(), createdAt: 0 });
  assert.equal(db.list("one").length, 1);
  assert.equal(db.list("two").length, 0);
  db.clear("one");
  assert.equal(db.list("one").length, 0);
  db.close();
});
