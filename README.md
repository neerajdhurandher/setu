# Setu

A sharing app built with Next.js, React, TypeScript, Tailwind CSS, Radix primitives, Socket.IO, and WebRTC. No accounts are required. LAN mode relays content through your local host and uses SQLite; public mode uses a signaling-only server, direct browser-to-browser content, and browser-tab history.

## Run Locally

Requires **Node.js 24+** and npm. Node's built-in SQLite is used for activity history.

```bash
npm install
npm run dev
```

Open http://localhost:3000. The terminal prints the host's LAN addresses. Open one of those addresses on another device connected to the same Wi-Fi, or scan the QR code. Discovery lists **browsers connected to this host**, not every device on the network. A second browser tab also works for trying it locally.

If the port is occupied:

```bash
PORT=3001 npm run dev
```

For a production server:

```bash
npm run build
npm start
```

## Included

- Overview, Send, Receive, History, and Settings pages with responsive mobile navigation.
- Live device discovery, platform identification, editable names, and connection status.
- Multiple file selection, folder selection, drag-and-drop, and 1 GB combined selection validation (up to 100 files).
- Recipient approval, real chunk-acknowledged progress, pause/resume, cancel/reject, and downloadable received files.
- Accept all / Reject all for multiple incoming file requests, alongside individual controls. Download all packages the currently listed, completed received files still buffered in this tab into one ZIP; individual downloads remain available.
- Incoming-file popups on every page, measured transfer speed/ETA, visible percentages, combined session progress, and interruption recovery guidance.
- Instant text, code snippets with syntax highlighting, links, and manually shared clipboard content.
- QR pairing with selectable host interfaces, connection steps and troubleshooting, optional PIN-isolated rooms, and visible HTTP/HTTPS status. A room PIN does not encrypt content.
- Settings save automatically: switches and appearance choices apply immediately; device names and PINs save after a short typing pause or on blur. Invalid values and blocked room changes show inline feedback; failed saves offer Retry. Includes dark/light/system themes, 12/24-hour timestamps, and configurable in-app arrival notifications.
- Settings remain available when the connection is unavailable; local preferences save in the browser and are applied when the connection is restored. Room PIN editing requires the server configuration to be available.
- Searchable/filterable local SQLite history with type/status filters, functional sorting, readable mobile activity cards, and separate transfer-completion/download-availability states. Activity expires after 24 hours and is capped at 200 items per browser session.
- Task-first mobile sharing with a sticky send bar, synchronized recipient selection, recipient-only nearby-device counts, and visible disabled-send explanations.
- Production PWA manifest, local fonts, offline shell/fallback, and Docker configuration.
- Keyboard navigation: Alt+1 through Alt+5 for Overview, Send, Receive, History, and Settings (outside text fields and dialogs); Arrow keys, Home, and End switch Quick Share tabs. Mobile Help remains available in the top bar.

## Important Limits

- In default **LAN mode**, transfers are host-relayed over Socket.IO. In **public mode**, files, text, links, and clipboard travel directly over encrypted WebRTC data channels, never through the signaling server. There is no TURN/file-relay fallback. Optional STUN servers see connection metadata, not shared content.
- Keep both browser tabs open. Pause/resume works within the current connection; after disconnects or refreshes, send the file again.
- Received files are buffered in browser memory (1 GB combined capacity). Large transfers may exceed mobile memory limits. Downloads disappear when the receiving tab closes or reloads. Folder files are received individually; directory reconstruction is not implemented.
- ZIP downloads are created locally in the browser without uploading files. Archive creation uses additional browser memory; duplicate basenames are renamed in the ZIP to avoid overwrites.
- LAN text/clipboard history is stored in SQLite for up to 24 hours. Public mode does not initialize SQLite: history is kept in this tab's session storage for up to 24 hours, capped at 200 entries. Clearing history removes that tab's buffered downloads too.
- Clipboard APIs and PWA installation require a **secure context**: localhost or trusted HTTPS. Ordinary HTTP LAN sharing works for files/text/links, but clipboard access may need manual paste/copy. Offline shell caching is enabled only in production on secure origins; actual sharing always requires the local host.
- HTTP is not encrypted. A LAN room PIN isolates discovery but does not encrypt content. Never expose **LAN mode** publicly; reverse proxies can bypass its private-address checks. Public hosting requires explicit public mode, HTTPS, signed anonymous sessions, and a trusted proxy.
- Public rooms use secret QR/link invitations, not numeric PINs. Invitations expire after 60 minutes, allow up to eight browsers, and close when the creator leaves/disconnects. Anyone with the invitation can join. Invitations are in the URL fragment and removed from the address bar after bootstrap; avoid exposing QR codes or copying invitations to public places.
- Both devices should use the same Wi-Fi. Guest/client isolation, firewalls, VPNs, or browser restrictions can block WebRTC. STUN can help direct connections, including across different networks; it does not enforce same-LAN membership. Failure is shown explicitly; content is never uploaded as a fallback.
- WebRTC encrypts the direct transport, but Setu does not independently authenticate participants against a malicious signaling operator. This is not an audited end-to-end identity-verification system.
- URL sharing includes hostname previews. External preview fetching, background clipboard sync, persistent files, and restart-resumable transfers are not implemented.

