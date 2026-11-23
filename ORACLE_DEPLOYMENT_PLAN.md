# Setu: Oracle Docker deployment plan

Status: application and CI/CD prepared; **not deployed**. This replaces the
previous cloud-relay/SQLite proposal with the requested **direct-only public
sharing**. The VM is set up (section 4) and its update timer is running; it
is waiting for the first image from `main`.

Deployment model: **GitHub Actions builds the Docker image and publishes it to
GHCR; a timer on the Oracle VM pulls and runs new images.** Images are built
only for pushes to `main` (section 8).

## 1. Target

- URL: `https://setu.neerajdhurandher.me`.
- Oracle VM: `<VM_PUBLIC_IP>`.
- Keep the apex/`www` GitHub Pages website unchanged. Pages cannot run Setu's
  signaling server; DNS cannot send just `/setu` to another host.
- Anyone can use Setu without an account. Secure anonymous cookie sessions
  authorize private, temporary invitation rooms; there is no global public
  device list.
- File bytes, text, links, and clipboard travel directly between browsers over
  encrypted WebRTC. They are not uploaded to or downloaded from Oracle.
- Oracle serves the app, presence, and bounded SDP/ICE signaling only.
- No TURN relay and no content-relay fallback. Optional STUN helps discover
  direct routes. History stays in browser-tab session storage, not SQLite.

## 2. Architecture

```text
Browser A -- HTTPS/WSS --> Caddy -- private network --> Setu signaling
Browser B -- HTTPS/WSS --> Caddy -- private network --> Setu signaling

Browser A <========== encrypted WebRTC data channel ==========> Browser B
                     files / text / links / clipboard
```

Use [compose.public.yaml](./compose.public.yaml) and [Caddyfile](./Caddyfile).
Only TCP 80/443 are published. Setu port 3000 stays private. Caddy's fixed
Docker peer is the only trusted forwarded-header source. Public mode does not
initialize SQLite or mount a history volume. Caddy certificate/config volumes
are persistent.

Keep one Setu replica: rooms and anonymous sessions are process-local.
A restart ends rooms and transfers; send interrupted files again. Changing
the session secret invalidates cookies.

## 3. Application preparation

Implemented surfaces:

- [server.ts](./server.ts): explicit LAN/public mode and health routing.
- [services/public-config.ts](./services/public-config.ts): strict startup
  configuration, canonical HTTPS/proxy checks, anonymous session bootstrap.
- [services/public-signaling.ts](./services/public-signaling.ts): private
  invitations, 60-minute rooms, eight-browser limit, bounded signaling,
  session expiry, isolated discovery; refuses legacy content/history events.
- [lib/direct-sharing.ts](./lib/direct-sharing.ts): direct WebRTC messages,
  recipient approval, acknowledged file chunks, pause/resume/cancel/reject,
  download buffers, timeout and failure handling; STUN only, never TURN.
- [hooks/use-sharing.tsx](./hooks/use-sharing.tsx): anonymous bootstrap,
  fragment invitations, room lifecycle and browser-local history.
- Pairing/Settings/Help show mode-aware privacy and connection guidance.
- [public/sw.js](./public/sw.js): session/config/health/socket routes are never
  cached by the offline shell.
- Existing LAN mode remains separate and unchanged in architecture:
  local Socket.IO relay, numeric PIN rooms, SQLite history.

These protections are not a production security audit. A leaked invitation
allows entry. WebRTC encrypts transport, but there is no independent participant
identity verification against a malicious signaling operator.

## 4. Prepare the VM

VM state (verified 2026-11-23, after setup):

| Item         | Value                                                      |
| ------------ | ---------------------------------------------------------- |
| SSH          | `ssh -i <SSH_KEY_FILE> <SSH_USER>@<VM_PUBLIC_IP>` |
| OS           | Oracle Linux 9.8                                           |
| Architecture | x86_64, so images are built for `linux/amd64`              |
| CPU / RAM    | 2 vCPU / 945 MiB                                           |
| Swap         | 945 MiB (`/.swapfile`) + 2 GiB (`/swapfile`)               |
| Disk         | 30 GB, 24 GB free                                          |
| Docker       | 29.10 + Compose 5.8, installed 2026-11-23                  |
| Firewall     | firewalld allows ssh, http, https                          |

945 MiB is too little to build Next.js, so images are built in GitHub Actions
and the VM only pulls them. It is also too little for `dnf` without swap: the
first setup attempt (2026-11-23) made the VM stop answering SSH while `dnf`
loaded repository metadata. **Create swap before any `dnf` command.** If the VM
becomes unresponsive, reboot it from the Oracle Console (Instance → Reboot).

One-time setup as `opc`, in this order:

```bash
# 1. 2 GiB swap first.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h

# 2. Docker (official RHEL-compatible repository) and git. Enabling only the
#    needed repos keeps dnf's memory use low.
R=ol9_baseos_latest,ol9_appstream
sudo dnf -y --disablerepo='*' --enablerepo=$R install dnf-plugins-core git
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf -y --disablerepo='*' --enablerepo=$R,docker-ce-stable install \
  docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker opc        # log out and back in afterwards
docker version && docker compose version

# 3. Host firewall: HTTP/HTTPS for Caddy.
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

The update service runs `docker` as `opc` without sudo, so the `docker` group
membership is required.

## 5. DNS and network

1. Add a DNS-only A record `setu` pointing to `<VM_PUBLIC_IP>`.
2. Leave apex/`www` Pages records alone. Do not add IPv6 without a configured
   reachable IPv6 path.
3. Allow inbound TCP 80 and 443 in Oracle subnet/security rules and the host
   firewall. Deploys don't use SSH, so restrict TCP 22 to your own IP. Never
   open public port 3000.
4. Check existing services before claiming 80/443. Do not replace them blindly.
5. Check `172.30.0.0/24` does not overlap VM/VPN/Docker networks. If it does,
   change Compose subnet/static addresses and `SETU_TRUSTED_PROXY_CIDRS`
   together.
6. Keep CDN/proxy mode disabled initially. Another upstream proxy requires a
   reviewed client-IP trust configuration, not broad trusted private CIDRs.

## 6. Configure and launch

Everything lives in `~/setu` on the VM:

| Path                          | Contents                                                   |
| ----------------------------- | ---------------------------------------------------------- |
| `~/setu/.env.public`          | Private configuration and session secret (created by hand) |
| `~/setu/app/`                 | Clone of this public repo, checked out at deployed commit  |
| `~/setu/release.env`          | Deployed commit and image                                  |
| `~/setu/release.previous.env` | Previous release, used for rollback                        |
| `~/setu/failed.commit`        | Last commit that failed health checks (not retried)        |

Create `.env.public` on the VM so the secret never leaves it:

```bash
mkdir -p ~/setu && cd ~/setu
umask 077
printf 'SETU_DOMAIN=setu.neerajdhurandher.me\nSETU_SESSION_SECRET=%s\nSETU_STUN_URLS=\n' \
  "$(openssl rand -hex 32)" > .env.public
```

Do not put the secret in Git, issue comments, screenshots, or public logs.
GitHub never sees it.

Empty STUN configuration uses host candidates for the same LAN. If needed,
choose a STUN provider whose reliability/privacy you accept and set a
comma-separated list of `stun:`/`stuns:` URLs. TURN URLs are rejected.
No STUN provider is required for Oracle itself.

Install the update script and timer (section 8) from your Mac:

```bash
scp -i <SSH_KEY_FILE> deploy/setu-update.sh \
  deploy/systemd/setu-update.service deploy/systemd/setu-update.timer \
  <SSH_USER>@<VM_PUBLIC_IP>:/tmp/
ssh -i <SSH_KEY_FILE> <SSH_USER>@<VM_PUBLIC_IP> '
  sudo install -m 755 /tmp/setu-update.sh /usr/local/bin/setu-update
  sudo install -m 644 /tmp/setu-update.service /tmp/setu-update.timer /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now setu-update.timer'
```

The script lives in `/usr/local/bin` rather than the home directory because
SELinux (enforcing on Oracle Linux) blocks systemd from executing files in
home directories. Changes to the script or units are installed this way by
hand; deploys never modify them.

Useful commands on the VM:

```bash
systemctl list-timers setu-update.timer      # next check
journalctl -u setu-update -n 50              # update history
cat ~/setu/release.env                       # deployed commit/image
cd ~/setu/app && alias setu='docker compose -p setu --env-file ../.env.public --env-file ../release.env -f compose.public.yaml'
setu ps && setu logs --tail=50
curl -fsS https://setu.neerajdhurandher.me/healthz
```

Caddy obtains HTTPS certificates automatically when DNS and ports are ready.
Do not disable certificate validation or expose HTTP app traffic as a workaround.
The app's internal healthcheck uses loopback; public health requests still
pass canonical proxy checks. The supplied Caddy configuration overwrites Host,
X-Forwarded-Host/Proto/For and removes Forwarded, including WebSocket upgrades.

## 7. Launch gates

Run locally before building the release:

```bash
npm test
npm run typecheck
npm run lint
npm run test:e2e
npm run test:e2e:public
```

Then verify the production container/proxy and **two physical devices**:

- Both devices open the public HTTPS app on the same Wi-Fi.
- Creator opens Connect a device; receiver scans its QR or opens its invitation.
- Only that room's devices are visible. Another independent room is isolated.
- No login/account is required.
- Text, links, manually pasted clipboard, zero-byte and ordinary files arrive.
- Recipient approval is required; pause/resume, reject/cancel and byte equality
  work. Navigation preserves the connection; reload/disconnect shows recovery.
- Shared content and file data are absent from Oracle HTTP/WebSocket traffic.
  SDP/ICE and device/room metadata remain visible to the signaling service.
- Guest/client isolation fails explicitly without uploading files as fallback.
- Expired invitations are refused; creator leave closes the room.
- Browser history clearing/expiry works; public mode creates no SQLite history.
- HTTP redirects to trusted HTTPS; 3000 is not externally reachable.
- Canonical origin, untrusted proxy, invalid cookie and oversized signaling
  requests are rejected.
- Container health and Caddy certificate renewal persist across restart.

Same-machine browser tests do not establish real phone/desktop compatibility.
Mobile browsers, mDNS host candidates, VPNs, and guest Wi-Fi need physical testing.
Files are buffered in browser memory (up to 1 GiB aggregate); smaller files
are safer on phones. Downloads disappear on refresh/tab closure.

Preparation verification: static checks and protocol tests pass, including
mock-channel approval, exact bytes, zero-byte files, pause/resume, simultaneous
messages and refusal checks. `npm run test:e2e:public` delivers text and an
8 MiB random file between two real Chromium peers over WebRTC with byte
equality, and confirms neither appears in server HTTP/WebSocket traffic.
Container/Caddy runtime on the VM and physical-device sharing remain unverified
until the first deploy.

## 8. CI/CD: GitHub Actions builds, the VM pulls

Pull-based deployment: GitHub never connects to the VM, so no SSH keys or
server secrets are stored in GitHub and SSH can stay restricted to your IP.

```text
push to main
  └─ GitHub Actions (.github/workflows/deploy.yml)
       verify   npm ci, typecheck, lint, unit tests
       image    build linux/amd64, push ghcr.io/neerajdhurandher/setu
                tags: sha-<full commit>, main

