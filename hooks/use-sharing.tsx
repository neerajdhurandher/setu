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
import * as Tooltip from "@radix-ui/react-tooltip";
import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
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
  downloads: Record<string, string>;
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
  const [downloads, setDownloads] = useState<Record<string, string>>({});
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
    let sessionId: string = uuid();
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
      const existing = sessionStorage.getItem("setu.session");
      if (existing && /^[0-9a-f-]{36}$/i.test(existing)) sessionId = existing;
      sessionStorage.setItem("setu.session", sessionId);
    } catch {
      sessionId = uuid();
    }
    document.documentElement.dataset.theme =
      settings.theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : settings.theme;
    queueMicrotask(() => {
      setPreferences(settings);
      setTransport(location.protocol === "https:" ? "https" : "http");
    });
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

    socket.on("welcome", (welcome: Welcome) => {
      setSelfId(welcome.selfId);
      setDevices(welcome.devices);
      setHistory(welcome.history);
      setAddresses(welcome.addresses);
      setStatus("online");
      setError("");
    });
    socket.on("devices", setDevices);
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
          ? "Cannot reach the local host. Reconnecting..."
          : failure.message,
      );
    });
    socket.on("disconnect", () => {
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
      socket.removeAllListeners();
      socket.disconnect();
      objectUrls.forEach((value) => URL.revokeObjectURL(value.url));
      objectUrls.clear();
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5500);
    return () => clearTimeout(timer);
  }, [toast]);

  async function sendFiles(files: File[], recipientId: string) {
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
    const transfer = transferMap.current.get(id);
    if (!socketRef.current || !transfer) return;
    try {
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
      if (action === "accept") incoming.current.delete(id);
      notify(
        failure instanceof Error ? failure.message : "Action failed.",
        "error",
      );
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
    try {
      localStorage.setItem("setu.preferences", JSON.stringify(next));
    } catch {
      setError(
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
    if (socket) {
      const previousAuth = socket.auth as Record<string, unknown>;
      socket.auth = { ...previousAuth, name, pin: next.pin };
      if (next.pin !== preferences.pin || !socket.connected) {
        socket.disconnect().connect();
      } else await request(socket, "rename", name);
    }
    notify("Preferences saved.");
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
    await request(socketRef.current, "clear-history");
    for (const id of urls.current.keys()) releaseDownload(id);
    for (const [id, transfer] of transferMap.current)
      if (!isActive(transfer)) transferMap.current.delete(id);
    setTransfers([...transferMap.current.values()]);
    notify("History cleared.");
  }

  return (
    <SharingContext.Provider
      value={{
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
        downloads,
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
