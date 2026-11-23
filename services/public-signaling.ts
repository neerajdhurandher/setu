import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { identitySchema, type Device } from "../lib/protocol";
import { isLoopback, publicClientIP, type PublicConfig } from "./public-config";

const COOKIE = "__Host-setu-session";
const MINUTE = 60_000;
const signalSchema = z
  .object({
    recipientId: z.string().min(1).max(100),
    description: z
      .object({
        type: z.enum(["offer", "answer"]),
        sdp: z
          .string()
          .min(1)
          .max(32 * 1024)
          .refine((s) => Buffer.byteLength(s) <= 32 * 1024),
      })
      .strict()
      .optional(),
    candidate: z
      .object({
        candidate: z
          .string()
          .max(2048)
          .refine((s) => Buffer.byteLength(s) <= 2048),
        sdpMid: z.string().max(256).nullable().optional(),
        sdpMLineIndex: z.number().int().min(0).max(65535).nullable().optional(),
        usernameFragment: z.string().max(256).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => !!value.description || !!value.candidate);

class RateLimits {
  private entries = new Map<string, { count: number; until: number }>();
  constructor(private now: () => number) {}
  allow(key: string, limit: number) {
    const time = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.until <= time) {
      if (!entry && this.entries.size >= 10_000) {
        this.cleanup();
        if (this.entries.size >= 10_000) return false;
      }
      entry = { count: 0, until: time + MINUTE };
      this.entries.set(key, entry);
    }
    return ++entry.count <= limit;
  }
  cleanup() {
    for (const [key, entry] of this.entries)
      if (entry.until <= this.now()) this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
}

type BrowserSession = { id: string; expiresAt: number };
type Member = {
  socket: Socket;
  browser: BrowserSession;
  ip: string;
  device: Device;
  room?: string;
};
type Room = {
  verifier: string;
  owner: string;
  expiresAt: number;
  members: Set<string>;
};
type Ack = (reply: {
  ok: boolean;
  error?: string;
  invitation?: string;
  expiresAt?: number;
}) => void;

export function createPublicSignalingServer(
  httpServer: HttpServer,
  config: PublicConfig,
  options: {
    now?: () => number;
    roomTtlMs?: number;
    cleanupIntervalMs?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const rates = new RateLimits(now);
  const members = new Map<string, Member>();
  const rooms = new Map<string, Room>();
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const sign = (value: string) =>
    createHmac("sha256", config.sessionSecret)
      .update(value)
      .digest("base64url");
  function session(request: IncomingMessage): BrowserSession | undefined {
    const cookie = request.headers.cookie;
    if (!cookie || cookie.length > 4096) return;
    const matches = cookie
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${COOKIE}=`));
    if (matches.length !== 1) return;
    const token = matches[0].slice(COOKIE.length + 1);
    const [id, expiry, signature, ...extra] = token.split(".");
    if (
      extra.length ||
      !/^[\w-]{32}$/.test(id ?? "") ||
      !/^\d{13}$/.test(expiry ?? "") ||
      !/^[\w-]{43}$/.test(signature ?? "")
    )
      return;
    const expected = sign(`${id}.${expiry}`);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return;
    const expiresAt = Number(expiry);
    if (expiresAt <= now() || expiresAt > now() + config.sessionTtlMs) return;
    return { id, expiresAt };
  }
  const authorized = (request: IncomingMessage) => {
    const transport = new URLSearchParams(request.url?.split("?")[1] ?? "").get(
      "transport",
    );
    // Same-origin XHR polling can omit Origin; WebSocket upgrades cannot.
    const sameOriginPolling =
      transport === "polling" &&
      request.headers.upgrade === undefined &&
      (request.method === "GET" || request.method === "POST") &&
      request.headers["sec-fetch-site"] === "same-origin";
    if (
      request.headers["sec-fetch-site"] !== undefined &&
      request.headers["sec-fetch-site"] !== "same-origin"
    )
      return;
    const ip = publicClientIP(request, config, !sameOriginPolling);
    const browser = session(request);
    return ip && browser ? { ip, browser } : undefined;
  };
  const io = new Server(httpServer, {
    maxHttpBufferSize: config.maxSocketBytes,
    perMessageDeflate: false,
    serveClient: false,
    allowRequest: (request, callback) => {
      const auth = authorized(request);
      callback(
        null,
        !!auth &&
          members.size < 256 &&
          io.engine.clientsCount < 256 &&
          rates.allow(`connect:ip:${auth.ip}`, 60) &&
          rates.allow(`connect:session:${auth.browser.id}`, 20),
      );
    },
  });
  // Check every polling request and upgrade, not just the initial handshake.
  io.engine.use(
    (
      request: IncomingMessage,
      _response: unknown,
      next: (error?: Error) => void,
    ) =>
      next(
        authorized(request) ? undefined : new Error("Unauthorized session."),
      ),
  );
  io.use((socket, next) => {
    const auth = authorized(socket.request);
    const identity = identitySchema.safeParse(socket.handshake.auth);
    if (!auth || !identity.success)
      return next(new Error("Unauthorized session or invalid device details."));
    if (
      members.size >= 256 ||
      [...members.values()].filter((m) => m.browser.id === auth.browser.id)
        .length >= 8
    )
      return next(new Error("Server or session is at capacity."));
    socket.data.publicAuth = auth;
    socket.data.identity = identity.data;
    next();
  });

  const deviceList = (room: Room) =>
    [...room.members].flatMap((id) => {
      const member = members.get(id);
      return member ? [member.device] : [];
    });
  function broadcast(room: Room) {
    for (const id of room.members)
      members.get(id)?.socket.emit("devices", deviceList(room));
  }
  function endRoom(room: Room, error: string) {
    rooms.delete(room.verifier);
    for (const id of room.members) {
      const member = members.get(id);
      if (!member) continue;
      member.room = undefined;
      member.socket.emit("room:ended", { error });
      member.socket.emit("devices", [member.device]);
    }
    room.members.clear();
  }
  function leave(member: Member) {
    const room = member.room ? rooms.get(member.room) : undefined;
    member.room = undefined;
    if (!room) return;
    if (room.owner === member.socket.id) return endRoom(room, "Room closed.");
    room.members.delete(member.socket.id);
    if (!room.members.size) rooms.delete(room.verifier);
    else broadcast(room);
  }
  function sweep() {
    for (const room of rooms.values())
      if (room.expiresAt <= now()) endRoom(room, "Room expired.");
    for (const member of members.values())
      if (member.browser.expiresAt <= now()) member.socket.disconnect(true);
    rates.cleanup();
  }
  io.on("connection", (socket) => {
    const identity = identitySchema.parse(socket.data.identity);
    const member: Member = {
      socket,
      ...socket.data.publicAuth,
      device: {
        id: socket.id,
        name: identity.name,
        platform: identity.platform,
        os: identity.os,
      },
    };
    members.set(socket.id, member);
    socket.emit("welcome", {
      selfId: socket.id,
      devices: [member.device],
      history: [],
      addresses: [],
    });

    function event(
      name: string,
      limit: number,
      action: (raw: unknown, ack: Ack) => void,
    ) {
      socket.on(name, (...args: unknown[]) => {
        const last = args.at(-1);
        if (typeof last !== "function") return;
        const ack = last as Ack;
        sweep();
        if (!members.has(socket.id) || member.browser.expiresAt <= now()) {
          ack({ ok: false, error: "Session expired." });
          return;
        }
        if (
          !rates.allow(`all:ip:${member.ip}`, 600) ||
          !rates.allow(`all:session:${member.browser.id}`, 360) ||
          !rates.allow(`${name}:ip:${member.ip}`, limit * 2) ||
          !rates.allow(`${name}:session:${member.browser.id}`, limit)
        )
          return ack({
            ok: false,
            error: "Too many requests. Try again shortly.",
          });
        if (args.length > 2)
          return ack({ ok: false, error: "Invalid request." });
        action(args.length === 1 ? undefined : args[0], ack);
      });
    }
    event("room:create", 10, (raw, ack) => {
      if (raw !== undefined && raw !== null)
        return ack({ ok: false, error: "Invalid request." });
      if (member.room)
        return ack({ ok: false, error: "Leave the current room first." });
      if (rooms.size >= 128)
        return ack({ ok: false, error: "Room capacity reached." });
      const invitation = randomBytes(24).toString("base64url");
      const verifier = digest(invitation);
      const room: Room = {
        verifier,
        owner: socket.id,
        expiresAt: now() + (options.roomTtlMs ?? 60 * MINUTE),
        members: new Set([socket.id]),
      };
      rooms.set(verifier, room);
      member.room = verifier;
      broadcast(room);
      ack({ ok: true, invitation, expiresAt: room.expiresAt });
    });
    event("room:join", 30, (raw, ack) => {
      const parsed = z
        .object({ invitation: z.string().regex(/^[\w-]{32}$/) })
        .strict()
        .safeParse(raw);
      if (!parsed.success)
        return ack({ ok: false, error: "Invalid invitation." });
      const room = rooms.get(digest(parsed.data.invitation));
      if (!room || room.expiresAt <= now())
        return ack({ ok: false, error: "Invitation expired or unavailable." });
      if (member.room)
        return ack({ ok: false, error: "Leave the current room first." });
      if (room.members.size >= 8)
        return ack({ ok: false, error: "Room is full." });
      room.members.add(socket.id);
      member.room = room.verifier;
      broadcast(room);
      ack({ ok: true, expiresAt: room.expiresAt });
    });
    event("room:leave", 30, (_raw, ack) => {
      leave(member);
      socket.emit("devices", [member.device]);
      ack({ ok: true });
    });
    event("room:close", 10, (_raw, ack) => {
      const room = member.room ? rooms.get(member.room) : undefined;
      if (!room || room.owner !== socket.id)
        return ack({ ok: false, error: "Only the room owner can close it." });
      endRoom(room, "Room closed.");
      ack({ ok: true });
    });
    event("rename", 30, (raw, ack) => {
      const parsed = z.string().trim().min(1).max(40).safeParse(raw);
      if (!parsed.success)
        return ack({ ok: false, error: "Invalid device name." });
      member.device.name = parsed.data;
      const room = member.room ? rooms.get(member.room) : undefined;
      if (room) broadcast(room);
      else socket.emit("devices", [member.device]);
      ack({ ok: true });
    });
    event("peer:signal", 240, (raw, ack) => {
      const parsed = signalSchema.safeParse(raw);
      if (!parsed.success)
        return ack({ ok: false, error: "Invalid signaling payload." });
      const { recipientId, ...signal } = parsed.data;
      const recipient = members.get(recipientId);
      if (
        !recipient ||
        recipientId === socket.id ||
        !member.room ||
        member.room !== recipient.room ||
        recipient.browser.expiresAt <= now() ||
        !rooms.has(member.room)
      )
        return ack({ ok: false, error: "Peer is not available in this room." });
      recipient.socket.emit("peer:signal", { senderId: socket.id, ...signal });
      ack({ ok: true });
    });
    for (const name of ["offer", "chunk", "control", "clear-history"])
      event(name, 10, (_raw, ack) =>
        ack({
          ok: false,
          error:
            "Public mode permits signaling only; content and history must stay on your devices.",
        }),
      );
    socket.on("disconnect", () => {
      leave(member);
      members.delete(socket.id);
    });
  });

  function json(response: ServerResponse, status: number, data: object) {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(data));
  }
  function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const path = request.url?.split("?")[0];
    if (
      path === "/healthz" &&
      request.method === "GET" &&
      (isLoopback(request.socket.remoteAddress ?? "") ||
        publicClientIP(request, config))
    ) {
      json(response, 200, { ok: true });
      return true;
    }
    const ip = publicClientIP(request, config);
    if (!ip) {
      json(response, 403, { error: "Forbidden." });
      return true;
    }
    if (!rates.allow(`http:${ip}`, 240)) {
      json(response, 429, { error: "Too many requests." });
      return true;
    }
    if (path === "/healthz") {
      json(response, 405, { error: "Method not allowed." });
      return true;
    }
    if (path === "/api/config") {
      if (request.method !== "GET")
        json(response, 405, { error: "Method not allowed." });
      else
        json(response, 200, { mode: "public", iceServers: config.iceServers });
      return true;
    }
    if (path !== "/api/session") return false;
    if (request.method !== "POST") {
      json(response, 405, { error: "Method not allowed." });
      return true;
    }
    if (
      !publicClientIP(request, config, true) ||
      request.headers["x-setu-request"] !== "1" ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
        request.headers["content-type"] ?? "",
      ) ||
      (request.headers["sec-fetch-site"] !== undefined &&
        request.headers["sec-fetch-site"] !== "same-origin")
    ) {
      json(response, 403, { error: "Same-origin JSON request required." });
      return true;
    }
    const existing = session(request);
    if (
      !rates.allow(`session-create:ip:${ip}`, 12) ||
      (existing && !rates.allow(`session-create:session:${existing.id}`, 5))
    ) {
      json(response, 429, { error: "Too many requests." });
      return true;
    }
    let size = 0;
    let body = "";
    if (
      request.headers["content-length"] !== undefined &&
      Number(request.headers["content-length"]) > 1024
    ) {
      json(response, 413, { error: "Request too large." });
      request.resume();
      return true;
    }
    const bodyTimeout = setTimeout(() => {
      if (!response.writableEnded)
        json(response, 408, { error: "Request timed out." });
      request.destroy();
    }, 5000);
    bodyTimeout.unref();
    const stopBodyTimeout = () => clearTimeout(bodyTimeout);
    response.once("close", stopBodyTimeout);
    response.once("finish", stopBodyTimeout);
    request.once("aborted", stopBodyTimeout);
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024) {
        if (!response.writableEnded)
          json(response, 413, { error: "Request too large." });
        body = "";
      } else body += chunk.toString("utf8");
    });
    request.on("error", () => {
      if (!response.writableEnded)
        json(response, 400, { error: "Invalid request." });
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      try {
        const parsed = JSON.parse(body);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length
        )
          throw new Error();
      } catch {
        json(response, 400, { error: "Expected an empty JSON object." });
        return;
      }
      const expiresAt = now() + config.sessionTtlMs;
      const value = `${randomBytes(24).toString("base64url")}.${expiresAt}`;
      response.setHeader(
        "Set-Cookie",
        `${COOKIE}=${value}.${sign(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
      );
      json(response, 200, { ok: true, expiresAt });
    });
    return true;
  }
  const timer = setInterval(sweep, options.cleanupIntervalMs ?? 1000);
  timer.unref();
  const cleanup = () => {
    clearInterval(timer);
    rooms.clear();
    members.clear();
    rates.clear();
  };
  httpServer.once("close", cleanup);
  const originalClose = io.close.bind(io);
  io.close = (callback) => {
    cleanup();
    return originalClose(callback);
  };
  return { io, handleRequest };
}
