"use client";

import Link from "next/link";
import {
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowUp,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  Clipboard,
  Copy,
  Download,
  File,
  FileText,
  Folder,
  History,
  Inbox,
  Link2,
  Loader2,
  LockKeyhole,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  QrCode,
  Radio,
  Save,
  Search,
  ShieldCheck,
  Smartphone,
  Sun,
  Tablet,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import { useSharing, type Preferences } from "@/hooks/use-sharing";
import {
  formatBytes,
  isSafeLink,
  MAX_FILE_SIZE,
  type Activity,
  type Device,
} from "@/lib/protocol";
import { Button } from "@/components/ui/button";
import { Dialog, Tip } from "@/components/ui/dialog";
import { SetuMark } from "@/components/app-shell";
import { ShareIcon, TransferQueue } from "@/components/transfer-panel";
import { PairingPanel } from "@/components/pairing-panel";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);

type View = "overview" | "send" | "receive" | "history" | "settings";
const titles: Record<View, { title: string; subtitle: string }> = {
  overview: {
    title: "Your sharing space",
    subtitle: "Your local network, at a glance.",
  },
  send: {
    title: "Send something over",
    subtitle: "A new exchange between your devices.",
  },
  receive: {
    title: "Your inbox",
    subtitle: "Incoming files and new arrivals.",
  },
  history: {
    title: "A little history",
    subtitle: "Your exchanges from the last 24 hours.",
  },
  settings: {
    title: "Make yourself at home",
    subtitle: "Your device, your preferences.",
  },
};

function DeviceIcon({
  platform,
  size = 25,
}: {
  platform: Device["platform"];
  size?: number;
}) {
  const Icon =
    platform === "mobile"
      ? Smartphone
      : platform === "tablet"
        ? Tablet
        : Monitor;
  return <Icon size={size} strokeWidth={1.6} />;
}

async function copy(value: string) {
  if (!navigator.clipboard)
    throw new Error(
      "Clipboard access requires HTTPS or localhost in this browser.",
    );
  await navigator.clipboard.writeText(value);
}

export function WorkspaceView({ view }: { view: View }) {
  const { history, devices, selfId, status, setPairingOpen } = useSharing();
  const peers = devices.filter((device) => device.id !== selfId);
  const [recipientId, setRecipientId] = useState("");
  const completed = history.filter(
    (activity) => activity.status === "completed",
  );
  const bytes = completed
    .filter((activity) => activity.kind === "file")
    .reduce((total, activity) => total + activity.size, 0);
  return (
    <div className={`view-enter view-${view}`}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span className="tiny-square" />
            {view === "overview"
              ? "LOCAL. SIMPLE. CONNECTED."
              : `YOUR WORKSPACE / ${view.toUpperCase()}`}
          </div>
          <h1>
            {titles[view].title}
            <span className="heading-dot">.</span>
          </h1>
          <p>{titles[view].subtitle}</p>
        </div>
      </div>
      {view === "overview" && (
        <div className="overview-top">
          <div className="overview-summary">
            <div className="stats-strip">
              <div className="stat">
                <div className="stat-label">
                  <CheckCheck size={16} /> Completed shares
                </div>
                <div className="stat-value">
                  {completed.length}
                  <span>in the last 24 hours</span>
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">
                  <ArrowUpRight size={16} /> Data exchanged
                </div>
                <div className="stat-value">
                  {formatBytes(bytes).split(" ")[0]}
                  <span className="data-unit">
                    {formatBytes(bytes).split(" ")[1]}
                  </span>
                  <span className="local-only">
                    <LockKeyhole size={12} /> Local only
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="overview-pairing">
            <PairingPanel compact />
          </div>
        </div>
      )}
      {(view === "overview" || view === "send") && (
        <div className="sharing-grid">
          <section className="share-section">
            <div className="section-heading">
              <h2>
                Quick share <span className="section-index">01</span>
              </h2>
              <ArrowUpRight size={18} className="muted" />
            </div>
            <QuickShare
              recipientId={recipientId}
              onRecipientChange={setRecipientId}
            />
          </section>
          <section className="devices-section">
            <div className="section-heading">
              <h2>
                Nearby devices{" "}
                <span className="count-label">{peers.length}</span>
              </h2>
              <span className="live-indicator">
                <i className={`status-dot ${status}`} />{" "}
                {status === "online"
                  ? "Live"
                  : status === "connecting"
                    ? "Connecting"
                    : "Offline"}
              </span>
            </div>
            <DeviceList
              selected={recipientId}
              onSelect={setRecipientId}
              onPair={() => setPairingOpen(true)}
            />
            {view === "send" && <PairingPanel compact />}
          </section>
        </div>
      )}
      {(view === "overview" || view === "send" || view === "receive") && (
        <TransferQueue receivedOnly={view === "receive"} />
      )}
      {view === "receive" && (
        <div className="inbox-banner">
          <div className="inbox-symbol">
            <Inbox size={29} strokeWidth={1.4} />
            <i className={`status-dot ${status}`} />
          </div>
          <div>
            <h2>
              {status === "online"
                ? "Ready for what comes next"
                : "Waiting for a connection"}
            </h2>
            <p>
              {devices.find((device) => device.id === selfId)?.name ??
                "This device"}
              <span className="inline-dot" />
              {status === "online" ? "Available to nearby devices" : "Offline"}
            </p>
          </div>
          <span className="listening-tag">
            <Radio size={14} />
            {status === "online" ? "Listening" : "Reconnecting"}
          </span>
        </div>
      )}
      {(view === "overview" || view === "receive" || view === "history") && (
        <ActivityList
          full={view === "history"}
          receivedOnly={view === "receive"}
        />
      )}
      {view === "settings" && <SettingsFormWrapper />}
    </div>
  );
}

