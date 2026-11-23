import { z } from "zod";
import type { Socket } from "socket.io-client";
import {
  MAX_FILE_SIZE,
  isSafeLink,
  offerSchema,
  type Activity,
  type Device,
  type Transfer,
} from "./protocol";

const CHUNK = 16 * 1024;
const WINDOW = 16;
const messageSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("offer"),
    requestId: z.uuid(),
    id: z.uuid(),
    offer: offerSchema,
  }),
  z.object({
    event: z.literal("control"),
    requestId: z.uuid(),
    id: z.uuid(),
    action: z.enum(["accept", "reject", "pause", "resume", "cancel"]),
  }),
  z.object({
    event: z.literal("chunk"),
    requestId: z.uuid(),
    id: z.uuid(),
    offset: z.number().int().nonnegative(),
    data: z
      .string()
      .max(24 * 1024)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
  z.object({
    event: z.literal("reply"),
    requestId: z.uuid(),
    ok: z.boolean(),
    error: z.string().max(300).optional(),
  }),
]);
type Message = z.infer<typeof messageSchema>;
interface Callbacks {
  transfer: (transfer: Transfer) => void;
  activity: (activity: Activity) => void;
  download: (id: string, url: string, size: number) => void;
  receivedBytes: () => number;
  error: (message: string) => void;
}
interface Peer {
  connection: RTCPeerConnection;
  channel?: RTCDataChannel;
  candidates: RTCIceCandidateInit[];
  ready: Promise<RTCDataChannel>;
  resolve: (channel: RTCDataChannel) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DirectSharing {
  private peers = new Map<string, Peer>();
  private pending = new Map<
    string,
    {
      peerId: string;
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private transfers = new Map<string, Transfer>();
  private files = new Map<string, File>();
  private incoming = new Map<
    string,
    { chunks: Uint8Array<ArrayBuffer>[]; offset: number; size: number }
  >();
  private pumping = new Set<string>();
  private devices: Device[] = [];
  private closed = false;
  private rates = new Map<string, { start: number; count: number }>();

  constructor(
    private socket: Socket,
    private iceServers: RTCIceServer[],
    private callbacks: Callbacks,
  ) {}

  setDevices(devices: Device[]) {
    this.devices = devices;
    for (const id of this.peers.keys())
      if (!devices.some((device) => device.id === id))
        this.dropPeer(id, "Device left the room. Send the file again.");
    for (const device of devices) {
      if ((this.socket.id ?? "") < device.id && !this.peers.has(device.id))
        this.createPeer(device.id, true);
    }
  }

  private async signal(peerId: string, payload: object) {
    await new Promise<void>((resolve, reject) => {
      this.socket
        .timeout(10_000)
        .emit(
          "peer:signal",
          { recipientId: peerId, ...payload },
          (error: Error | null, reply: { ok?: boolean; error?: string }) => {
            if (error || !reply?.ok)
              reject(
                new Error(reply?.error ?? "Pairing server did not respond."),
              );
            else resolve();
          },
        );
    });
  }

  async receiveSignal(raw: unknown) {
    const parsed = z
      .object({
        senderId: z.string().min(1).max(100),
        description: z
          .object({
            type: z.enum(["offer", "answer"]),
            sdp: z.string().max(32 * 1024),
          })
          .optional(),
        candidate: z
          .object({
            candidate: z.string().max(4096),
            sdpMid: z.string().nullable().optional(),
            sdpMLineIndex: z.number().nullable().optional(),
            usernameFragment: z.string().nullable().optional(),
          })
          .optional(),
      })
      .safeParse(raw);
    if (!parsed.success) {
      this.callbacks.error("Invalid pairing signal.");
      return;
    }
    const { senderId, description, candidate } = parsed.data;
    try {
      if (!this.devices.some((device) => device.id === senderId))
        throw new Error("Pairing device is not in this room.");
      const peer = this.peers.get(senderId) ?? this.createPeer(senderId, false);
      if (description) {
        if (
          description.type === "offer" &&
          peer.connection.signalingState !== "stable"
        ) {
          if ((this.socket.id ?? "") < senderId) return;
          await peer.connection.setLocalDescription({ type: "rollback" });
        }
        await peer.connection.setRemoteDescription(description);
        for (const queued of peer.candidates.splice(0))
          await peer.connection.addIceCandidate(queued);
        if (description.type === "offer") {
          await peer.connection.setLocalDescription(
            await peer.connection.createAnswer(),
          );
          const answer = peer.connection.localDescription;
          if (!answer) throw new Error("Cannot create pairing answer.");
          await this.signal(senderId, {
            description: { type: answer.type, sdp: answer.sdp },
          });
        }
      }
      if (candidate) {
        if (peer.connection.remoteDescription)
          await peer.connection.addIceCandidate(candidate);
        else {
          if (peer.candidates.length >= 128)
            throw new Error("Too many pending connection candidates.");
          peer.candidates.push(candidate);
        }
      }
    } catch (error) {
      this.dropPeer(
        senderId,
        error instanceof Error ? error.message : "Direct pairing failed.",
      );
    }
  }

  private createPeer(id: string, initiate: boolean): Peer {
    if (this.closed || this.peers.size >= 8)
      throw new Error("Direct connection capacity reached.");
    let resolve!: Peer["resolve"];
    let reject!: Peer["reject"];
    const ready = new Promise<RTCDataChannel>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Incoming peers can fail before anyone awaits ready.
    void ready.catch(() => {});
    const connection = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = {
      connection,
      ready,
      resolve,
      reject,
      candidates: [],
      timer: setTimeout(
        () =>
          this.dropPeer(
            id,
            "Cannot connect directly. Use the same Wi-Fi and disable guest/client isolation. Files will not be relayed through the cloud.",
          ),
        20_000,
      ),
    };
    this.peers.set(id, peer);
    connection.onicecandidate = (event) => {
      if (event.candidate)
        void this.signal(id, { candidate: event.candidate.toJSON() }).catch(
          (error: Error) => this.dropPeer(id, error.message),
        );
    };
    connection.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(connection.connectionState))
        this.dropPeer(id, "Direct connection ended. Send the file again.");
    };
    connection.ondatachannel = (event) =>
      this.attachChannel(id, peer, event.channel);
    if (initiate) {
      this.attachChannel(
        id,
        peer,
        connection.createDataChannel("setu", { ordered: true }),
      );
      void (async () => {
        await connection.setLocalDescription(await connection.createOffer());
        const offer = connection.localDescription;
        if (!offer) throw new Error("Cannot create pairing offer.");
        await this.signal(id, {
          description: { type: offer.type, sdp: offer.sdp },
        });
      })().catch((error: Error) => this.dropPeer(id, error.message));
    }
    return peer;
  }

