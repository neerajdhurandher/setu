# Setu

A self-hosted local-network sharing app, built with Next.js, React, TypeScript, Tailwind CSS, shadcn-style Radix primitives, Socket.IO, and SQLite. No accounts or external services are required at runtime.

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
- Incoming-file popups on every page, measured transfer speed/ETA, visible percentages, combined session progress, and interruption recovery guidance.
- Instant text, code snippets with syntax highlighting, links, and manually shared clipboard content.
- QR pairing with selectable host interfaces, connection steps and troubleshooting, optional PIN-isolated rooms, and visible HTTP/HTTPS status. A room PIN does not encrypt content.
- Dark/light/system themes with live preview, unsaved-change and Reset controls, sticky mobile Save, 12/24-hour timestamps, and configurable in-app arrival notifications.
- Searchable/filterable local SQLite history with type/status filters, functional sorting, readable mobile activity cards, and separate transfer-completion/download-availability states. Activity expires after 24 hours and is capped at 200 items per browser session.
- Task-first mobile sharing with a sticky send bar, synchronized recipient selection, recipient-only nearby-device counts, and visible disabled-send explanations.
- Production PWA manifest, local fonts, offline shell/fallback, and Docker configuration.
- Keyboard navigation: Alt+1 through Alt+5 for Overview, Send, Receive, History, and Settings (outside text fields and dialogs); Arrow keys, Home, and End switch Quick Share tabs. Mobile Help remains available in the top bar.

## Important Limits

- Transfers are **host-relayed over Socket.IO**, not WebRTC peer-to-peer. File bytes are never stored on the host's disk.
- Keep both browser tabs open. Pause/resume works within the current connection; after disconnects or refreshes, send the file again.
- Received files are buffered in browser memory (1 GB combined capacity). Large transfers may exceed mobile memory limits. Downloads disappear when the receiving tab closes or reloads. Folder files are received individually; directory reconstruction is not implemented.
- Text and clipboard content are stored in SQLite history for up to 24 hours. History belongs to the temporary identity held in the tab's session storage. Closing the tab creates a new identity on the next visit.
- Clipboard APIs and PWA installation require a **secure context**: localhost or trusted HTTPS. Ordinary HTTP LAN sharing works for files/text/links, but clipboard access may need manual paste/copy. Offline shell caching is enabled only in production on secure origins; actual sharing always requires the local host.
- HTTP is not encrypted. A room PIN isolates discovery but is not end-to-end encryption. Only use trusted local networks. Never expose or port-forward Setu to the public internet; public reverse proxies and VPN address translation can bypass private-address checks.
- URL sharing includes hostname previews. External link preview fetching, WebRTC, end-to-end encryption, background clipboard sync, persistent file storage, and restart-resumable transfers are future work.

## Configuration

| Variable          | Default                | Purpose                                                             |
| ----------------- | ---------------------- | ------------------------------------------------------------------- |
| `PORT`            | `3000`                 | HTTP/WebSocket listener port                                        |
| `SETU_PIN`        | empty                  | Optional host-wide PIN; clients enter it in Settings                |
| `SETU_PUBLIC_URL` | auto-detected LAN IP   | Advertised origin for QR pairing, useful with Docker or local HTTPS |
| `SETU_DATABASE`   | `database/setu.sqlite` | Local SQLite history path                                           |

`SETU_PIN` must be 4-8 digits. Devices with different room PINs cannot discover or send to each other. Restarting the host ends active transfers. Expired history is cleaned at startup, on reads, and every minute.

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
```

The browser suite builds and starts an isolated production server on port 3100 with in-memory history. It verifies discovery, text/link delivery, byte-perfect approved downloads, navigation during transfer, history filtering/sorting/expiry, live and system theme behavior, disabled-send explanations, recipient counts, keyboard navigation, offline recovery, and controlled transfer speed/pause/failure feedback. Responsive checks cover 320/390/1024/1440px widths, helper-text contrast of at least 4.5:1 on the tested surfaces, and mobile Send visibility above navigation.

The protocol integration tests run two real Socket.IO clients and cover room isolation, approval, chunk offsets, pause/resume, byte-for-byte delivery, file size validation, safe links, and SQLite retention.
