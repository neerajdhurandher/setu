"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, QrCode } from "lucide-react";
import { useSharing } from "@/hooks/use-sharing";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/dialog";

export function PairingPanel({ compact = false }: { compact?: boolean }) {
  const {
    addresses,
    preferences,
    transport,
    notify,
    mode,
    roomExpiresAt,
    createRoom,
    leaveRoom,
  } = useSharing();
  const [selectedAddress, setSelectedAddress] = useState("");
  const address = addresses.includes(selectedAddress)
    ? selectedAddress
    : addresses[0] || "";

  async function copyAddress() {
    try {
      if (!navigator.clipboard)
        throw new Error(
          "Clipboard access requires HTTPS or localhost in this browser.",
        );
      await navigator.clipboard.writeText(address);
      notify(
        mode === "public"
          ? "Private invitation copied. Share it only with intended participants."
          : "Wi-Fi address copied.",
      );
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not copy address.",
        "error",
      );
    }
  }

  if (mode === "public")
    return (
      <div className="pairing-panel">
        <h3 className="pairing-title">Your private sharing room</h3>
        <div className="qr-frame">
          {address ? (
            <QRCodeSVG
              value={address}
              size={compact ? 112 : 192}
              marginSize={1}
              title="Join this private Setu room"
            />
          ) : (
            <QrCode size={80} />
          )}
        </div>
        <div className="pairing-details">
          <div className="eyebrow">NO ACCOUNT. DIRECT SHARING.</div>
          {address && (
            <div className="pairing-address">
              <code>Private invitation ready</code>
              <Button variant="ghost" onClick={copyAddress}>
                Copy invitation
              </Button>
            </div>
          )}
          {roomExpiresAt && (
            <p>
              Room expires at {new Date(roomExpiresAt).toLocaleTimeString()}.
            </p>
          )}
          <ol className="pairing-steps">
            <li>Connect both devices to the same Wi-Fi.</li>
            <li>Scan this QR code or open the copied invitation.</li>
            <li>Choose the other device and approve incoming files.</li>
          </ol>
          <p className="connection-note">
            Files, text and clipboard travel directly between browsers over
            encrypted WebRTC. Oracle handles pairing only. No cloud file relay
            is used. Guest Wi-Fi isolation can prevent a direct connection.
            Anyone with this invitation can join until it expires.
          </p>
          <Button
            onClick={() => {
              void createRoom().catch((error: Error) =>
                notify(error.message, "error"),
              );
            }}
          >
            Create new room
          </Button>
          {roomExpiresAt && (
            <Button
              variant="outline"
              onClick={() => {
                void leaveRoom().catch((error: Error) =>
                  notify(error.message, "error"),
                );
              }}
            >
              Leave room
            </Button>
          )}
        </div>
      </div>
    );
  return (
    <div className={`pairing-panel ${compact ? "compact" : ""}`}>
      <h3 className="pairing-title">
        {compact ? "Room for one more." : "Your Wi-Fi address"}
      </h3>
      <div className="qr-frame">
        {address ? (
          <QRCodeSVG
            value={address}
            size={compact ? 112 : 192}
            marginSize={1}
            level="M"
            bgColor="#ffffff"
            fgColor="#1a1a1b"
            title="Join this Setu session"
          />
        ) : (
          <QrCode size={compact ? 54 : 120} strokeWidth={1} />
        )}
      </div>
      <div className="pairing-details">
        <div className="eyebrow">YOUR LOCAL SESSION</div>
        <span className="muted">
          {preferences.pin ? "PIN-protected room" : "Open local room"}
        </span>
        {addresses.length > 1 && !compact && (
          <select
            aria-label="Network interface"
            value={address}
            onChange={(event) => setSelectedAddress(event.target.value)}
          >
            {addresses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
        <div className="pairing-address">
          <code title={address || undefined}>
            {address
              ? address.replace("http://", "")
              : "No LAN address detected"}
          </code>
          <Tip label="Copy Wi-Fi address">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy Wi-Fi address"
              disabled={!address}
              onClick={copyAddress}
            >
              <Copy size={14} />
            </Button>
          </Tip>
        </div>
        {!compact && (
          <>
            <ol className="pairing-steps">
              <li>Join the same Wi-Fi.</li>
              <li>Scan this code or open the address.</li>
              <li>
                {preferences.pin
                  ? "Enter the same room PIN in Settings."
                  : "Keep both browser tabs open."}
              </li>
            </ol>
            <p className="connection-note">
              {transport === "https"
                ? "HTTPS protects this connection."
                : "HTTP is not encrypted. Use a trusted network."}{" "}
              A room PIN isolates discovery; it does not encrypt files.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