  private attachChannel(id: string, peer: Peer, channel: RTCDataChannel) {
    if (peer.channel && peer.channel !== channel) {
      if ((this.socket.id ?? "") < id) {
        channel.close();
        return;
      }
      peer.channel.onclose = null;
      peer.channel.close();
    }
    peer.channel = channel;
    channel.onopen = () => {
      clearTimeout(peer.timer);
      peer.resolve(channel);
    };
    channel.onclose = () => {
      if (peer.channel === channel)
        this.dropPeer(id, "Direct connection closed. Send the file again.");
    };
    channel.onerror = () => this.dropPeer(id, "Direct connection failed.");
    channel.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data.length > 100 * 1024) {
        this.dropPeer(id, "Invalid direct message.");
        return;
      }
      try {
        const parsed = messageSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) throw new Error("Invalid direct message.");
        this.handleMessage(id, channel, parsed.data);
      } catch (error) {
        this.dropPeer(
          id,
          error instanceof Error ? error.message : "Invalid direct message.",
        );
      }
    };
  }

  private async request(peerId: string, payload: object) {
    if (!this.devices.some((device) => device.id === peerId))
      throw new Error("That device is no longer in the room.");
    const channel = await (
      this.peers.get(peerId) ??
      this.createPeer(peerId, (this.socket.id ?? "") < peerId)
    ).ready;
    if (channel.readyState !== "open")
      throw new Error("Direct connection is unavailable.");
    if (this.pending.size >= 200) throw new Error("Too many direct requests.");
    const requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error("Other device stopped responding. Send the file again."),
        );
      }, 25_000);
      this.pending.set(requestId, { peerId, resolve, reject, timer });
      try {
        channel.send(JSON.stringify({ ...payload, requestId }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private publish(transfer: Transfer) {
    this.callbacks.transfer({ ...transfer });
    if (!["pending", "transferring", "paused"].includes(transfer.status)) {
      this.callbacks.activity({
        ...transfer,
        direction: transfer.senderId === this.socket.id ? "sent" : "received",
      });
      this.transfers.delete(transfer.id);
      this.files.delete(transfer.id);
      this.incoming.delete(transfer.id);
    }
  }

  private handleMessage(
    peerId: string,
    channel: RTCDataChannel,
    message: Message,
  ) {
    if (message.event === "reply") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.peerId !== peerId) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve();
      else
        pending.reject(
          new Error(message.error ?? "Other device rejected the request."),
        );
      return;
    }
    let failure: string | undefined;
    try {
      if (message.event === "offer") {
        let rate = this.rates.get(peerId);
        if (!rate || Date.now() - rate.start >= 60_000) {
          rate = { start: Date.now(), count: 0 };
          this.rates.set(peerId, rate);
        }
        if (++rate.count > 120)
          throw new Error("Too many sharing requests. Try again shortly.");
        if (this.transfers.has(message.id) || this.transfers.size >= 100)
          throw new Error("Too many pending transfers.");
        if (message.offer.recipientId !== this.socket.id)
          throw new Error("Wrong recipient.");
        const device = this.devices.find((item) => item.id === peerId);
        if (!device) throw new Error("Device is not in this room.");
        const offer = message.offer;
        if (offer.kind === "link" && !isSafeLink(offer.content))
          throw new Error("Enter a complete HTTP or HTTPS link.");
        if (
          offer.kind === "file" &&
          [...this.transfers.values()]
            .filter((item) => item.senderId === peerId)
            .reduce((sum, item) => sum + item.size, 0) +
            offer.size >
            MAX_FILE_SIZE
        )
          throw new Error("Combined incoming selection exceeds 1 GB.");
        const transfer: Transfer = {
          id: message.id,
          senderId: peerId,
          recipientId: this.socket.id!,
          senderName: device.name,
          recipientName:
            this.devices.find((item) => item.id === this.socket.id)?.name ??
            "My device",
          kind: offer.kind,
          name:
            offer.kind === "file" ? offer.name : offer.content.slice(0, 100),
          size:
            offer.kind === "file"
              ? offer.size
              : new TextEncoder().encode(offer.content).length,
          mime: offer.kind === "file" ? offer.mime : "text/plain",
          ...(offer.kind !== "file" ? { content: offer.content } : {}),
          offset: 0,
          status: offer.kind === "file" ? "pending" : "completed",
          createdAt: Date.now(),
        };
        this.transfers.set(transfer.id, transfer);
        this.publish(transfer);
      } else {
        const transfer = this.transfers.get(message.id);
        if (
          !transfer ||
          ![transfer.senderId, transfer.recipientId].includes(peerId)
        )
          throw new Error("Transfer is no longer active.");
        if (message.event === "control")
          this.applyControl(transfer, message.action, peerId);
        else {
          const buffer = this.incoming.get(message.id);
          if (
            transfer.senderId !== peerId ||
            !buffer ||
            !["transferring", "paused"].includes(transfer.status) ||
            message.offset !== buffer.offset
          )
            throw new Error("Invalid file chunk or approval.");
          const decoded = atob(message.data);
          if (
            !decoded.length ||
            decoded.length > CHUNK ||
            buffer.offset + decoded.length > buffer.size
          )
            throw new Error("Invalid chunk length.");
          const bytes = new Uint8Array(decoded.length);
          for (let index = 0; index < decoded.length; index++)
            bytes[index] = decoded.charCodeAt(index);
          buffer.chunks.push(bytes);
          buffer.offset += bytes.length;
          transfer.offset = buffer.offset;
          if (buffer.offset === buffer.size) this.completeDownload(transfer);
          else this.publish(transfer);
        }
      }
    } catch (error) {
      failure =
        error instanceof Error ? error.message : "Direct request failed.";
    }
    channel.send(
      JSON.stringify({
        event: "reply",
        requestId: message.requestId,
        ok: !failure,
        ...(failure ? { error: failure } : {}),
      }),
    );
  }

  async sendFiles(files: File[], peerId: string) {
    if (
      !files.length ||
      files.length > 100 ||
      files.reduce((sum, file) => sum + file.size, 0) > MAX_FILE_SIZE
    )
      throw new Error(
        "Select up to 100 files, with a combined size of 1 GB or less.",
      );
    for (const file of files) {
      if (this.transfers.size >= 100)
        throw new Error(
          "Too many pending transfers. Finish or cancel a transfer first.",
        );
      const id = crypto.randomUUID();
      const offer = offerSchema.parse({
        kind: "file",
        recipientId: peerId,
        name: (file.webkitRelativePath || file.name).slice(0, 255),
        size: file.size,
        mime: file.type,
      });
      const transfer = this.outgoing(
        id,
        peerId,
        file.name,
        file.size,
        file.type,
        "file",
      );
      this.transfers.set(id, transfer);
      this.files.set(id, file);
      this.publish(transfer);
      try {
        await this.request(peerId, { event: "offer", id, offer });
      } catch (error) {
        transfer.status = "failed";
        this.publish(transfer);
        throw error;
      }
    }
  }

  async sendText(
    content: string,
    peerId: string,
    kind: "text" | "link" | "clipboard",
  ) {
    const offer = offerSchema.parse({ kind, recipientId: peerId, content });
    if (offer.kind === "file") throw new Error("Invalid text offer.");
    if (kind === "link" && !isSafeLink(offer.content))
      throw new Error("Enter a complete HTTP or HTTPS link.");
    const id = crypto.randomUUID();
    const transfer = {
      ...this.outgoing(
        id,
        peerId,
        content.slice(0, 100),
        new TextEncoder().encode(content).length,
        "text/plain",
        kind,
      ),
      content: offer.content,
    };
    await this.request(peerId, { event: "offer", id, offer });
    transfer.status = "completed";
    this.publish(transfer);
  }

  private outgoing(
    id: string,
    recipientId: string,
    name: string,
    size: number,
    mime: string,
    kind: Transfer["kind"],
  ): Transfer {
    return {
      id,
      senderId: this.socket.id!,
      recipientId,
      senderName:
        this.devices.find((device) => device.id === this.socket.id)?.name ??
        "My device",
      recipientName:
        this.devices.find((device) => device.id === recipientId)?.name ??
        "Other device",
      kind,
      name,
      size,
      mime,
      offset: 0,
      status: "pending",
      createdAt: Date.now(),
    };
  }

  private completeDownload(transfer: Transfer) {
    const buffer = this.incoming.get(transfer.id);
    if (!buffer) throw new Error("Receive buffer is unavailable.");
    this.callbacks.download(
      transfer.id,
      URL.createObjectURL(
        new Blob(buffer.chunks, { type: "application/octet-stream" }),
      ),
      transfer.size,
    );
    transfer.status = "completed";
    this.publish(transfer);
  }

  private applyControl(
    transfer: Transfer,
    action: "accept" | "reject" | "pause" | "resume" | "cancel",
    actorId: string,
  ) {
    if (
      (action === "accept" || action === "reject") &&
      (actorId !== transfer.recipientId || transfer.status !== "pending")
    )
      throw new Error("Only the recipient can approve a pending file.");
    if (action === "pause" && transfer.status !== "transferring")
      throw new Error("Transfer is not active.");
    if (action === "resume" && transfer.status !== "paused")
      throw new Error("Transfer is not paused.");
    if (action === "accept" && transfer.recipientId === this.socket.id) {
      const used =
        [...this.incoming.values()].reduce((sum, item) => sum + item.size, 0) +
        this.callbacks.receivedBytes();
      if (used + transfer.size > MAX_FILE_SIZE)
        throw new Error("Receive buffer is full. Remove a download first.");
      this.incoming.set(transfer.id, {
        chunks: [],
        offset: 0,
        size: transfer.size,
      });
    }
    transfer.status =
      action === "reject"
        ? "rejected"
        : action === "cancel"
          ? "cancelled"
          : action === "pause"
            ? "paused"
            : "transferring";
    if (action === "accept" && transfer.size === 0) {
      if (transfer.recipientId === this.socket.id)
        this.completeDownload(transfer);
      else {
        transfer.status = "completed";
        this.publish(transfer);
      }
    } else this.publish(transfer);
    if (
      transfer.senderId === this.socket.id &&
      transfer.status === "transferring"
    )
      void this.pump(transfer);
  }

  async control(
    id: string,
    action: "accept" | "reject" | "pause" | "resume" | "cancel",
  ) {
    const transfer = this.transfers.get(id);
    if (!transfer) throw new Error("Transfer is no longer active.");
    const peerId =
      transfer.senderId === this.socket.id
        ? transfer.recipientId
        : transfer.senderId;
    this.applyControl(transfer, action, this.socket.id!);
    try {
      await this.request(peerId, { event: "control", id, action });
    } catch (error) {
      if (this.transfers.has(id)) {
        transfer.status = "failed";
        this.publish(transfer);
      }
      throw error;
    }
  }

  private async pump(transfer: Transfer) {
    if (this.pumping.has(transfer.id)) return;
    this.pumping.add(transfer.id);
    try {
      const file = this.files.get(transfer.id);
      if (!file) throw new Error("Source file is unavailable.");
      // The channel is ordered and the receiver validates offsets in order, so a
      // bounded window of unacknowledged chunks is safe and avoids one round trip
      // per chunk. Progress only advances on acknowledgement.
      const inFlight: Promise<number>[] = [];
      let sent = transfer.offset;
      while (
        this.transfers.has(transfer.id) &&
        (inFlight.length > 0 ||
          (transfer.status === "transferring" && sent < file.size))
      ) {
        if (
          transfer.status === "transferring" &&
          sent < file.size &&
          inFlight.length < WINDOW
        ) {
          const offset = sent;
          const bytes = new Uint8Array(
            await file.slice(offset, offset + CHUNK).arrayBuffer(),
          );
          sent += bytes.length;
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          const acknowledged = this.request(transfer.recipientId, {
            event: "chunk",
            id: transfer.id,
            offset,
            data: btoa(binary),
          }).then(() => bytes.length);
          acknowledged.catch(() => {});
          inFlight.push(acknowledged);
          continue;
        }
        transfer.offset += await inFlight.shift()!;
        if (!this.transfers.has(transfer.id)) break;
        if (transfer.offset === file.size) transfer.status = "completed";
        this.publish(transfer);
      }
    } catch (error) {
      if (this.transfers.has(transfer.id)) {
        transfer.status = "failed";
        this.publish(transfer);
        this.callbacks.error(
          error instanceof Error ? error.message : "Direct transfer failed.",
        );
      }
    } finally {
      this.pumping.delete(transfer.id);
    }
  }

  private dropPeer(id: string, message: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    this.rates.delete(id);
    clearTimeout(peer.timer);
    peer.reject(new Error(message));
    peer.connection.onconnectionstatechange = null;
    if (peer.channel) peer.channel.onclose = null;
    peer.connection.close();
    for (const [requestId, pending] of this.pending)
      if (pending.peerId === id) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
        this.pending.delete(requestId);
      }
    for (const transfer of this.transfers.values())
      if ([transfer.senderId, transfer.recipientId].includes(id)) {
        transfer.status = "failed";
        this.publish(transfer);
      }
    if (!this.closed) this.callbacks.error(message);
  }

  close() {
    this.closed = true;
    for (const id of this.peers.keys())
      this.dropPeer(id, "Room connection ended. Send the file again.");
  }
}
