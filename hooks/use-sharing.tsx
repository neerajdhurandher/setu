"use client";

import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { io, type Socket } from "socket.io-client";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { DirectSharing } from "@/lib/direct-sharing";
import * as Tooltip from "@radix-ui/react-tooltip";
import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  RETENTION_MS,
  type Activity,
  type Device,
  type Platform,
  type Reply,
  type ShareKind,
  type Transfer,
  type Welcome,
} from "@/lib/protocol";

export interface Preferences {
  name: string;
  theme: "dark" | "light" | "system";
  timeFormat: "12h" | "24h";
  pin: string;
  notifications: boolean;
}

interface SharingState {
  mode: "lan" | "public";
  configurationReady: boolean;
  roomExpiresAt: number | null;
  createRoom: () => Promise<void>;
  leaveRoom: () => Promise<void>;
  pairingOpen: boolean;
  setPairingOpen: (open: boolean) => void;
  selfId: string;
  devices: Device[];
  transfers: Transfer[];
  history: Activity[];
  addresses: string[];
  status: "connecting" | "online" | "offline";
  transport: "http" | "https" | null;
  error: string;
  preferences: Preferences;
  preferencesReady: boolean;
  downloads: Record<string, string>;
  controllingIds: Set<string>;
  notify: (message: string, tone?: "success" | "error") => void;
  sendFiles: (files: File[], recipientId: string) => Promise<void>;
  sendText: (
    content: string,
    recipientId: string,
    kind: Exclude<ShareKind, "file">,
  ) => Promise<void>;
  control: (
    id: string,
    action: "accept" | "reject" | "pause" | "resume" | "cancel",
  ) => Promise<void>;
  savePreferences: (preferences: Preferences) => Promise<void>;
  clearHistory: () => Promise<void>;
  releaseDownload: (id: string) => void;
}

const defaultPreferences: Preferences = {
  name: "My device",
  theme: "dark",
  timeFormat: "12h",
  pin: "",
  notifications: true,
};
const SharingContext = createContext<SharingState | null>(null);
const isActive = (transfer: Transfer) =>
  ["pending", "transferring", "paused"].includes(transfer.status);

function request<T = object>(
  socket: Socket,
  event: string,
  ...payload: unknown[]
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket.connected)
      return reject(new Error("Not connected to the local host."));
    socket
      .timeout(25_000)
      .emit(event, ...payload, (error: Error | null, reply: Reply<T>) => {
        if (error)
          reject(new Error("The host did not respond. Check your connection."));
        else if (!reply?.ok)
          reject(
            new Error(reply?.error ?? "The request could not be completed."),
          );
        else resolve(reply);
      });
  });
}

function identify(): { platform: Platform; os: string; name: string } {
  const agent = navigator.userAgent;
  if (
    /iPad/.test(agent) ||
    (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)
  )
    return { platform: "tablet", os: "iPadOS", name: "My iPad" };
  if (/iPhone/.test(agent))
    return { platform: "mobile", os: "iOS", name: "My iPhone" };
  if (/Android/.test(agent))
    return { platform: "mobile", os: "Android", name: "My Android" };
  if (/Mac/.test(agent))
    return { platform: "desktop", os: "macOS", name: "My Mac" };
  if (/Windows/.test(agent))
    return { platform: "desktop", os: "Windows", name: "My PC" };
  return { platform: "desktop", os: "Linux", name: "My computer" };
}

