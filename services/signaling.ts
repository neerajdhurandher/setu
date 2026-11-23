import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { HistoryStore } from "../database/history";
import {
  CHUNK_SIZE,
  identitySchema,
  isSafeLink,
  offerSchema,
  type Device,
  type Reply,
  type Transfer,
} from "../lib/protocol";

export function isLocalAddress(address: string) {
  const normalized = address.replace(/^::ffff:/, "");
  if (normalized === "::1") return true;
  if (isIP(normalized) === 6) return /^(fc|fd|fe[89ab])/i.test(normalized);
  if (isIP(normalized) !== 4) return false;
  const [first, second] = normalized.split(".").map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254)
  );
}

export function isSameOrigin(request: IncomingMessage) {
  if (!request.headers.origin) return true;
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}

type Acknowledge<T = object> = (reply: Reply<T>) => void;
interface Session {
  device: Device;
  owner: string;
  room: string;
  offers: number;
  windowStart: number;
}

export function createSignalingServer(
  httpServer: HttpServer,
  history: HistoryStore,
  addresses: string[] | (() => string[]) = [],
) {
  const io = new Server(httpServer, {
    maxHttpBufferSize: 300 * 1024,
    perMessageDeflate: false,
    allowRequest: (request, callback) =>
      callback(
        null,
        isLocalAddress(request.socket.remoteAddress ?? "") &&
          isSameOrigin(request),
      ),
  });
  const sessions = new Map<string, Session>();
  const transfers = new Map<string, Transfer>();
  const inFlight = new Set<string>();
  const salt = randomUUID();
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const devices = (room: string) =>
    [...sessions.values()]
      .filter((session) => session.room === room)
      .map((session) => session.device);
  const broadcast = (room: string) =>
    io.to(room).emit("devices", devices(room));
  const publish = (transfer: Transfer) =>
    io
      .to([transfer.senderId, transfer.recipientId])
      .emit("transfer", { ...transfer });
  const finish = (transfer: Transfer) => {
    for (const [id, direction] of [
      [transfer.senderId, "sent"],
      [transfer.recipientId, "received"],
    ] as const) {
      const session = sessions.get(id);
      if (!session) continue;
      const activity = { ...transfer, direction };
      history.add(session.owner, activity);
      io.to(id).emit("activity", activity);
    }
    publish(transfer);
    transfers.delete(transfer.id);
  };
  const fail = (
    transfer: Transfer,
    status: "failed" | "cancelled" | "rejected",
  ) => {
    transfer.status = status;
    finish(transfer);
  };
  const owned = (socket: Socket, id: string) => {
    const transfer = transfers.get(id);
    return transfer &&
      [transfer.senderId, transfer.recipientId].includes(socket.id)
      ? transfer
      : undefined;
  };

  io.use((socket, next) => {
    const identity = identitySchema.safeParse(socket.handshake.auth);
    if (!identity.success)
      return next(new Error("Invalid device details or room PIN."));
    if (process.env.SETU_PIN && identity.data.pin !== process.env.SETU_PIN) {
      return next(new Error("Enter the host's room PIN in Settings."));
    }
    if (sessions.size >= 100)
      return next(new Error("This host is at capacity. Try again later."));
    socket.data.identity = identity.data;
    next();
  });

  io.on("connection", (socket) => {
    const identity = identitySchema.parse(socket.data.identity);
    const room = digest(salt + identity.pin);
    const session: Session = {
      device: {
        id: socket.id,
        name: identity.name,
        platform: identity.platform,
        os: identity.os,
      },
      owner: digest(identity.sessionId),
      room,
      offers: 0,
      windowStart: Date.now(),
    };
    sessions.set(socket.id, session);
    socket.join(room);
    socket.emit("welcome", {
      selfId: socket.id,
      devices: devices(room),
      history: history.list(session.owner),
      addresses: typeof addresses === "function" ? addresses() : addresses,
    });
    broadcast(room);

    socket.on("rename", (raw: unknown, ack: Acknowledge) => {
      if (typeof ack !== "function") return;
      const parsed = z.string().trim().min(1).max(40).safeParse(raw);
      if (!parsed.success)
        return ack({
          ok: false,
          error: "Use a device name between 1 and 40 characters.",
        });
      session.device.name = parsed.data;
      broadcast(room);
      ack({ ok: true });
    });

    socket.on(
      "offer",
      (raw: unknown, ack: Acknowledge<{ transfer: Transfer }>) => {
        if (typeof ack !== "function") return;
        if (Date.now() - session.windowStart > 60_000) {
          session.offers = 0;
          session.windowStart = Date.now();
        }
        if (++session.offers > 120 || transfers.size >= 500) {
          return ack({
            ok: false,
            error: "Too many requests. Try again shortly.",
          });
        }
        const parsed = offerSchema.safeParse(raw);
        if (!parsed.success)
          return ack({
            ok: false,
            error: "Invalid share. Files must be 1 GB or smaller.",
          });
        const offer = parsed.data;
        const recipient = sessions.get(offer.recipientId);
        if (
          !recipient ||
          recipient.room !== room ||
          offer.recipientId === socket.id
        ) {
          return ack({
            ok: false,
            error: "That device is no longer available.",
          });
        }
        if (offer.kind === "link" && !isSafeLink(offer.content)) {
          return ack({
            ok: false,
            error: "Enter a complete http:// or https:// link.",
          });
        }
        const transfer: Transfer = {
          id: randomUUID(),
          senderId: socket.id,
          recipientId: offer.recipientId,
          senderName: session.device.name,
          recipientName: recipient.device.name,
          kind: offer.kind,
          name:
            offer.kind === "file" ? offer.name : offer.content.slice(0, 100),
          size:
            offer.kind === "file"
              ? offer.size
              : Buffer.byteLength(offer.content),
          mime: offer.kind === "file" ? offer.mime : "text/plain",
          ...(offer.kind !== "file" ? { content: offer.content } : {}),
          offset: 0,
          status: offer.kind === "file" ? "pending" : "completed",
          createdAt: Date.now(),
        };
        transfers.set(transfer.id, transfer);
        publish(transfer);
        if (offer.kind !== "file") finish(transfer);
        ack({ ok: true, transfer: { ...transfer } });
      },
    );

    socket.on("control", (raw: unknown, ack: Acknowledge) => {
      if (typeof ack !== "function") return;
      const parsed = z
        .object({
          id: z.uuid(),
          action: z.enum(["accept", "reject", "pause", "resume", "cancel"]),
        })
        .safeParse(raw);
      if (!parsed.success)
        return ack({ ok: false, error: "Invalid transfer action." });
      const transfer = owned(socket, parsed.data.id);
      if (!transfer)
        return ack({ ok: false, error: "Transfer is no longer active." });
      const action = parsed.data.action;
      if (
        (action === "accept" || action === "reject") &&
        (transfer.recipientId !== socket.id || transfer.status !== "pending")
      ) {
        return ack({
          ok: false,
          error: "Only the recipient can approve a pending transfer.",
        });
      }
      if (action === "reject" || action === "cancel") {
        fail(transfer, action === "reject" ? "rejected" : "cancelled");
      } else {
        if (action === "pause" && transfer.status !== "transferring") {
          return ack({
            ok: false,
            error: "Only an active transfer can be paused.",
          });
        }
        if (action === "resume" && transfer.status !== "paused") {
          return ack({
            ok: false,
            error: "Only a paused transfer can be resumed.",
          });
        }
        transfer.status = action === "pause" ? "paused" : "transferring";
        if (transfer.size === 0) {
          transfer.status = "completed";
          finish(transfer);
        } else publish(transfer);
      }
      ack({ ok: true });
    });

    socket.on(
      "chunk",
      (
        raw: { id?: string; offset?: number; data?: unknown } | null,
        ack: Acknowledge<{ offset: number }>,
      ) => {
        if (typeof ack !== "function") return;
        const transfer =
          raw && typeof raw.id === "string" ? transfers.get(raw.id) : undefined;
        if (
          !transfer ||
          transfer.senderId !== socket.id ||
          transfer.status !== "transferring"
        ) {
          return ack({
            ok: false,
            error: "The recipient must accept the transfer first.",
          });
        }
        if (
          !Buffer.isBuffer(raw?.data) &&
          !(raw?.data instanceof ArrayBuffer)
        ) {
          return ack({ ok: false, error: "Invalid file data." });
        }
        const data = Buffer.isBuffer(raw.data)
          ? raw.data
          : Buffer.from(raw.data as ArrayBuffer);
        if (
          raw.offset !== transfer.offset ||
          inFlight.has(transfer.id) ||
          !data.length ||
          data.length > CHUNK_SIZE ||
          transfer.offset + data.length > transfer.size
        ) {
          return ack({ ok: false, error: "Invalid chunk size or offset." });
        }
        inFlight.add(transfer.id);
        io.to(transfer.recipientId)
          .timeout(20_000)
          .emit(
            "chunk",
            { id: transfer.id, offset: transfer.offset, data },
            (error: Error | null, responses: { ok?: boolean }[]) => {
              inFlight.delete(transfer.id);
              if (!transfers.has(transfer.id))
                return ack({ ok: false, error: "Transfer ended." });
              if (error || !responses[0]?.ok) {
                fail(transfer, "failed");
                return ack({
                  ok: false,
                  error: "Recipient stopped responding. Send the file again.",
                });
              }
              transfer.offset += data.length;
              if (transfer.offset === transfer.size) {
                transfer.status = "completed";
                finish(transfer);
              } else publish(transfer);
              ack({ ok: true, offset: transfer.offset });
            },
          );
      },
    );

    socket.on("clear-history", (ack: Acknowledge) => {
      if (typeof ack !== "function") return;
      history.clear(session.owner);
      socket.emit("history", []);
      ack({ ok: true });
    });

    socket.on("disconnect", () => {
      for (const transfer of transfers.values()) {
        if ([transfer.senderId, transfer.recipientId].includes(socket.id))
          fail(transfer, "failed");
      }
      sessions.delete(socket.id);
      broadcast(room);
    });
  });

  let previousAddresses = JSON.stringify(
    typeof addresses === "function" ? addresses() : addresses,
  );
  const networkRefresh = setInterval(() => {
    const currentAddresses =
      typeof addresses === "function" ? addresses() : addresses;
    const serialized = JSON.stringify(currentAddresses);
    if (serialized !== previousAddresses) {
      previousAddresses = serialized;
      io.emit("network-addresses", currentAddresses);
    }
  }, 5000);
  networkRefresh.unref();

  const cleanup = setInterval(() => {
    for (const transfer of transfers.values()) {
      if (Date.now() - transfer.createdAt > 60 * 60 * 1000)
        fail(transfer, "cancelled");
    }
    history.cleanup();
  }, 60_000);
  cleanup.unref();
  httpServer.once("close", () => {
    clearInterval(cleanup);
    clearInterval(networkRefresh);
  });
  return io;
}
