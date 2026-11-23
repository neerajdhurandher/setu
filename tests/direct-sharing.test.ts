import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { DirectSharing } from "../lib/direct-sharing";
import type { Activity, Device, Transfer } from "../lib/protocol";

class Channel {
  readyState = "connecting";
  partner?: Channel;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  send(data: string) {
    if (this.readyState !== "open") throw new Error("Closed channel");
    queueMicrotask(() => this.partner?.onmessage?.({ data }));
  }
  close() {
    this.readyState = "closed";
  }
}

const connections: Connection[] = [];
class Connection {
  signalingState = "stable";
  connectionState = "new";
  localDescription?: RTCSessionDescriptionInit;
  remoteDescription?: RTCSessionDescriptionInit;
  channel?: Channel;
  onicecandidate?: () => void;
  onconnectionstatechange?: () => void;
  ondatachannel?: (event: { channel: Channel }) => void;
  constructor() {
    connections.push(this);
  }
  createDataChannel() {
    return (this.channel = new Channel());
  }
  async createOffer() {
    return { type: "offer" as const, sdp: String(connections.indexOf(this)) };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: "test-answer" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    if (description.type === "offer") {
      const remote = connections[Number(description.sdp)];
      const channel = (this.channel = new Channel());
      assert.ok(remote.channel);
      channel.partner = remote.channel;
      remote.channel.partner = channel;
      this.ondatachannel?.({ channel });
    } else {
      const channel = this.channel;
      assert.ok(channel?.partner);
      channel.readyState = channel.partner.readyState = "open";
      channel.onopen?.();
      channel.partner.onopen?.();
    }
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = "closed";
    this.channel?.close();
  }
}

let original: PropertyDescriptor | undefined;
const active: DirectSharing[] = [];
beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: Connection,
  });
});
afterEach(() => {
  active.forEach((engine) => engine.close());
  active.length = connections.length = 0;
  mock.restoreAll();
  if (original)
    Object.defineProperty(globalThis, "RTCPeerConnection", original);
  else Reflect.deleteProperty(globalThis, "RTCPeerConnection");
});

function pair() {
  const engines = new Map<string, DirectSharing>();
  const signals: object[] = [];
  const devices: Device[] = [
    { id: "a", name: "Sender", platform: "desktop", os: "Test" },
    { id: "b", name: "Receiver", platform: "desktop", os: "Test" },
  ];
  function make(id: string) {
    const socket = io("http://localhost", { autoConnect: false });
    socket.id = id;
    const transfers = new Map<string, Transfer>();
    const history: Activity[] = [];
    const downloads = new Map<string, string>();
    const errors: string[] = [];
    mock.method(
      socket,
      "emit",
      (
        event: string,
        payload: {
          recipientId: string;
          description?: RTCSessionDescriptionInit;
          candidate?: RTCIceCandidateInit;
        },
        ack: (error: Error | null, reply: { ok: boolean }) => void,
      ) => {
        assert.equal(event, "peer:signal");
        signals.push(payload);
        void engines
          .get(payload.recipientId)!
          .receiveSignal({ ...payload, senderId: id })
          .then(() => ack(null, { ok: true }));
        return socket;
      },
    );
    const engine = new DirectSharing(socket, [], {
      transfer: (transfer) => transfers.set(transfer.id, transfer),
      activity: (activity) => history.push(activity),
      download: (key, url) => downloads.set(key, url),
      receivedBytes: () => 0,
      error: (message) => errors.push(message),
    });
    engines.set(id, engine);
    active.push(engine);
    return { engine, transfers, history, downloads, errors };
  }
  const sender = make("a"),
    receiver = make("b");
  receiver.engine.setDevices(devices);
  sender.engine.setDevices(devices);
  return { sender, receiver, signals };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "Expected direct transfer state");
}

test("text, links and clipboard are direct; simultaneous sends use one channel", async () => {
  const { sender, receiver, signals } = pair();
  await Promise.all([
    sender.engine.sendText("private text", "b", "text"),
    receiver.engine.sendText("private clipboard", "a", "clipboard"),
  ]);
  await sender.engine.sendText("https://example.com/private", "b", "link");
  assert.equal(connections.length, 2);
  assert.equal(receiver.history.length, 3);
  assert.equal(sender.history.length, 3);
  assert.ok(!JSON.stringify(signals).includes("private"));
  assert.deepEqual(sender.errors.concat(receiver.errors), []);
});

