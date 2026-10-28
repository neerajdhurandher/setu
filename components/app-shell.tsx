"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowDownToLine,
  ArrowUpRight,
  CircleHelp,
  Command,
  History,
  LayoutGrid,
  Radio,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSharing } from "@/hooks/use-sharing";
import { Button } from "@/components/ui/button";
import { Dialog, Tip } from "@/components/ui/dialog";
import { IncomingFilesDialog } from "@/components/transfer-panel";

const navigation = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/send", label: "Send", icon: ArrowUpRight },
  { href: "/receive", label: "Receive", icon: ArrowDownToLine },
  { href: "/history", label: "History", icon: History },
];

export function SetuMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 26V15L14 10L23 15V26L14 31L5 26Z"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M17 25V14L26 9L35 14V25L26 30L17 25Z"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M14 20L26 19" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status, preferences, transfers, selfId, error } = useSharing();
  const [help, setHelp] = useState(false);
  const pending = transfers.filter(
    (item) => item.recipientId === selfId && item.status === "pending",
  ).length;
  const current =
    navigation.find((item) => item.href === pathname)?.label ?? "Settings";

  useEffect(() => {
    function navigate(event: KeyboardEvent) {
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !/^Digit[1-5]$/.test(event.code)
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select"))
      )
        return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      const routes = ["/", "/send", "/receive", "/history", "/settings"];
      router.push(routes[Number(event.code.slice(-1)) - 1]);
    }
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [router]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand" aria-label="Setu home">
          <SetuMark size={36} />
          <span>
            setu<span className="brand-dot">.</span>
          </span>
        </Link>
        <div className="workspace-label">
          YOUR WORKSPACE <span>01</span>
        </div>
        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map(({ href, label, icon: Icon }, index) => (
            <Link
              key={href}
              href={href}
              aria-label={label}
              aria-keyshortcuts={`Alt+${index + 1}`}
              title={`${label} (Alt+${index + 1})`}
              className={`nav-item ${pathname === href ? "active" : ""}`}
              aria-current={pathname === href ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {label === "Receive" && pending > 0 && (
                <span className="nav-count">{pending}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link
            href="/settings"
            title="Settings (Alt+5)"
            aria-keyshortcuts="Alt+5"
            className={`nav-item ${pathname === "/settings" ? "active" : ""}`}
          >
            <Settings2 size={19} />
            <span>Settings</span>
          </Link>
          <button
            className="nav-item help-button"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={19} />
            <span>Help & information</span>
            <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-foot">
            <span>SETU / v0.1.0</span>
            <ShieldCheck size={14} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <Link href="/" className="mobile-brand" aria-label="Setu home">
            <SetuMark size={26} />
            <span>
              setu<span className="brand-dot">.</span>
            </span>
          </Link>
          <div className="breadcrumb">
            <span>Workspace</span>
            <span className="slash">/</span>
            <strong>{current}</strong>
          </div>
          <div className="topbar-right">
            <span className="network-pill">
              <i className={`status-dot ${status}`} />
              {status === "online"
                ? "Local session"
                : status === "connecting"
                  ? "Connecting"
                  : "Offline"}
            </span>
            <span className="topbar-divider" />
            <Tip label="Device settings">
              <Link
                href="/settings"
                className="profile-avatar"
                aria-label="Device settings"
              >
                {preferences.name.slice(0, 2).toUpperCase()}
              </Link>
            </Tip>
          </div>
        </header>
        {error && (
          <div className="connection-error" role="alert">
            <Radio size={16} />
            <span>{error}</span>
            <Link href="/settings">
              Settings <ArrowUpRight size={14} />
            </Link>
          </div>
        )}
        <main id="main" className="main-content">
          {children}
        </main>
        <footer className="page-footer">
          <span>
            <ShieldCheck size={14} /> Your network. Your files. Your control.
          </span>
          <span>
            Made for the space between devices{" "}
            <span className="footer-mark">
              <SetuMark size={17} />
            </span>
          </span>
        </footer>
      </div>
      <Dialog
        open={help}
        onOpenChange={setHelp}
        title="About Setu"
        description="Local sharing, without a cloud account."
      >
        <div className="help-content">
          <p>
            Open the host&apos;s Wi-Fi address on another device connected to
            the same network. Devices with the same room PIN appear together.
          </p>
          <p>
            File transfers require approval. Keep both tabs open during a
            transfer. Files are relayed through the host without being saved to
            disk; downloads remain in this tab until it is closed or refreshed.
          </p>
          <p>
            Activity and shared text expire after 24 hours. HTTP traffic is not
            encrypted. Use a trusted network, or configure HTTPS for sensitive
            data, clipboard access, and PWA installation on mobile.
          </p>
          <div className="help-shortcut">
            <Command size={16} />
            <span>
              Setu is self-hosted and does not contact external services.
            </span>
          </div>
        </div>
        <Button variant="outline" onClick={() => setHelp(false)}>
          <X size={16} /> Close
        </Button>
      </Dialog>
      <IncomingFilesDialog />
    </div>
  );
}
