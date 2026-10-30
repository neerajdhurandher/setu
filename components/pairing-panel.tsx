"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, QrCode } from "lucide-react";
import { useSharing } from "@/hooks/use-sharing";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/dialog";

export function PairingPanel({ compact = false }: { compact?: boolean }) {
  const { addresses, preferences, transport, notify } = useSharing();
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
      notify("Wi-Fi address copied.");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not copy address.",
        "error",
      );
    }
  }

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
