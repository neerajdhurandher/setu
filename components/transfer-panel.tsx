"use client";

import { useState } from "react";
import {
  Check,
  Clipboard,
  Download,
  File,
  FileArchive,
  FileImage,
  FileText,
  Link2,
  Pause,
  Play,
  X,
} from "lucide-react";
import { useSharing } from "@/hooks/use-sharing";
import { formatBytes, type ShareKind, type Transfer } from "@/lib/protocol";
import { Button } from "@/components/ui/button";
import { Dialog, Tip } from "@/components/ui/dialog";

export function ShareIcon({
  kind,
  mime = "",
}: {
  kind: ShareKind;
  mime?: string;
}) {
  if (kind === "link") return <Link2 size={20} />;
  if (kind === "clipboard") return <Clipboard size={20} />;
  if (kind === "text") return <FileText size={20} />;
  if (mime.startsWith("image/")) return <FileImage size={20} />;
  if (/zip|archive|compressed/.test(mime)) return <FileArchive size={20} />;
  return <File size={20} />;
}

function TransferItem({ item }: { item: Transfer }) {
  const { selfId, control, downloads } = useSharing();
  const [busy, setBusy] = useState(false);
  const receiving = item.recipientId === selfId;
  const active = ["pending", "transferring", "paused"].includes(item.status);
  const progress = item.size ? Math.round((item.offset / item.size) * 100) : 0;
  const status =
    item.status === "pending"
      ? "Awaiting approval"
      : item.status === "transferring"
        ? `${formatBytes(item.offset)} / ${formatBytes(item.size)}`
        : item.status.charAt(0).toUpperCase() + item.status.slice(1);

  async function act(
    action: "accept" | "reject" | "pause" | "resume" | "cancel",
  ) {
    if (busy) return;
    setBusy(true);
    try {
      await control(item.id, action);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="transfer-item">
      <div className="item-icon kind-file">
        <ShareIcon kind="file" mime={item.mime} />
      </div>
      <div className="transfer-info">
        <strong>{item.name}</strong>
        <span>
          {receiving ? `From ${item.senderName}` : `To ${item.recipientName}`}
          <span className="inline-dot" />
          {formatBytes(item.size)}
        </span>
        <span role="status">{status}</span>
        {(item.status === "transferring" || item.status === "paused") && (
          <div
            className="progress-track"
            role="progressbar"
            aria-label={`${item.name} progress`}
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      <div className="transfer-actions">
        {item.status === "pending" && receiving ? (
          <>
            <Tip label="Reject transfer">
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={`Reject ${item.name}`}
                onClick={() => act("reject")}
              >
                <X size={17} />
              </Button>
            </Tip>
            <Button size="small" disabled={busy} onClick={() => act("accept")}>
              <Check size={15} /> Accept
            </Button>
          </>
        ) : active ? (
          <>
            {item.status !== "pending" && (
              <Tip
                label={
                  item.status === "paused"
                    ? "Resume transfer"
                    : "Pause transfer"
                }
              >
                <Button
                  variant="outline"
                  size="icon"
                  disabled={busy}
                  aria-label={`${item.status === "paused" ? "Resume" : "Pause"} ${item.name}`}
                  onClick={() =>
                    act(item.status === "paused" ? "resume" : "pause")
                  }
                >
                  {item.status === "paused" ? (
                    <Play size={16} />
                  ) : (
                    <Pause size={16} />
                  )}
                </Button>
              </Tip>
            )}
            <Tip label="Cancel transfer">
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={`Cancel ${item.name}`}
                onClick={() => act("cancel")}
              >
                <X size={16} />
              </Button>
            </Tip>
          </>
        ) : item.status === "completed" && downloads[item.id] ? (
          <Button size="small" asChild>
            <a
              href={downloads[item.id]}
              download={item.name.split(/[\\/]/).pop()}
              aria-label={`Download ${item.name}`}
            >
              <Download size={15} /> Download
            </a>
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function TransferQueue({ receivedOnly }: { receivedOnly: boolean }) {
  const { transfers, selfId } = useSharing();
  const active = transfers.filter(
    (item) =>
      ["pending", "transferring", "paused"].includes(item.status) &&
      (!receivedOnly || item.recipientId === selfId),
  );
  if (!active.length) return null;
  return (
    <section className="transfer-section">
      <div className="section-heading">
        <h2>
          In the moment <span className="count-label">{active.length}</span>
        </h2>
        <span className="eyebrow">ACTIVE TRANSFERS</span>
      </div>
      <div className="transfer-list">
        {active.map((item) => (
          <TransferItem key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

export function IncomingFilesDialog() {
  const { transfers, selfId } = useSharing();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const incoming = transfers.filter(
    (item) =>
      item.kind === "file" &&
      item.recipientId === selfId &&
      !dismissed.has(item.id),
  );
  const allCompleted =
    incoming.length > 0 &&
    incoming.every((item) => item.status === "completed");
  const active = incoming.some((item) =>
    ["pending", "transferring", "paused"].includes(item.status),
  );
  const plural = incoming.length > 1;
  const title = allCompleted
    ? plural
      ? "Files received"
      : "File received"
    : active
      ? plural
        ? "Incoming files"
        : "Incoming file"
      : plural
        ? "File transfers"
        : "File transfer";

  function close(open: boolean) {
    if (!open)
      setDismissed(
        (previous) =>
          new Set([...previous, ...incoming.map((item) => item.id)]),
      );
  }

  return (
    <Dialog
      open={incoming.length > 0}
      onOpenChange={close}
      title={title}
      description={
        incoming.length === 1
          ? `From ${incoming[0].senderName}`
          : `${incoming.length} incoming file transfers`
      }
    >
      <div className="transfer-list">
        {incoming.map((item) => (
          <TransferItem key={item.id} item={item} />
        ))}
      </div>
    </Dialog>
  );
}
