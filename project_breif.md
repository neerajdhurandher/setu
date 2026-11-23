# Project: Setu

Setu is a modern web application built with Next.js that allows users connected to the same local Wi‑Fi network to share files, text, links, and clipboard content instantly across devices without requiring cloud storage, user accounts, or internet connectivity.

Deployment clarification: default LAN mode can run without internet and relays content through a local host. Public mode requires internet for HTTPS app access and anonymous room signaling, but all shared content travels directly between browsers over WebRTC, with no TURN/cloud relay. Public history stays in browser-tab storage; SQLite is LAN-only. See [README.md](./README.md) and [ORACLE_DEPLOYMENT_PLAN.md](./ORACLE_DEPLOYMENT_PLAN.md) for current behavior and limitations.

Deployment: the public edition runs at `https://setu.neerajdhurandher.me` on an Oracle Always Free VM. On every push to `main`, GitHub Actions verifies the code, builds the Docker image and publishes it to GHCR. A systemd timer on the VM checks once a day (and 2 minutes after boot), pulls new images and restarts the stack (Docker Compose + Caddy for HTTPS), rolling back if unhealthy. Other branches never deploy, and GitHub never connects to the VM.

## Vision

The goal is to provide an experience similar to AirDrop, Snapdrop, and Sharedrop, but as a self-hosted, open-source web application that runs entirely on a local network and works across Windows, Linux, macOS, Android, and iOS devices through a web browser.

## Tech Stack

- Next.js (App Router)
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- WebSocket / Socket.IO for real-time communication
- Node.js backend (within Next.js)
- WebRTC for all content in public mode; Socket.IO relay in LAN mode
- SQLite history in LAN mode; browser-tab history in public mode
- Docker support; CI/CD via GitHub Actions → GHCR → pull-based updates on the Oracle VM (`main` only)
- PWA support for mobile devices

## Core Features

### Device Discovery

- Discover browsers connected to the same host/room, not arbitrary network devices
- Show online devices in real time
- Display device name, platform, and status
- Generate unique temporary device IDs

### File Sharing

- Upload files from browser
- Drag-and-drop support
- Transfer files between connected devices
- Multiple file uploads (put some size limit 1 GB)
- Folder upload support
- Transfer progress indicator
- Pause and resume transfers
- File size validation
- Transfer history

### Text Sharing

- Send text snippets instantly
- Create temporary notes
- Share code snippets
- Copy received text with one click
- Syntax highlighting for code blocks

### Link Sharing

- Share URLs instantly
- Open links directly from received messages
- Link previews when possible

### Clipboard Sync

- Send clipboard content to another device
- One-click paste workflow
- Clipboard history

### QR Code Pairing

- Generate QR code for quick mobile connection
- Scan QR code to join the session
- Quick device onboarding

### Real-Time Communication

- Instant message delivery
- Device joining/leaving notifications
- Live transfer progress
- Real-time connection status

### Security

- Local-network-only mode
- No cloud dependency
- No user account required
- Optional LAN PIN rooms; expiring private QR/link invitations in public mode
- File transfer approval requests
- Secure temporary sessions
- Automatic cleanup of expired data

### User Experience

- Clean and modern UI
- Mobile-first design
- Dark mode
- Responsive layouts
- Toast notifications
- Keyboard shortcuts
- Accessibility support

### History

- Recent file transfers
- Recent text snippets
- Recent links
- Search functionality
- Clear history option

### Progressive Web App

- Installable on desktop and mobile
- Offline application shell
- Native-app-like experience

## Pages

### Dashboard

Main landing page showing:

- Connected devices
- Recent activity
- Quick share actions

### Send Page

- Upload files
- Enter text
- Share links
- Select recipient device

### Receive Page

- Incoming transfers
- Accept or reject requests
- Download received files

### History Page

- Transfer history
- Search and filtering

### Settings Page

- Device name
- Theme preferences
- Security settings
- Network preferences

## UI Guidelines

- Use shadcn/ui components whenever possible
- Keep components reusable and modular
- Follow modern SaaS design patterns
- Prioritize performance and accessibility
- Use TypeScript for all code
- Prefer server actions where appropriate
- Create responsive layouts for mobile, tablet, and desktop
- Use backgrount color #1A1A1B & main color  #FFE600 . 

## Project Structure

- app/
- components/
- hooks/
- lib/
- services/
- types/
- store/
- public/
- database/

## Coding Standards

- Strict TypeScript
- ESLint + Prettier
- Reusable components
- Feature-based organization
- Error handling for all network operations
- Loading and empty states for all screens
- Optimistic UI updates when applicable

## Future Enhancements

- WebRTC direct peer-to-peer transfers
- End-to-end encryption
- Room-based sharing
- File preview support
- Media streaming
- Multi-network support
- Device groups
- Broadcast sharing
- Browser extensions

When generating code, prioritize simplicity, maintainability, security, and performance. Build reusable components and avoid unnecessary complexity.