export function SharingProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<{
    mode: "lan" | "public";
    iceServers?: RTCIceServer[];
  } | null>(null);
  const [roomExpiresAt, setRoomExpiresAt] = useState<number | null>(null);
  const invitationRef = useRef<string | null>(null);
  const roomOwnerRef = useRef(false);
  const directHistoryLoaded = useRef(false);
  const directRef = useRef<DirectSharing | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [selfId, setSelfId] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [history, setHistory] = useState<Activity[]>([]);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [status, setStatus] = useState<SharingState["status"]>("connecting");
  const [transport, setTransport] = useState<SharingState["transport"]>(null);
  const [error, setError] = useState("");
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [downloads, setDownloads] = useState<Record<string, string>>({});
  const [controllingIds, setControllingIds] = useState<Set<string>>(new Set());
  const controlsInFlight = useRef(new Set<string>());
  const [toast, setToast] = useState<{
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const transferMap = useRef(new Map<string, Transfer>());
  const fileMap = useRef(new Map<string, File>());
  const incoming = useRef(
    new Map<string, { chunks: ArrayBuffer[]; offset: number; size: number }>(),
  );
  const urls = useRef(new Map<string, { url: string; size: number }>());
  const pumpRef = useRef<(id: string) => void>(() => {});

  function notify(message: string, tone: "success" | "error" = "success") {
    setToast({ message, tone });
  }

  async function createRoom() {
    const socket = socketRef.current;
    if (!socket) throw new Error("Not connected to the pairing server.");
    if (roomExpiresAt) await request(socket, "room:leave");
    directRef.current?.close();
    directRef.current = null;
    invitationRef.current = null;
    roomOwnerRef.current = false;
    setAddresses([]);
    setRoomExpiresAt(null);
    setDevices([]);
    const room = await request<{ invitation: string; expiresAt: number }>(
      socket,
      "room:create",
    );
    invitationRef.current = room.invitation;
    roomOwnerRef.current = true;
    setAddresses([`${location.origin}/#join=${room.invitation}`]);
    setRoomExpiresAt(room.expiresAt);
    setError("");
  }

  async function leaveRoom() {
    const socket = socketRef.current;
    if (!socket) throw new Error("Not connected to the pairing server.");
    await request(socket, "room:leave");
    directRef.current?.close();
    directRef.current = null;
    invitationRef.current = null;
    roomOwnerRef.current = false;
    setAddresses([]);
    setRoomExpiresAt(null);
    setDevices([]);
  }

  useEffect(() => {
    const controller = new AbortController();
    let initializing = false;
    let initialized = false;
    const schema = z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("lan") }),
      z.object({
        mode: z.literal("public"),
        iceServers: z
          .array(
            z.object({
              urls: z.union([
                z.string().regex(/^stuns?:/),
                z.array(z.string().regex(/^stuns?:/)),
              ]),
            }),
          )
          .max(8),
      }),
    ]);
    function initialize() {
      if (initializing || initialized) return;
      initializing = true;
      void fetch("/api/config", {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok)
            throw new Error("Cannot load sharing configuration.");
          const value = schema.parse(await response.json());
          if (value.mode === "public") {
            const invitation = new URLSearchParams(location.hash.slice(1)).get(
              "join",
            );
            if (invitation) {
              invitationRef.current = invitation;
              window.history.replaceState(null, "", location.pathname);
            }
            const session = await fetch("/api/session", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Setu-Request": "1",
              },
              body: "{}",
              cache: "no-store",
              signal: controller.signal,
            });
            if (!session.ok)
              throw new Error("Cannot establish an anonymous sharing session.");
          }
          initialized = true;
          setConfig(value);
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted) {
            setStatus("offline");
            setError(
              failure instanceof Error
                ? failure.message
                : "Cannot initialize sharing.",
            );
          }
        })
        .finally(() => {
          initializing = false;
        });
    }
    initialize();
    window.addEventListener("online", initialize);
    return () => {
      window.removeEventListener("online", initialize);
      controller.abort();
    };
  }, []);

  const storeDirectActivity = useEffectEvent((activity: Activity) => {
    setHistory((previous) => {
      const next = [
        activity,
        ...previous.filter(
          (item) =>
            item.id !== activity.id &&
            item.createdAt >= Date.now() - RETENTION_MS,
        ),
      ].slice(0, 200);
      return next;
    });
    if (
      preferences.notifications &&
      activity.direction === "received" &&
      activity.status === "completed"
    ) {
      setToast({
        message: `${activity.kind === "file" ? activity.name : "New " + activity.kind} received from ${activity.senderName}.`,
        tone: "success",
      });
    }
  });

  useEffect(() => {
    if (config?.mode !== "public" || !directHistoryLoaded.current) return;
    try {
      sessionStorage.setItem("setu.direct-history", JSON.stringify(history));
    } catch {
      queueMicrotask(() =>
        notify(
          "Browser history storage is full or unavailable. Activity will not survive reload.",
          "error",
        ),
      );
    }
  }, [history, config]);

  useEffect(() => {
    if (config?.mode !== "public") return;
    const timer = setInterval(() => {
      setHistory((previous) => {
        const next = previous.filter(
          (item) => item.createdAt >= Date.now() - RETENTION_MS,
        );
        return next.length === previous.length ? previous : next;
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, [config]);

  const announceReceived = useEffectEvent((activity: Activity) => {
    if (
      preferences.notifications &&
      activity.direction === "received" &&
      activity.status === "completed"
    ) {
      setToast({
        message: `${activity.kind === "file" ? activity.name : "New " + activity.kind} received from ${activity.senderName}.`,
        tone: "success",
      });
    }
  });

  const syncSystemTheme = useEffectEvent(() => {
    if (preferences.theme === "system") {
      document.documentElement.dataset.theme = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches
        ? "dark"
        : "light";
    }
  });

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", syncSystemTheme);
    return () => media.removeEventListener("change", syncSystemTheme);
  }, []);

  useEffect(() => {
    const identity = identify();
    let settings = { ...defaultPreferences, name: identity.name };
    try {
      const saved = JSON.parse(
        localStorage.getItem("setu.preferences") ?? "null",
      ) as Partial<Preferences> | null;
      if (saved)
        settings = {
          name:
            typeof saved.name === "string" && saved.name.trim()
              ? saved.name.slice(0, 40)
              : identity.name,
          theme:
            saved.theme === "light" || saved.theme === "system"
              ? saved.theme
              : "dark",
          timeFormat: saved.timeFormat === "24h" ? "24h" : "12h",
          pin:
            typeof saved.pin === "string" && /^(?:[0-9]{4,8})?$/.test(saved.pin)
              ? saved.pin
              : "",
          notifications: saved.notifications !== false,
        };
    } catch {
      queueMicrotask(() =>
        notify("Saved preferences are unavailable or invalid.", "error"),
      );
    }
    document.documentElement.dataset.theme =
      settings.theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : settings.theme;
    queueMicrotask(() => {
      setPreferences(settings);
      setPreferencesReady(true);
      setTransport(location.protocol === "https:" ? "https" : "http");
    });
  }, []);

  const getCurrentPreferences = useEffectEvent(() => preferences);

  useEffect(() => {
    if (!config || !preferencesReady) return;
    const identity = identify();
    const settings = getCurrentPreferences();
    let sessionId: string = uuid();
    try {
      const existing = sessionStorage.getItem("setu.session");
      if (existing && /^[0-9a-f-]{36}$/i.test(existing)) sessionId = existing;
      sessionStorage.setItem("setu.session", sessionId);
    } catch {
      queueMicrotask(() =>
        notify(
          "Browser session storage is unavailable. Session history may not persist.",
          "error",
        ),
      );
    }
    const socket = io({
      autoConnect: false,
      auth: { ...identity, name: settings.name, pin: settings.pin, sessionId },
    });
    socketRef.current = socket;
    const running = new Set<string>();

    async function pump(id: string) {
      if (running.has(id)) return;
      running.add(id);
      try {
        while (socket.connected) {
          const transfer = transferMap.current.get(id);
          const file = fileMap.current.get(id);
          if (
            !transfer ||
            !file ||
            transfer.status !== "transferring" ||
            transfer.offset >= file.size
          )
            break;
          const offset = transfer.offset;
          const data = await file
            .slice(offset, offset + CHUNK_SIZE)
            .arrayBuffer();
          if (transferMap.current.get(id)?.status !== "transferring") break;
          await request<{ offset: number }>(socket, "chunk", {
            id,
            offset,
            data,
          });
        }
      } catch (failure) {
        if (transferMap.current.get(id)?.status !== "paused") {
          setToast({
            message:
              failure instanceof Error ? failure.message : "Transfer failed.",
            tone: "error",
          });
          request(socket, "control", { id, action: "cancel" }).catch(() => {});
        }
      } finally {
        running.delete(id);
      }
    }
    pumpRef.current = (id) => {
      void pump(id);
    };

    const setupDirect = (devices: Device[]) => {
      if (!directRef.current)
        directRef.current = new DirectSharing(socket, config.iceServers ?? [], {
          transfer: (transfer) => {
            transferMap.current.set(transfer.id, transfer);
            if (transferMap.current.size > 200) {
              const oldest = [...transferMap.current.values()].find(
                (item) => !isActive(item),
              );
              if (oldest) transferMap.current.delete(oldest.id);
            }
            setTransfers(
              [...transferMap.current.values()].sort(
                (a, b) => b.createdAt - a.createdAt,
              ),
            );
          },
          activity: storeDirectActivity,
          download: (id, url, size) => {
            urls.current.set(id, { url, size });
            setDownloads((previous) => ({ ...previous, [id]: url }));
          },
          receivedBytes: () =>
            [...urls.current.values()].reduce(
              (sum, item) => sum + item.size,
              0,
            ),
          error: (message) => notify(message, "error"),
        });
      directRef.current.setDevices(devices);
    };
    socket.on("welcome", (welcome: Welcome) => {
      setSelfId(welcome.selfId);
      setDevices(welcome.devices);
      if (config.mode === "lan") {
        setHistory(welcome.history);
        setAddresses(welcome.addresses);
      } else {
        directRef.current?.close();
        directRef.current = null;
        setupDirect(welcome.devices);
        const activitySchema = z.object({
          id: z.uuid(),
          senderId: z.string(),
          recipientId: z.string(),
          senderName: z.string().max(40),
          recipientName: z.string().max(40),
          kind: z.enum(["file", "text", "link", "clipboard"]),
          name: z.string().max(255),
          size: z.number().nonnegative(),
          mime: z.string(),
          content: z
            .string()
            .max(64 * 1024)
            .optional(),
          offset: z.number().nonnegative(),
          status: z.enum(["completed", "failed", "cancelled", "rejected"]),
          createdAt: z.number(),
          direction: z.enum(["sent", "received"]),
        });
        try {
          const stored = z
            .array(activitySchema)
            .max(200)
            .parse(
              JSON.parse(sessionStorage.getItem("setu.direct-history") ?? "[]"),
            );
          setHistory(
            stored.filter(
              (item) => item.createdAt >= Date.now() - RETENTION_MS,
            ),
          );
        } catch {
          setHistory([]);
          notify("Stored browser history is unavailable or invalid.", "error");
        }
        directHistoryLoaded.current = true;
        const invitation = roomOwnerRef.current ? null : invitationRef.current;
        void (
          invitation
            ? request<{ expiresAt: number }>(socket, "room:join", {
                invitation,
              }).then((room) => {
                setRoomExpiresAt(room.expiresAt);
                setAddresses([`${location.origin}/#join=${invitation}`]);
              })
            : request<{ invitation: string; expiresAt: number }>(
                socket,
                "room:create",
              ).then((room) => {
                roomOwnerRef.current = true;
                invitationRef.current = room.invitation;
                setRoomExpiresAt(room.expiresAt);
                setAddresses([`${location.origin}/#join=${room.invitation}`]);
              })
        ).catch((failure: Error) => {
          setError(failure.message);
          setAddresses([]);
          setRoomExpiresAt(null);
        });
      }
      setStatus("online");
      setError("");
    });
    socket.on("devices", (value: Device[]) => {
      setDevices(value);
      if (config.mode === "public") setupDirect(value);
    });
    socket.on("peer:signal", (signal: unknown) => {
      void directRef.current?.receiveSignal(signal);
    });
    socket.on("room:ended", (value: { error: string }) => {
      directRef.current?.close();
      directRef.current = null;
      invitationRef.current = null;
      roomOwnerRef.current = false;
      setRoomExpiresAt(null);
      setAddresses([]);
      setDevices([]);
      setError(value.error);
    });
    socket.on("network-addresses", setAddresses);
    socket.on("history", setHistory);
    socket.on("activity", (activity: Activity) => {
      setHistory((previous) =>
        [activity, ...previous.filter((item) => item.id !== activity.id)].slice(
          0,
          200,
        ),
      );
      announceReceived(activity);
    });
    socket.on("transfer", (transfer: Transfer) => {
      transferMap.current.set(transfer.id, transfer);
      if (transferMap.current.size > 200) {
        const oldest = [...transferMap.current.values()].find(
          (item) => !isActive(item),
        );
        if (oldest) transferMap.current.delete(oldest.id);
      }
      setTransfers(
        [...transferMap.current.values()].sort(
          (first, second) => second.createdAt - first.createdAt,
        ),
      );
      if (transfer.status === "transferring" && transfer.senderId === socket.id)
        void pump(transfer.id);
      if (
        transfer.status === "completed" &&
        transfer.kind === "file" &&
        transfer.recipientId === socket.id
      ) {
        const buffer = incoming.current.get(transfer.id);
        if (buffer && buffer.offset === transfer.size) {
          const blob = new Blob(buffer.chunks, {
            type: "application/octet-stream",
          });
          const url = URL.createObjectURL(blob);
          urls.current.set(transfer.id, { url, size: transfer.size });
          setDownloads((previous) => ({ ...previous, [transfer.id]: url }));
          incoming.current.delete(transfer.id);
        }
      }
      if (!isActive(transfer)) {
        fileMap.current.delete(transfer.id);
        incoming.current.delete(transfer.id);
      }
    });
    socket.on(
      "chunk",
      (
        chunk: { id: string; offset: number; data: ArrayBuffer },
        ack: (reply: { ok: boolean }) => void,
      ) => {
        const buffer = incoming.current.get(chunk.id);
        if (
          !buffer ||
          buffer.offset !== chunk.offset ||
          !(chunk.data instanceof ArrayBuffer) ||
          buffer.offset + chunk.data.byteLength > buffer.size
        )
          return ack({ ok: false });
        buffer.chunks.push(chunk.data);
        buffer.offset += chunk.data.byteLength;
        ack({ ok: true });
      },
    );
    socket.on("connect_error", (failure: Error) => {
      setStatus("offline");
      setError(
        failure.message === "xhr poll error"
          ? config.mode === "public"
            ? "Cannot reach the pairing server. Reconnecting..."
            : "Cannot reach the local host. Reconnecting..."
          : failure.message,
      );
    });
    socket.on("disconnect", () => {
      directRef.current?.close();
      directRef.current = null;
      setStatus("offline");
      setDevices([]);
      for (const [id, transfer] of transferMap.current) {
        if (isActive(transfer))
          transferMap.current.set(id, { ...transfer, status: "failed" });
      }
      setTransfers([...transferMap.current.values()]);
      fileMap.current.clear();
      incoming.current.clear();
    });
    socket.connect();
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .then(() => navigator.serviceWorker.ready)
        .then((registration) => {
          const assets = performance
            .getEntriesByType("resource")
            .map((entry) => entry.name)
            .filter((name) =>
              name.startsWith(`${location.origin}/_next/static/`),
            );
          registration.active?.postMessage({
            type: "CACHE_ASSETS",
            urls: assets,
          });
        })
        .catch(() => {});
    }
    const objectUrls = urls.current;
    return () => {
      directRef.current?.close();
      directRef.current = null;
      socket.removeAllListeners();
      socket.disconnect();
      objectUrls.forEach((value) => URL.revokeObjectURL(value.url));
      objectUrls.clear();
    };
  }, [config, preferencesReady]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5500);
    return () => clearTimeout(timer);
  }, [toast]);

  async function sendFiles(files: File[], recipientId: string) {
    if (config?.mode === "public") {
      if (!directRef.current || !roomExpiresAt)
        throw new Error("Create or join a private room first.");
      await directRef.current.sendFiles(files, recipientId);
      notify("Direct file requests sent. Waiting for approval.");
      return;
    }
    if (!socketRef.current || !recipientId)
      throw new Error("Select a nearby device first.");
    if (
      !files.length ||
      files.length > 100 ||
      files.reduce((total, file) => total + file.size, 0) > MAX_FILE_SIZE
    ) {
      throw new Error(
        "Select up to 100 files, with a combined size of 1 GB or less.",
      );
    }
    for (const file of files) {
      const result = await request<{ transfer: Transfer }>(
        socketRef.current,
        "offer",
        {
          kind: "file",
          recipientId,
          name: (file.webkitRelativePath || file.name).slice(0, 255),
          size: file.size,
          mime: file.type,
        },
      );
      fileMap.current.set(result.transfer.id, file);
      pumpRef.current(result.transfer.id);
    }
    notify(
      `${files.length === 1 ? "File request" : files.length + " file requests"} sent. Waiting for approval.`,
    );
  }

  async function sendText(
    content: string,
    recipientId: string,
    kind: Exclude<ShareKind, "file">,
  ) {
    if (config?.mode === "public") {
      if (!directRef.current || !roomExpiresAt)
        throw new Error("Create or join a private room first.");
      await directRef.current.sendText(content, recipientId, kind);
      notify("Sent directly to the other device.");
      return;
    }
    if (!socketRef.current || !recipientId)
      throw new Error("Select a nearby device first.");
    await request(socketRef.current, "offer", { kind, content, recipientId });
    notify(
      `${kind === "link" ? "Link" : kind === "clipboard" ? "Clipboard" : "Text"} sent.`,
    );
  }

  async function control(
    id: string,
    action: "accept" | "reject" | "pause" | "resume" | "cancel",
  ) {
    if (controlsInFlight.current.has(id))
      throw new Error("An action is already in progress for this file.");
    controlsInFlight.current.add(id);
    setControllingIds(new Set(controlsInFlight.current));
    try {
      if (config?.mode === "public") {
        if (!directRef.current)
          throw new Error("Direct room connection is unavailable.");
        await directRef.current.control(id, action);
        return;
      }
      const transfer = transferMap.current.get(id);
      if (!socketRef.current || !transfer)
        throw new Error("The transfer is no longer available.");
      if (action === "accept") {
        const used =
          [...incoming.current.values()].reduce(
            (total, item) => total + item.size,
            0,
          ) +
          [...urls.current.values()].reduce(
            (total, item) => total + item.size,
            0,
          );
        if (used + transfer.size > MAX_FILE_SIZE)
          throw new Error(
            "Receive buffer is full. Remove a download before accepting more files.",
          );
        incoming.current.set(id, {
          chunks: [],
          offset: 0,
          size: transfer.size,
        });
      }
      await request(socketRef.current, "control", { id, action });
      if (action === "resume") pumpRef.current(id);
    } catch (failure) {
      if (config?.mode !== "public" && action === "accept")
        incoming.current.delete(id);
      throw failure;
    } finally {
      controlsInFlight.current.delete(id);
      setControllingIds(new Set(controlsInFlight.current));
    }
  }

  async function savePreferences(nextPreferences: Preferences) {
    const name = nextPreferences.name.trim();
    if (!name || name.length > 40)
      throw new Error("Device names must be between 1 and 40 characters.");
    if (!/^(?:[0-9]{4,8})?$/.test(nextPreferences.pin))
      throw new Error("Room PINs must be 4 to 8 digits, or empty.");
    const socket = socketRef.current;
    const next = { ...nextPreferences, name };
    if (config?.mode === "public" && next.pin !== preferences.pin)
      throw new Error("Public rooms use invitation links, not numeric PINs.");
    if (socket) {
      const previousAuth = socket.auth as Record<string, unknown>;
      if (next.pin !== preferences.pin || !socket.connected) {
        socket.auth = { ...previousAuth, name, pin: next.pin };
        socket.disconnect().connect();
      } else if (name !== preferences.name) {
        await request(socket, "rename", name);
        socket.auth = { ...previousAuth, name, pin: next.pin };
      }
    }
    try {
      localStorage.setItem("setu.preferences", JSON.stringify(next));
    } catch {
      throw new Error(
        "Browser storage is unavailable. Preferences will not persist after closing this tab.",
      );
    }
    document.documentElement.dataset.theme =
      next.theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : next.theme;
    setPreferences(next);
  }

  function releaseDownload(id: string) {
    const value = urls.current.get(id);
    if (value) URL.revokeObjectURL(value.url);
    urls.current.delete(id);
    setDownloads((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }

  async function clearHistory() {
    if (!socketRef.current) return;
    if (config?.mode === "public") {
      sessionStorage.removeItem("setu.direct-history");
      setHistory([]);
    } else await request(socketRef.current, "clear-history");
    for (const id of urls.current.keys()) releaseDownload(id);
    for (const [id, transfer] of transferMap.current)
      if (!isActive(transfer)) transferMap.current.delete(id);
    setTransfers([...transferMap.current.values()]);
    notify("History cleared.");
  }

  return (
    <SharingContext.Provider
      value={{
        mode: config?.mode ?? "lan",
        configurationReady: config !== null,
        roomExpiresAt,
        createRoom,
        leaveRoom,
        pairingOpen,
        setPairingOpen,
        selfId,
        devices,
        transfers,
        history,
        addresses,
        status,
        transport,
        error,
        preferences,
        preferencesReady,
        downloads,
        controllingIds,
        notify,
        sendFiles,
        sendText,
        control,
        savePreferences,
        clearHistory,
        releaseDownload,
      }}
    >
      <Tooltip.Provider delayDuration={200}>{children}</Tooltip.Provider>
      {toast && (
        <div
          className={`toast toast-${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          {toast.tone === "success" ? (
            <CheckCircle2 size={19} />
          ) : (
            <CircleAlert size={19} />
          )}
          <span>{toast.message}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </Button>
        </div>
      )}
    </SharingContext.Provider>
  );
}

export function useSharing() {
  const context = useContext(SharingContext);
  if (!context) throw new Error("useSharing requires SharingProvider");
  return context;
}