Oracle VM, 2 minutes after boot and then once a day
  (setu-update.timer → /usr/local/bin/setu-update)
  git fetch main → latest commit C
  C already deployed, or C failed before?          → nothing to do
  image sha-C not published yet (build running)?   → retry next tick
  otherwise: checkout C in ~/setu/app, pull sha-C, docker compose up -d
             wait up to 150 s for health
             healthy   → record C in release.env, prune old images
             unhealthy → record C in failed.commit, restore previous release
```

- **Trigger:** only pushes to `main` build and publish
  ([deploy.yml](./.github/workflows/deploy.yml)). Pull requests and other
  branches do nothing. Browser e2e suites are not run in CI; run them locally
  before merging (section 7).
- **Same commit everywhere:** the VM checks out `compose.public.yaml` and
  `Caddyfile` from commit C and runs image `sha-C`, so configuration and code
  always match. If CI fails for C, no image is published and the VM stays on
  the current release until a later commit succeeds.
- **Delay:** a deploy starts within about 24 hours after the image is
  published. To deploy immediately: `sudo systemctl start setu-update`.
- **Script** ([setu-update.sh](./deploy/setu-update.sh)) uses a lock so runs
  never overlap, and keeps only the current and previous images on disk.

### One-time GitHub setup

No GitHub secrets or environments are needed. Publishing uses the workflow's
built-in `GITHUB_TOKEN`.

After the first successful run, make the image public so the VM can pull it
without credentials: **GitHub profile → Packages → `setu` → Package settings
→ Change visibility → Public**. The repository is already public, so this
exposes nothing new.

If you prefer to keep the image private, log the VM in once with a classic
personal access token that has only `read:packages` (stored in
`~opc/.docker/config.json`):

```bash
docker login ghcr.io -u neerajdhurandher    # paste the token when asked
```

### First release

1. Complete sections 4–6 (VM, DNS/network, `.env.public`, timer).
2. Commit the application and deployment changes on `develop`, run the
   section 7 local checks, then merge into `main` and push.
3. Watch **Actions → Build image** until green, then make the package public.
4. The VM deploys it on its next daily check. To deploy immediately, run
   `sudo systemctl start setu-update`; follow progress with
   `journalctl -u setu-update -f`. Then run the section 7 physical-device checks.

### Rollback

Automatic: an unhealthy release is rolled back and its commit is not retried.
Manual, to any commit whose image was published:

```bash
ssh -i <SSH_KEY_FILE> <SSH_USER>@<VM_PUBLIC_IP>
cat ~/setu/release.previous.env
setu-update <commit-sha>
```

Manual deploys override the failed-commit marker. If main's latest commit has
not failed, the next timer run (within 24 hours) deploys it again. To stay on
an older release, revert the commit on `main` (it is then built and deployed
like any other commit), or pause updates with
`sudo systemctl stop setu-update.timer` and start the timer again later.

[DEPLOYMENT_PLAN.md](./DEPLOYMENT_PLAN.md) contains the original GitHub Pages
options; this document is authoritative for public mode.

## 9. Operations and rollback

- Keep `.env.public` and Caddy certificate volumes secure and backed up.
  Public shared content/history is not on the VM; there is no SQLite backup
  requirement for public mode.
- Rotate secrets deliberately, update base images/dependencies, and retain
  bounded container logs. Avoid logging session cookies, invitation secrets,
  SDP payloads or shared content.
- Monitor memory, disk, health, TLS renewal, and room/signaling abuse. Free
  hosting has no guaranteed uptime/capacity.
- Record the previous image digest or tested source commit before updating.
  Roll back to that version and restart the stack if health/sharing fails.
- Do not delete Caddy volumes during rollback. Expect active rooms/transfers
  to be interrupted by any app restart.