test("file requires approval and delivers exact multi-chunk bytes", async () => {
  const { sender, receiver } = pair();
  const bytes = new Uint8Array(50_000).map((_, index) => index % 251);
  await sender.engine.sendFiles([new File([bytes], "proof.bin")], "b");
  const id = [...receiver.transfers.keys()][0];
  assert.equal(receiver.transfers.get(id)?.status, "pending");
  assert.equal(receiver.downloads.size, 0);
  await receiver.engine.control(id, "accept");
  await waitFor(() => receiver.downloads.has(id));
  const url = receiver.downloads.get(id)!;
  try {
    assert.deepEqual(
      new Uint8Array(await (await fetch(url)).arrayBuffer()),
      bytes,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
  assert.equal(sender.transfers.get(id)?.offset, bytes.length);
});

test("zero-byte files complete on approval", async () => {
  const { sender, receiver } = pair();
  await sender.engine.sendFiles([new File([], "empty.txt")], "b");
  const id = [...receiver.transfers.keys()][0];
  await receiver.engine.control(id, "accept");
  const url = receiver.downloads.get(id)!;
  try {
    assert.equal((await (await fetch(url)).arrayBuffer()).byteLength, 0);
  } finally {
    URL.revokeObjectURL(url);
  }
  assert.equal(sender.transfers.get(id)?.status, "completed");
});

test("pause halts acknowledged progress and resume completes the file", async () => {
  const { sender, receiver } = pair();
  const bytes = new Uint8Array(500_000).fill(17);
  await sender.engine.sendFiles([new File([bytes], "paused.bin")], "b");
  const id = [...receiver.transfers.keys()][0];
  const channel = connections[0].channel!;
  const send = channel.send.bind(channel);
  mock.method(channel, "send", (data: string) => {
    if (JSON.parse(data).event === "chunk") setTimeout(() => send(data), 5);
    else send(data);
  });
  await receiver.engine.control(id, "accept");
  await waitFor(() => (receiver.transfers.get(id)?.offset ?? 0) > 0);
  await receiver.engine.control(id, "pause");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const offset = receiver.transfers.get(id)!.offset;
  assert.ok(offset < bytes.length);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(receiver.transfers.get(id)?.offset, offset);
  assert.equal(sender.transfers.get(id)?.status, "paused");
  await receiver.engine.control(id, "resume");
  await waitFor(() => receiver.downloads.has(id));
  const url = receiver.downloads.get(id)!;
  try {
    assert.deepEqual(
      new Uint8Array(await (await fetch(url)).arrayBuffer()),
      bytes,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
});

test("reject/cancel and invalid approval preserve transfer authorization", async () => {
  const { sender, receiver } = pair();
  await sender.engine.sendFiles([new File(["content"], "reject.txt")], "b");
  const id = [...receiver.transfers.keys()][0];
  await assert.rejects(
    sender.engine.control(id, "accept"),
    /Only the recipient/,
  );
  await receiver.engine.control(id, "reject");
  assert.equal(sender.transfers.get(id)?.status, "rejected");
  assert.equal(receiver.downloads.size, 0);
  await sender.engine.sendFiles([new File(["content"], "cancel.txt")], "b");
  const other = [...receiver.transfers.keys()][1];
  await sender.engine.control(other, "cancel");
  assert.equal(receiver.transfers.get(other)?.status, "cancelled");
});

test("unsafe links, foreign recipients and unapproved chunks are refused", async () => {
  const { sender, receiver } = pair();
  await assert.rejects(
    sender.engine.sendText("javascript:alert(1)", "b", "link"),
  );
  await assert.rejects(
    sender.engine.sendText("private", "outsider", "text"),
    /no longer in the room/,
  );
  await sender.engine.sendFiles([new File(["data"], "pending.txt")], "b");
  const id = [...receiver.transfers.keys()][0];
  const channel = connections[0].channel!;
  channel.send(
    JSON.stringify({
      event: "chunk",
      requestId: crypto.randomUUID(),
      id,
      offset: 0,
      data: btoa("data"),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(receiver.transfers.get(id)?.offset, 0);
  assert.equal(receiver.downloads.size, 0);
});
