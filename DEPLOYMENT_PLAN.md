# Setu deployment plan

Status: superseded for production by the Oracle plan. The chosen deployment is **GitHub Actions builds the Docker image → GHCR → a timer on the Oracle VM pulls and runs it** ([deploy/setu-update.sh](./deploy/setu-update.sh)). Images are built only for pushes to `main` ([.github/workflows/deploy.yml](./.github/workflows/deploy.yml)); GitHub never connects to the VM. The sections below are kept as the original options analysis.

For the selected Oracle VM and accountless public sharing through private temporary rooms, see the detailed [Oracle Docker deployment plan](./ORACLE_DEPLOYMENT_PLAN.md). That plan supersedes the historical options below: explicit public mode now uses direct WebRTC for all content, a signaling-only backend, and browser-tab history without SQLite. Physical-device and production-container launch gates still apply.

## 1. Can this app run on GitHub Pages?

**Not as a complete, working application.** GitHub Pages serves static HTML, CSS, and JavaScript. Setu also requires an always-running Node.js/Socket.IO server for pairing, even when content travels directly over WebRTC. SQLite is required only in LAN mode.

Your existing custom domain can still be used. However, a domain points visitors to a host; it does not add backend capabilities to GitHub Pages.

| Deployment option                                             | Possible?                          | What it provides                                                                               |
| ------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Current full app entirely on GitHub Pages                     | No                                 | Pages cannot run the server, relay transfers, or maintain SQLite history.                      |
| Landing page, documentation, or clearly labeled demo on Pages | Yes                                | Public project information and installation instructions; no real sharing backend.             |
| GitHub builds/releases, with the full app on a LAN computer   | Yes; recommended first             | Preserves the current local-first design and existing functionality.                           |
| Full app on a public server, using your domain                | Requires application changes first | A separate internet-accessible edition, not a deployment-only change.                          |
| Pages frontend plus a separately hosted backend               | Possible after refactoring         | Still requires a runtime host and public-access safeguards; not the simplest first deployment. |

**Recommendation:** keep your existing Pages site and domain working, optionally add a Setu information site, and use GitHub Actions to build the full app for a private LAN host. If the goal is for anyone to open your domain and share files, complete the public-hosting prerequisites in section 6 before exposing it.

## 2. Findings from this repository

| Area                    | Current implementation                                                                                                                                                                     | Deployment implication                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                 | [package.json](./package.json) requires Node.js 24+; `npm start` runs the custom [server.ts](./server.ts).                                                                                 | Use a long-running Node/container host, not static-only hosting.                                                                                          |
| Real-time communication | [services/signaling.ts](./services/signaling.ts) handles discovery, rooms, transfer approval, and file chunks through Socket.IO.                                                           | WebSocket upgrades and HTTP long-polling must reach the same server. This is a data relay, not just signaling.                                            |
| Network restrictions    | [server.ts](./server.ts) and [services/signaling.ts](./services/signaling.ts) check private/loopback source addresses; Socket.IO also checks the request origin against the host.          | Public deployment is intentionally unsupported. A public proxy can mask the real source address; passing these checks does not make that deployment safe. |
| Browser connection      | [hooks/use-sharing.tsx](./hooks/use-sharing.tsx) calls `io()` without a separate backend URL.                                                                                              | The browser currently connects to its own origin. Pages would receive the connection attempts but has no Socket.IO backend.                               |
| History                 | [database/history.ts](./database/history.ts) uses Node's built-in SQLite with a local file and WAL mode.                                                                                   | History needs a persistent writable volume; text/clipboard content is stored, not just transfer metadata.                                                 |
| Hosting model           | [Dockerfile](./Dockerfile) and [compose.yaml](./compose.yaml) already build and run the complete application.                                                                              | Reuse the existing container approach instead of replacing the server.                                                                                    |
| URL assumptions         | [app/layout.tsx](./app/layout.tsx), [app/manifest.ts](./app/manifest.ts), [public/sw.js](./public/sw.js), and [hooks/use-sharing.tsx](./hooks/use-sharing.tsx) contain root-relative URLs. | Hosting the existing UI under `/setu/` requires a path and service-worker audit, not just a Pages workflow.                                               |
| Existing guidance       | [README.md](./README.md) explicitly warns against public exposure and documents browser-memory downloads and non-resumable disconnects.                                                    | Preserve those limits in deployment documentation and user-facing claims.                                                                                 |