function DeviceList({
  selected,
  onSelect,
  onPair,
}: {
  selected: string;
  onSelect: (id: string) => void;
  onPair: () => void;
}) {
  const { devices, selfId, status, preferences } = useSharing();
  const peers = devices.filter((device) => device.id !== selfId);
  const self = devices.find((device) => device.id === selfId);
  return (
    <div className="device-list">
      <div className="device-card self-device">
        <div className="device-avatar">
          <DeviceIcon platform={self?.platform ?? "desktop"} />
        </div>
        <div className="device-details">
          <strong>{self?.name ?? preferences.name}</strong>
          <span>
            {self?.os ?? "Browser"}
            <span className="inline-dot" />
            This device
          </span>
        </div>
        <span className="self-tag">YOU</span>
      </div>
      {peers.map((device, index) => (
        <button
          key={device.id}
          className={`device-card peer-device ${selected === device.id ? "selected" : ""}`}
          onClick={() => onSelect(selected === device.id ? "" : device.id)}
          aria-pressed={selected === device.id}
        >
          <div className={`device-avatar device-color-${index % 3}`}>
            <DeviceIcon platform={device.platform} />
            <i className="status-dot online" />
          </div>
          <div className="device-details">
            <strong>{device.name}</strong>
            <span>
              {device.os}
              <span className="inline-dot" />
              Available
            </span>
          </div>
          <span className="device-check">
            {selected === device.id ? (
              <>
                <Check size={17} />
                <span>Selected</span>
              </>
            ) : (
              <ArrowUpRight size={17} />
            )}
          </span>
        </button>
      ))}
      {!peers.length && (
        <div className="device-empty">
          <div
            className={`discovery-mark ${status === "online" ? "discovering" : ""}`}
          >
            <Radio size={23} strokeWidth={1.5} />
          </div>
          <strong>
            {status === "online"
              ? "A little quiet around here"
              : "Finding your network"}
          </strong>
          <span>
            {status === "online"
              ? "No other devices connected yet"
              : "Connecting to your local host"}
          </span>
          <Button variant="outline" size="small" onClick={onPair}>
            <QrCode size={16} /> Open pairing
          </Button>
          <details className="connection-checklist">
            <summary>Connection checklist</summary>
            <p>
              Use the same Wi-Fi and room PIN. Avoid guest-network isolation.
              Allow Node.js incoming connections in the host firewall.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}

function QuickShare({
  recipientId,
  onRecipientChange,
}: {
  recipientId: string;
  onRecipientChange: (id: string) => void;
}) {
  const { devices, selfId, status, sendFiles, sendText, notify } = useSharing();
  const formId = useId();
  const [mode, setMode] = useState<"file" | "text" | "link">("file");
  const [files, setFiles] = useState<File[]>([]);
  const [content, setContent] = useState("");
  const [link, setLink] = useState("");
  const [isClipboard, setIsClipboard] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const peers = devices.filter((device) => device.id !== selfId);
  const recipient = peers.some((device) => device.id === recipientId)
    ? recipientId
    : "";
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const selectedDevice = peers.find((device) => device.id === recipient);
  const disabledReason = busy
    ? "Sending..."
    : status !== "online"
      ? "Waiting for connection"
      : !recipient
        ? "Choose a device"
        : mode === "file" && !files.length
          ? "Add files"
          : mode === "text" && !content.trim()
            ? "Enter text to share"
            : mode === "link" && !isSafeLink(link)
              ? "Enter a valid HTTP or HTTPS link"
              : "";
  function addFiles(next: File[]) {
    const combined = [...files, ...next];
    if (
      combined.length > 100 ||
      combined.reduce((sum, file) => sum + file.size, 0) > MAX_FILE_SIZE
    )
      return notify(
        "Select up to 100 files, with a combined size of 1 GB or less.",
        "error",
      );
    setFiles(combined);
  }
  async function pasteClipboard() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      setContent(await navigator.clipboard.readText());
      setIsClipboard(true);
    } catch {
      notify(
        "Clipboard unavailable. Allow clipboard access over HTTPS, or paste into the text field.",
        "error",
      );
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === "file") {
        await sendFiles(files, recipient);
        setFiles([]);
      } else {
        await sendText(
          mode === "link" ? link : content,
          recipient,
          mode === "link" ? "link" : isClipboard ? "clipboard" : "text",
        );
        if (mode === "link") setLink("");
        else setContent("");
      }
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not send this share.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="quick-share" onSubmit={submit}>
      <div className="share-tabs" role="tablist" aria-label="Share type">
        {(
          [
            { value: "file", label: "Files", icon: Folder },
            { value: "text", label: "Text", icon: FileText },
            { value: "link", label: "Link", icon: Link2 },
          ] as const
        ).map(({ value, label, icon: Icon }, index) => (
          <button
            key={value}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            id={`${formId}-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={mode === value}
            aria-controls={`${formId}-panel`}
            tabIndex={mode === value ? 0 : -1}
            className={mode === value ? "selected" : ""}
            onClick={() => setMode(value)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 2
                    : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
              tabRefs.current[next]?.click();
              tabRefs.current[next]?.focus();
            }}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div
        id={`${formId}-panel`}
        role="tabpanel"
        aria-labelledby={`${formId}-tab-${mode}`}
        className="share-panel"
      >
        {mode === "file" ? (
          <>
            <div
              className={`drop-zone ${dragging ? "dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                addFiles(Array.from(event.dataTransfer.files));
              }}
            >
              <div className="upload-symbol">
                <Folder size={43} strokeWidth={1.2} />
                <span>
                  <ArrowUpRight size={16} />
                </span>
              </div>
              <h3>
                {dragging
                  ? "Right here is perfect."
                  : "Drop it like it's local."}
              </h3>
              <p>
                Drag files here, or{" "}
                <button
                  type="button"
                  className="inline-action"
                  onClick={() => fileInput.current?.click()}
                >
                  browse files <ArrowUpRight size={12} />
                </button>
              </p>
              <span className="file-limit">
                ANY FILE TYPE <span>/</span> UP TO 1 GB
              </span>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="sr-only"
                aria-label="Select files"
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <input
                ref={folderInput}
                type="file"
                multiple
                {...{ webkitdirectory: "", directory: "" }}
                className="sr-only"
                aria-label="Select folder"
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </div>
            {files.length ? (
              <div className="queued-files">
                {files.map((file, index) => (
                  <div className="queued-file" key={`${file.name}-${index}`}>
                    <File size={16} />
                    <span>{file.webkitRelativePath || file.name}</span>
                    <small>{formatBytes(file.size)}</small>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setFiles((previous) =>
                          previous.filter((_, position) => position !== index),
                        )
                      }
                    >
                      <X size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="file-options">
              <span>
                <ShieldCheck size={14} /> Approval required
              </span>
              <button
                type="button"
                onClick={() => folderInput.current?.click()}
              >
                <Folder size={14} /> Add a folder <Plus size={12} />
              </button>
            </div>
          </>
        ) : mode === "text" ? (
          <div className="text-composer">
            <div className="composer-label">
              <label htmlFor={`${formId}-text`}>
                {isClipboard ? "Clipboard" : "Text or code"}
              </label>
              <Tip label="Paste clipboard">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Paste clipboard"
                  onClick={pasteClipboard}
                >
                  <Clipboard size={16} />
                </Button>
              </Tip>
            </div>
            <textarea
              id={`${formId}-text`}
              maxLength={65536}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setIsClipboard(false);
              }}
              placeholder="A thought, a note, a snippet..."
            />
            <div className="composer-count">
              {content.length.toLocaleString()} / 65,536 characters
            </div>
          </div>
        ) : (
          <div className="link-composer">
            <div className="link-symbol">
              <Link2 size={31} strokeWidth={1.5} />
            </div>
            <label htmlFor={`${formId}-link`}>A link worth sharing</label>
            <input
              id={`${formId}-link`}
              type="url"
              maxLength={65536}
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://"
            />
            <span className="muted">
              {isSafeLink(link)
                ? new URL(link).hostname
                : "HTTP and HTTPS links"}
            </span>
          </div>
        )}
      </div>
      <div className="share-bottom">
        <div className="recipient-field">
          <label htmlFor={`${formId}-recipient`}>SEND TO</label>
          <div className="select-wrap">
            <Monitor size={15} />
            <select
              id={`${formId}-recipient`}
              value={recipient}
              onChange={(event) => onRecipientChange(event.target.value)}
            >
              <option value="">
                {peers.length ? "Select a device" : "No nearby devices"}
              </option>
              {peers.map((device) => (
                <option value={device.id} key={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </div>
        </div>
        <Button
          type="submit"
          disabled={Boolean(disabledReason)}
          aria-describedby={`${formId}-send-status`}
        >
          <span>
            {mode === "file" && files.length
              ? `Send ${files.length} ${files.length === 1 ? "file" : "files"}`
              : "Send over"}
          </span>
          {busy ? (
            <Loader2 className="spin" size={16} aria-hidden="true" />
          ) : (
            <ArrowRight size={18} aria-hidden="true" />
          )}
        </Button>
        <p className="send-status" id={`${formId}-send-status`} role="status">
          {disabledReason || `Ready to send to ${selectedDevice?.name}`}
        </p>
      </div>
      {files.length > 0 && mode === "file" && (
        <div className="queue-summary">
          {files.length} selected<span>{formatBytes(total)}</span>
        </div>
      )}
    </form>
  );
}

function ActivityList({
  full,
  receivedOnly,
}: {
  full: boolean;
  receivedOnly: boolean;
}) {
  const {
    history,
    downloads,
    clearHistory,
    notify,
    releaseDownload,
    preferences,
  } = useSharing();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Activity | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("newest");
  const deferredQuery = useDeferredValue(query);
  const filtered = history
    .filter(
      (item) =>
        (!receivedOnly || item.direction === "received") &&
        (filter === "all" || item.direction === filter) &&
        (kindFilter === "all" || item.kind === kindFilter) &&
        (statusFilter === "all" || item.status === statusFilter) &&
        `${item.name} ${item.senderName} ${item.recipientName} ${item.kind}`
          .toLowerCase()
          .includes(deferredQuery.toLowerCase()),
    )
    .sort((first, second) =>
      sort === "oldest"
        ? first.createdAt - second.createdAt
        : sort === "name-asc"
          ? first.name.localeCompare(second.name)
          : sort === "name-desc"
            ? second.name.localeCompare(first.name)
            : second.createdAt - first.createdAt,
    );
  const visible = full || receivedOnly ? filtered : filtered.slice(0, 5);
  async function copyContent(content: string) {
    try {
      await copy(content);
      notify("Copied to clipboard.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Copy failed.", "error");
    }
  }
  async function clear() {
    setClearing(true);
    try {
      await clearHistory();
      setConfirmClear(false);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not clear history.",
        "error",
      );
    } finally {
      setClearing(false);
    }
  }
  return (
    <section className="activity-section">
      <div className="section-heading">
        <h2>
          {receivedOnly
            ? "Recent arrivals"
            : full
              ? "All activity"
              : "Recent activity"}
          <span className="section-index">
            {full ? `${history.length}` : "02"}
          </span>
        </h2>
        {full ? (
          <Button
            variant="ghost"
            size="small"
            disabled={!history.length}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 size={15} /> Clear history
          </Button>
        ) : (
          !receivedOnly && (
            <Link className="text-link" href="/history">
              View all activity <ArrowUpRight size={15} />
            </Link>
          )
        )}
      </div>
      <div className="activity-toolbar">
        {!receivedOnly && (
          <div
            className="filter-tabs"
            role="group"
            aria-label="Activity direction"
          >
            {[
              ["all", "All activity"],
              ["sent", "Sent"],
              ["received", "Received"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={filter === value ? "selected" : ""}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="search-field">
          <Search size={15} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search activity..."
            aria-label="Search activity"
          />
        </div>
      </div>
      {full && (
        <div className="history-filters">
          <label>
            Type
            <select
              aria-label="Activity type"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value)}
            >
              <option value="all">All types</option>
              <option value="file">Files</option>
              <option value="text">Text</option>
              <option value="link">Links</option>
              <option value="clipboard">Clipboard</option>
            </select>
          </label>
          <label>
            Status
            <select
              aria-label="Transfer status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label>
            Sort
            <select
              aria-label="Sort activity"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name-asc">Name A-Z</option>
              <option value="name-desc">Name Z-A</option>
            </select>
          </label>
        </div>
      )}
      <div className="activity-table-wrap">
        <table className="activity-table" role="table">
          <thead>
            <tr>
              <th
                aria-sort={
                  sort === "name-asc"
                    ? "ascending"
                    : sort === "name-desc"
                      ? "descending"
                      : "none"
                }
              >
                <button
                  className="table-sort"
                  onClick={() =>
                    setSort(sort === "name-asc" ? "name-desc" : "name-asc")
                  }
                >
                  NAME{" "}
                  {sort === "name-asc" ? (
                    <ArrowUp size={12} />
                  ) : (
                    <ArrowDown size={12} />
                  )}
                </button>
              </th>
              <th className="type-column">TYPE</th>
              <th>DEVICE</th>
              <th
                className="date-column"
                aria-sort={
                  sort === "newest"
                    ? "descending"
                    : sort === "oldest"
                      ? "ascending"
                      : "none"
                }
              >
                <button
                  className="table-sort"
                  onClick={() =>
                    setSort(sort === "newest" ? "oldest" : "newest")
                  }
                >
                  TIME{" "}
                  {sort === "oldest" ? (
                    <ArrowUp size={12} />
                  ) : (
                    <ArrowDown size={12} />
                  )}
                </button>
              </th>
              <th>STATUS</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.id}>
                <td>
                  <button
                    className="activity-name"
                    onClick={() => setSelected(item)}
                  >
                    <span className={`item-icon kind-${item.kind}`}>
                      <ShareIcon kind={item.kind} mime={item.mime} />
                    </span>
                    <span>
                      <strong>
                        {item.kind === "file"
                          ? item.name
                          : item.kind === "link" &&
                              isSafeLink(item.content ?? "")
                            ? new URL(item.content!).hostname
                            : item.name}
                        <span className="sr-only"> details</span>
                      </strong>
                      <small>
                        {item.kind === "file"
                          ? formatBytes(item.size)
                          : item.kind === "clipboard"
                            ? "Clipboard snippet"
                            : item.kind === "link"
                              ? "Web link"
                              : "Text snippet"}
                      </small>
                    </span>
                  </button>
                </td>
                <td className="type-column">
                  <span className="type-tag">
                    {item.kind === "file"
                      ? (item.name
                          .split(".")
                          .pop()
                          ?.slice(0, 7)
                          .toUpperCase() ?? "FILE")
                      : item.kind.toUpperCase()}
                  </span>
                </td>
                <td>
                  <span className="activity-device">
                    {item.direction === "sent" ? (
                      <ArrowUpRight size={13} />
                    ) : (
                      <ArrowDownLeft size={13} />
                    )}
                    <span>
                      <span className="activity-direction">
                        {item.direction === "sent" ? "To " : "From "}
                      </span>
                      {item.direction === "sent"
                        ? item.recipientName
                        : item.senderName}
                    </span>
                  </span>
                </td>
                <td className="date-column">
                  <time dateTime={new Date(item.createdAt).toISOString()}>
                    {new Date(item.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: preferences.timeFormat === "12h",
                    })}
                  </time>
                </td>
                <td>
                  <span
                    className={`status-label ${item.status === "completed" ? "success" : "failure"}`}
                  >
                    {item.status === "completed" ? (
                      <Check size={12} />
                    ) : (
                      <X size={12} />
                    )}
                    {item.status === "completed" ? "Completed" : item.status}
                  </span>
                  {item.kind === "file" &&
                    item.direction === "received" &&
                    item.status === "completed" && (
                      <span
                        className={`download-availability ${downloads[item.id] ? "available" : "unavailable"}`}
                      >
                        {downloads[item.id]
                          ? "Download available"
                          : "Not stored in this tab"}
                      </span>
                    )}
                  {item.status === "failed" && (
                    <span className="download-availability">
                      Interrupted. Reconnect and resend.
                    </span>
                  )}
                  {item.status === "rejected" && (
                    <span className="download-availability">
                      Declined by recipient.
                    </span>
                  )}
                  {item.status === "cancelled" && (
                    <span className="download-availability">
                      Transfer was cancelled.
                    </span>
                  )}
                </td>
                <td>
                  <div className="row-actions">
                    {downloads[item.id] ? (
                      <Tip label="Download file">
                        <Button variant="ghost" size="icon" asChild>
                          <a
                            href={downloads[item.id]}
                            download={item.name.split(/[\\/]/).pop()}
                            aria-label={`Download ${item.name}`}
                          >
                            <Download size={16} />
                          </a>
                        </Button>
                      </Tip>
                    ) : item.content ? (
                      <Tip label="Copy content">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Copy ${item.kind}`}
                          onClick={() => copyContent(item.content!)}
                        >
                          <Copy size={15} />
                        </Button>
                      </Tip>
                    ) : (
                      <Tip label="Transfer details">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Details for ${item.name}`}
                          onClick={() => setSelected(item)}
                        >
                          <MoreHorizontal size={17} />
                        </Button>
                      </Tip>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (
          <div className="activity-empty">
            <div className="empty-icon">
              {query ? (
                <Search size={24} strokeWidth={1.4} />
              ) : receivedOnly ? (
                <Inbox size={24} strokeWidth={1.4} />
              ) : (
                <History size={24} strokeWidth={1.4} />
              )}
            </div>
            <strong>
              {query
                ? "Nothing by that name"
                : filter !== "all"
                  ? `No ${filter} shares yet`
                  : "A fresh start"}
            </strong>
            <span>
              {query
                ? "No activity matches your search"
                : receivedOnly
                  ? "No received shares yet"
                  : "No exchanges yet"}
            </span>
          </div>
        )}
      </div>
      <p className="history-retention-note">
        File contents stay in the receiving tab only. Reloading removes
        downloads, not the transfer record.
      </p>
      <div className="activity-foot">
        <span>
          {full
            ? `${filtered.length} ${filtered.length === 1 ? "exchange" : "exchanges"}`
            : "Your local activity"}
        </span>
        <span>
          <History size={12} /> Expires after 24 hours
        </span>
      </div>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={
          selected?.kind === "file"
            ? "Transfer details"
            : selected?.kind === "link"
              ? "Shared link"
              : "Shared snippet"
        }
        description={
          selected
            ? `${selected.direction === "sent" ? "To " + selected.recipientName : "From " + selected.senderName}`
            : "Activity"
        }
      >
        {selected && (
          <div className="activity-detail">
            {selected.content ? (
              selected.kind === "link" && isSafeLink(selected.content) ? (
                <a
                  className="shared-link"
                  href={selected.content}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Link2 size={20} />
                  <span>{selected.content}</span>
                  <ArrowUpRight size={17} />
                </a>
              ) : (
                <pre className="code-block">
                  <code
                    dangerouslySetInnerHTML={{
                      __html: hljs.highlightAuto(
                        selected.content.slice(0, 16000),
                      ).value,
                    }}
                  />
                </pre>
              )
            ) : (
              <div className="file-detail">
                <span className="item-icon kind-file">
                  <ShareIcon kind="file" mime={selected.mime} />
                </span>
                <strong>{selected.name}</strong>
                <span className="muted">
                  {formatBytes(selected.size)}
                  <span className="inline-dot" />
                  {selected.status}
                </span>
              </div>
            )}
            <div className="detail-actions">
              {selected.content && (
                <Button
                  variant="outline"
                  onClick={() => copyContent(selected.content!)}
                >
                  <Copy size={15} /> Copy content
                </Button>
              )}
              {downloads[selected.id] ? (
                <>
                  <Button asChild>
                    <a
                      href={downloads[selected.id]}
                      download={selected.name.split(/[\\/]/).pop()}
                    >
                      <Download size={16} /> Download
                    </a>
                  </Button>
                  <Tip label="Remove buffered download">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove buffered download"
                      onClick={() => releaseDownload(selected.id)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </Tip>
                </>
              ) : (
                selected.kind === "file" &&
                selected.direction === "received" && (
                  <span className="muted">
                    Download unavailable in this tab. The file was not saved on
                    the host; ask the sender to send it again.
                  </span>
                )
              )}
            </div>
            {selected.status === "failed" && (
              <p className="connection-note">
                This transfer was interrupted. Reconnect both devices and send
                the file again.
              </p>
            )}
            {selected.status !== "completed" &&
              selected.direction === "sent" && (
                <Button variant="outline" asChild>
                  <Link href="/send" onClick={() => setSelected(null)}>
                    <ArrowRight size={16} /> Send again
                  </Link>
                </Button>
              )}
          </div>
        )}
      </Dialog>
      <Dialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear the slate?"
        description="Your activity and buffered downloads in this tab will be removed. Other devices keep their own history."
      >
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => setConfirmClear(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={clearing} onClick={clear}>
            {clearing ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Trash2 size={16} />
            )}{" "}
            Clear history
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function SettingsFormWrapper() {
  const { preferences } = useSharing();
  return (
    <SettingsForm key={JSON.stringify(preferences)} initial={preferences} />
  );
}

function SettingsForm({ initial }: { initial: Preferences }) {
  const { savePreferences, notify, addresses, transfers, status, transport } =
    useSharing();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const preview = () => {
      document.documentElement.dataset.theme =
        form.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : form.theme;
    };
    preview();
    media.addEventListener("change", preview);
    return () => {
      media.removeEventListener("change", preview);
      document.documentElement.dataset.theme =
        initial.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : initial.theme;
    };
  }, [form.theme, initial.theme]);
  useEffect(() => {
    if (!dirty) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      if (
        form.pin !== initial.pin &&
        transfers.some((item) =>
          ["pending", "transferring", "paused"].includes(item.status),
        )
      )
        throw new Error(
          "Finish or cancel active transfers before changing rooms.",
        );
      await savePreferences(form);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not save preferences.",
        "error",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="settings-form" onSubmit={submit}>
      <section className="settings-section">
        <div className="settings-section-heading">
          <Monitor size={20} />
          <div>
            <h2>Your device</h2>
            <span className="muted">Identity on this network</span>
          </div>
        </div>
        <div className="settings-fields">
          <label htmlFor="device-name">Device name</label>
          <input
            id="device-name"
            value={form.name}
            maxLength={40}
            required
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            autoComplete="off"
          />
          <span className="input-hint">{form.name.length} / 40</span>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section-heading">
          <Sun size={20} />
          <div>
            <h2>Appearance</h2>
            <span className="muted">A different point of view</span>
          </div>
        </div>
        <div className="settings-fields">
          <label>Theme</label>
          <div className="theme-switch" role="group" aria-label="Theme">
            {(["dark", "light", "system"] as const).map((theme) => (
              <button
                key={theme}
                type="button"
                aria-pressed={form.theme === theme}
                className={form.theme === theme ? "selected" : ""}
                onClick={() => setForm({ ...form, theme })}
              >
                {theme === "dark" ? (
                  <Moon size={17} />
                ) : theme === "light" ? (
                  <Sun size={17} />
                ) : (
                  <Monitor size={17} />
                )}
                {theme === "dark"
                  ? "Dark"
                  : theme === "light"
                    ? "Light"
                    : "System"}
              </button>
            ))}
          </div>
          <div className="time-format-field">
            <span>Time format</span>
            <div
              className="theme-switch time-format-switch"
              role="group"
              aria-label="Time format"
            >
              {(["12h", "24h"] as const).map((timeFormat) => (
                <button
                  key={timeFormat}
                  type="button"
                  aria-pressed={form.timeFormat === timeFormat}
                  className={form.timeFormat === timeFormat ? "selected" : ""}
                  onClick={() => setForm({ ...form, timeFormat })}
                >
                  {timeFormat === "12h" ? "12-hour" : "24-hour"}
                  {form.timeFormat === timeFormat && <Check size={15} />}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section-heading">
          <LockKeyhole size={20} />
          <div>
            <h2>Room & privacy</h2>
            <span className="muted">An optional shared PIN</span>
          </div>
        </div>
        <div className="settings-fields">
          <label htmlFor="room-pin">Room PIN</label>
          <input
            id="room-pin"
            value={form.pin}
            type="password"
            inputMode="numeric"
            maxLength={8}
            pattern="[0-9]{4,8}"
            placeholder="No PIN - open local room"
            autoComplete="off"
            onChange={(event) =>
              setForm({ ...form, pin: event.target.value.replace(/\D/g, "") })
            }
          />
          <span className="input-hint">
            4-8 digits, or leave empty for the open room
          </span>
          <div className="security-note">
            <ShieldCheck size={17} />
            <span>
              {form.pin
                ? "PIN-protected discovery"
                : "Local-network-only discovery"}
              <small>
                A room PIN is not encryption. File transfers always require
                approval.
              </small>
            </span>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section-heading">
          <Radio size={20} />
          <div>
            <h2>Notifications</h2>
            <span className="muted">New arrivals</span>
          </div>
        </div>
        <div className="settings-fields">
          <label className="toggle-field" htmlFor="notifications">
            <span>Received share notifications</span>
            <input
              id="notifications"
              type="checkbox"
              role="switch"
              checked={form.notifications}
              onChange={(event) =>
                setForm({ ...form, notifications: event.target.checked })
              }
            />
            <span className="toggle-track" aria-hidden="true" />
          </label>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section-heading">
          <Wifi size={20} />
          <div>
            <h2>Network</h2>
            <span className="muted">Current host addresses</span>
          </div>
        </div>
        <div className="settings-fields">
          <span className="network-detail-status">
            <i className={`status-dot ${status}`} />
            {status === "online"
              ? "Connected to local host"
              : "Host unavailable"}
          </span>
          {addresses.map((address) => (
            <div className="network-address" key={address}>
              <code>{address}</code>
              <Tip label="Copy network address">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Copy ${address}`}
                  onClick={async () => {
                    try {
                      await copy(address);
                      notify("Address copied.");
                    } catch {
                      notify(
                        "Clipboard access requires HTTPS or localhost.",
                        "error",
                      );
                    }
                  }}
                >
                  <Copy size={15} />
                </Button>
              </Tip>
            </div>
          ))}
          <span className="input-hint">
            {addresses.length
              ? transport === "https"
                ? "HTTPS - encrypted connection to the host"
                : "HTTP - unencrypted local connection"
              : "No local network interface detected"}
          </span>
        </div>
      </section>
      <div className="settings-save">
        <span aria-live="polite" className={dirty ? "unsaved-indicator" : ""}>
          <SetuMark size={20} />{" "}
          {dirty ? "Unsaved changes" : "All changes saved"}
        </span>
        {dirty && (
          <Button
            variant="ghost"
            type="button"
            onClick={() => setForm(initial)}
          >
            Reset
          </Button>
        )}
        <Button disabled={saving || !dirty} type="submit">
          {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}{" "}
          Save preferences
        </Button>
      </div>
    </form>
  );
}