## Configuration

| Variable                   | Default                | Purpose                                                              |
| -------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `PORT`                     | `3000`                 | HTTP/WebSocket listener port                                         |
| `SETU_PIN`                 | empty                  | Optional host-wide PIN; clients enter it in Settings                 |
| `SETU_PUBLIC_URL`          | auto-detected LAN IP   | Advertised origin for QR pairing, useful with Docker or local HTTPS  |
| `SETU_DATABASE`            | `database/setu.sqlite` | Local SQLite history path                                            |
| `SETU_MODE`                | `lan`                  | Set `public` explicitly for internet hosting                         |
| `SETU_SESSION_SECRET`      | none                   | Public only: private signing secret, at least 32 characters          |
| `SETU_TRUSTED_PROXY_CIDRS` | none                   | Public only: comma-separated trusted reverse-proxy peer IPs/CIDRs    |
| `SETU_STUN_URLS`           | empty                  | Public only: comma-separated `stun:`/`stuns:` URLs; TURN is rejected |

`SETU_PIN` must be 4-8 digits. Devices with different room PINs cannot discover or send to each other. Restarting the host ends active transfers. Expired history is cleaned at startup, on reads, and every minute.

Public mode requires `SETU_PUBLIC_URL` to be the canonical HTTPS origin. Missing/invalid public configuration fails startup. Public HTTP and Socket.IO access validate the actual proxy peer and canonical host/origin. Anonymous sessions use Secure, HttpOnly, SameSite=Strict cookies. Public room and signaling traffic is bounded; legacy Socket.IO content/history events are refused.

## Docker

Set the advertised URL to the **host machine's LAN address**, not the container address:

```bash
SETU_PUBLIC_URL=http://192.168.1.10:3000 docker compose up --build
```

Replace the example IP with your host's Wi-Fi IP. Activity is stored in the `setu-data` volume. Keep the published port restricted to your LAN. For HTTPS, put a trusted **local** reverse proxy in front, forward WebSocket upgrade headers, and set `SETU_PUBLIC_URL` to that HTTPS origin.

## Checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run format:check
```

For desktop and phone browser tests:

```bash
npx playwright install chromium
npm run test:e2e
npm run test:e2e:public
```

The browser suite builds and starts an isolated production server on port 3100 with in-memory history. It verifies discovery, text/link delivery, byte-perfect approved downloads, navigation during transfer, history filtering/sorting/expiry, live and system theme behavior, disabled-send explanations, recipient counts, keyboard navigation, offline recovery, and controlled transfer speed/pause/failure feedback. Responsive checks cover 320/390/1024/1440px widths, helper-text contrast of at least 4.5:1 on the tested surfaces, and mobile Send visibility above navigation.

The protocol integration tests run two real Socket.IO clients and cover room isolation, approval, chunk offsets, pause/resume, byte-for-byte delivery, file size validation, safe links, and SQLite retention.

The public suite uses a local HTTPS proxy and isolated browser contexts. It checks private QR/link pairing, outsiders, direct text/file delivery, byte equality, and that shared payloads are absent from captured signaling HTTP/WebSocket traffic. Self-signed certificate exceptions are for the local fixture only, never production.

The direct protocol unit tests use in-memory mock data channels; they do not prove real ICE/UDP connectivity. Real-browser transfer checks require a host that permits browser-to-browser WebRTC traffic. On the preparation host, even an independent bare two-peer WebRTC baseline cannot connect, so production/two-physical-device verification remains a launch gate.