No deployment was attempted and no static-export build was tested for this plan. The exact domain, DNS provider, repository Pages settings, and intended runtime host are not yet confirmed.

## 3. Domain layout: preserve your current website

Use `example.com` below as a placeholder for your actual domain.

| Address                                        | Suggested purpose                                     | Hosting                            |
| ---------------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| Your current apex/`www` address                | Existing website, unchanged                           | Existing GitHub Pages setup        |
| `example.com/setu/` or `setu-info.example.com` | Optional Setu landing page and setup instructions     | GitHub Pages                       |
| `share.example.com` resolved through local DNS | Optional friendly address for the private working app | LAN host with trusted local HTTPS  |
| `share.example.com` on public DNS              | Future public edition, only after section 6           | Separate long-running runtime host |

Important details:

- If your domain is attached to your **user Pages site**, a project Pages site for this repository can normally inherit `https://example.com/setu/`. If it is attached only to another project repository, do not assume that inheritance.
- A dedicated Pages subdomain can instead be assigned to this repository. For a Pages subdomain, its DNS `CNAME` target is `neerajdhurandher.github.io`, not a URL containing `/setu/`.
- Configure and verify the Pages custom domain before adding new DNS records. Keep existing apex/`www`, mail, and verification records intact, and enable **Enforce HTTPS** when available.
- With a custom Actions publishing workflow, configure the domain in repository **Settings > Pages**; a `CNAME` file in the artifact is not required.
- A future runtime subdomain must point to the runtime provider/server, **not** to GitHub Pages.
- DNS cannot send `/setu/` to one host and `/socket.io/` to another. That requires an actual reverse proxy; GitHub Pages does not provide one.
- A dedicated hostname is preferable for the full app because its PWA and service worker currently assume ownership of `/`.

## 4. Track A: publish a static Setu site on GitHub Pages

This is the fastest route to putting something useful on your existing domain.

### A1. Build a small, isolated information site

- Add a proposed `site/` directory containing a static landing page, screenshots, features, privacy/limitations, and local installation instructions.
- Do not publish the repository root, database, environment files, or the application's server bundle.
- Prefer plain static files initially. They do not require changing the existing Next.js application's rendering configuration.
- If an interactive preview is wanted, make demo mode explicit: sample devices/data, no real transfers, and no repeated attempts to contact a nonexistent Socket.IO endpoint.
- Do not register the working app's root-scoped service worker on your existing website.

### A2. Add a dedicated Pages workflow

Proposed future file: `.github/workflows/pages.yml`.

1. Select the intended publishing branch; the inspected local branch is `develop`, so do not assume `main`.
2. In repository **Settings > Pages**, choose **GitHub Actions** as the source.
3. Check out the selected revision and build the information site if necessary.
4. Configure Pages, upload **only** the static site directory using `actions/upload-pages-artifact`, and deploy with `actions/deploy-pages`.
5. Give the deployment job `pages: write` and `id-token: write`, with `contents: read` for checkout. Use the `github-pages` environment and make deployment depend on the artifact-producing job.
6. Pin actions to reviewed immutable revisions and use deployment concurrency to avoid overlapping releases.
7. Verify the default Pages URL before connecting an additional custom hostname.

### A3. If exporting the existing Next.js UI instead

Treat this as a separate task, not the default shortcut:

- Follow the installed Next.js 16.4.3 static-export guide; use `output: "export"` and `next build`, not the removed `next export` command.
- Audit the current `cacheComponents` and `partialPrefetching` settings against static-export support and require a successful export build before promising compatibility.
- For a project-path deployment, configure `basePath: "/setu"` and consider `trailingSlash: true` for directory-style route files. A dedicated custom hostname generally uses an empty base path.
- Fix all public asset URLs, manifest identifiers/start URL/scope, service-worker registration/cache paths, navigation, and any Socket.IO endpoint assumptions.
- Verify direct loads and refreshes of every exported route. Publish the generated `out/` directory, not `.next/`.
- An export still does **not** provide discovery, transfers, or SQLite history without another backend.

**Track A acceptance:** the existing website remains unchanged; the Setu site loads over HTTPS; links and assets work at the selected path; the page makes its informational/demo-only scope clear.

## 5. Track B: deploy the working LAN app through GitHub

### B1. Establish CI

Proposed future file: `.github/workflows/ci.yml`.

Run on pull requests and pushes to the selected integration branch:

1. Set up Node.js 24 and install the locked dependencies with `npm ci`.
2. Run the existing checks:

   ```bash
   npm test
   npm run typecheck
   npm run lint
   npm run build
   ```

3. Install Playwright Chromium and its Linux dependencies, then run `npm run test:e2e`. The existing [playwright.config.ts](./playwright.config.ts) builds and starts an isolated production server itself, so avoid an unnecessary duplicate build in that job.
4. Report failures and retain browser traces on failure. Do not publish or deploy failed revisions.

### B2. Publish a release image

Proposed future file: `.github/workflows/release.yml`.

- Publish only reviewed releases from the chosen release branch/tag policy after CI succeeds; start with manual deployment approval.
- Build the existing Docker image and publish it as `ghcr.io/neerajdhurandher/setu`.
- Build for the actual host architecture, or publish `linux/amd64` and `linux/arm64` images if both are needed.
- Authenticate from Actions using `GITHUB_TOKEN` with `contents: read` and `packages: write`.
- Associate the image with this repository. Tag releases and source commits, and record the immutable image digest.
- Review package visibility explicitly; GHCR packages initially default to private. A private image needs a host-side pull credential with least-privilege package read access; a public image can be pulled anonymously.
- Keep credentials, room PINs, and SQLite files out of images and workflow logs. Preserve the existing exclusions in [.dockerignore](./.dockerignore).

### B3. Run the release on a private host

Use an always-on computer, NAS, or small server on the trusted LAN.

- Add a proposed image-based `compose.deploy.yaml` so releases pull the published image instead of requiring a source build on the host. Keep [compose.yaml](./compose.yaml) available for local source builds.
- Run one application replica. Device sessions and active transfers are held in memory; adding replicas is not safe without a separate coordination design.
- Keep a stable persistent volume mounted at `/app/data`, using `SETU_DATABASE=/app/data/setu.sqlite`. Preserve the deployment's Compose project/volume identity across updates.
- Run the existing `npm start` entry point. Do not substitute `next start` or Next.js standalone output: they do not include this custom Socket.IO server.
- Configure runtime values:

  | Variable          | Deployment value                                        |
  | ----------------- | ------------------------------------------------------- |
  | `PORT`            | `3000` inside the container                             |
  | `SETU_DATABASE`   | `/app/data/setu.sqlite` on the persistent volume        |
  | `SETU_PUBLIC_URL` | Reachable LAN origin, or the trusted local HTTPS origin |
  | `SETU_PIN`        | Optional 4-8 digit host-wide PIN, stored outside Git    |

- `SETU_PUBLIC_URL` changes advertised pairing addresses only. It does not configure a separate browser backend, open network access, or add authentication.
- Restrict the published port to the trusted LAN interface/firewall. The current Compose port binding is not itself a network security boundary.
- Do not port-forward the service or put it behind an internet-facing tunnel/proxy. Container networking can also obscure source addresses.
- For local HTTPS, use a LAN-only reverse proxy and a certificate trusted by all client devices. Preserve the original Host/Origin relationship and forward WebSocket upgrades and long-polling.
- If using your domain privately, configure local DNS and certificate issuance/trust without opening the application to the internet. This does not require changing the domain's existing public Pages records.

### B4. Release, verify, and roll back

Start with a manual pull/restart of an approved image digest on the LAN host. GitHub-hosted runners do not need inbound access to your network. Automated host-side pulling can be added later; avoid exposing SSH just for CI.

For each release:

1. Record the current image digest; take a SQLite-consistent backup if history recovery is required. With WAL enabled, use a proper backup method or stop the app before copying database files.
2. Announce a short interruption and ensure no active transfers remain. Restarts end transfers; do not promise seamless rolling upgrades.
3. Pull the approved image and recreate the container without removing its data volume.
4. Verify the process remains running, the HTTP pages respond, and Socket.IO connects successfully through the actual LAN URL/proxy.
5. On two real LAN devices, verify discovery, correct PIN isolation, text/link delivery, file approval, and a downloaded file matching the original bytes. Verify clipboard/PWA behavior on the chosen HTTPS origin.
6. Verify existing history remains available to the same browser identity after a server restart, with the documented retention rules. Received file downloads remain browser-memory-only.
7. If verification fails, redeploy the previous image digest. Restore a backup only if a data/schema change requires it; never erase the volume as a routine rollback.

**Track B acceptance:** two LAN devices can use the full app; production tests pass; history survives server recreation; the service is unreachable from untrusted/public networks; the previous image can be restored.

## 6. Historical public-domain prerequisites

The selected implementation is now described in [ORACLE_DEPLOYMENT_PLAN.md](./ORACLE_DEPLOYMENT_PLAN.md). The cloud-relay/SQLite proposals below are historical alternatives, **not instructions for public mode**. Public content now travels directly over WebRTC and history stays browser-local.

**This is a product/security change, not a DNS toggle. Do not expose the current app to test it publicly.**

If the requirement is "open my domain from anywhere and use real sharing," first:

1. Define the access model: private invited groups or public anonymous rooms; whether cross-network sharing is intended; and whether cloud-relayed file bytes/text storage are acceptable.
2. Add strong, expiring authorization for room membership and transfer/history access. A short PIN and temporary client identity are not a sufficient public access model.
3. Preserve LAN-only mode as the default. Any internet mode must be explicit, with a documented trusted-proxy boundary, verified origin handling, connection/join throttling, quotas, and abuse controls.
4. Add HTTPS/WSS, protect the backend from direct bypass of its proxy, and define logging, retention, privacy notices, and operational monitoring.
5. Test denial and isolation cases, proxy behavior, reconnects, and resource exhaustion. Measure memory and bandwidth before selecting limits.
6. Account for relay costs: browser A sends file bytes to the host, which sends them to browser B. Internet hosting changes the app's local-only privacy and bandwidth model; WebRTC and end-to-end encryption remain separate future work.
7. Choose a long-running Node/container provider with persistent disk, WebSockets, suitable idle/connection timeouts, and adequate bandwidth. Start with one replica; static hosting and ordinary request-limited functions are not equivalent substitutes.
8. Deploy to staging, complete production acceptance tests, then point only the chosen runtime subdomain to that host and enable trusted TLS. Keep the existing Pages apex/`www` records unchanged.
9. Update the local-only claims in [README.md](./README.md), app metadata, and UI for that explicitly selected mode before launch.

### Why not put only the frontend on Pages?

That could eventually work, but would additionally require:

- A configured backend URL in the client and a separately deployed runtime.
- Explicit cross-origin HTTP polling/CORS and WebSocket Origin policies; the current same-origin check rejects this arrangement.
- Compatible authentication and HTTPS on both origins.
- Accurate pairing URLs that open the frontend, and clear connection/error states.
- Testing public-to-private network browser restrictions if the backend remains on a LAN. An HTTPS Pages site cannot be assumed to connect freely to a private HTTP host.

There is little operational benefit for the first working release. Serving UI and Socket.IO together on the runtime hostname preserves the existing design.

## 7. Implementation order and decisions

| Order | Deliverable                                                                                                            | Dependency                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1     | Confirm actual domain, existing Pages repository/type, and whether the goal is a showcase, LAN use, or public sharing. | Owner decision                     |
| 2     | Select publishing/release branches and add CI.                                                                         | Agreed branch policy               |
| 3     | Optionally publish the isolated information site on Pages.                                                             | Domain/path choice                 |
| 4     | Publish a versioned container and prepare a private image-based deployment.                                            | Passing CI, selected LAN host      |
| 5     | Verify LAN HTTPS, functional transfers, data persistence, and rollback.                                                | Running private host               |
| 6     | Consider public hosting only after its access/privacy design and safeguards are implemented and tested.                | Explicit scope approval; section 6 |

No paid host is required for the Pages information site, subject to your GitHub plan and usage limits. The working LAN app needs your own always-on hardware; public runtime hosting, persistent storage, registry/Actions usage, and relay bandwidth may incur costs.

**First deployable outcome:** your current domain stays on GitHub Pages, an optional Setu page explains the project, and the complete sharing app runs privately from a GitHub-built container. Public full-app access is a separate, gated follow-up.

## References

Repository findings above were checked against the static-export, custom-server, and self-hosting guides bundled with the installed Next.js 16.4.3 package. Public framework guides and official hosting references:

- [GitHub: What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub: Custom domains and project-site inheritance](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages)
- [GitHub: Managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [GitHub: Custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub: Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Next.js: Static exports](https://nextjs.org/docs/app/guides/static-exports)
- [Next.js: Custom server](https://nextjs.org/docs/app/guides/custom-server)
- [Next.js: Self-hosting](https://nextjs.org/docs/app/guides/self-hosting)
