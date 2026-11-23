import { randomBytes } from "node:crypto";
import { test, expect, type Browser } from "@playwright/test";

// Headless Chromium only offers the default-route interface (often a VPN tunnel)
// to ICE unless the page holds media permission. Granting a fake stream lets the
// test browsers pair over loopback/LAN; Setu itself never requests media.
async function newPeerContext(browser: Browser, acceptDownloads = false) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    acceptDownloads,
    permissions: ["microphone"],
  });
  await context.addInitScript(() => {
    void navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => {
        (globalThis as { __setuTestStream?: MediaStream }).__setuTestStream =
          stream;
      });
  });
  return context;
}

test("anonymous invitation pairing, private discovery and owner leave", async ({
  browser,
}) => {
  const ownerContext = await newPeerContext(browser);
  const guestContext = await newPeerContext(browser);
  const owner = await ownerContext.newPage();
  const guest = await guestContext.newPage();
  try {
    await owner.goto("https://localhost:3443/settings");
    const invitation = owner
      .locator("code")
      .filter({ hasText: "/#join=" })
      .first();
    await expect(invitation).toBeVisible();
    const url = (await invitation.textContent())!.trim();
    await guest.goto(url);
    await owner
      .getByRole("link", { name: "Send", exact: true })
      .first()
      .click();
    await expect(
      owner
        .getByRole("combobox", { name: "SEND TO", exact: true })
        .locator("option"),
    ).toHaveCount(2);
    expect(new URL(guest.url()).hash).toBe("");
    await owner
      .getByRole("link", { name: "Settings", exact: true })
      .first()
      .click();
    await owner
      .getByRole("button", { name: "Connect a device", exact: true })
      .first()
      .click();
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Leave room", exact: true })
      .click();
    await expect(
      owner.locator("code").filter({ hasText: "/#join=" }),
    ).toHaveCount(0);
    await expect(guest.locator(".peer-device")).toHaveCount(0);
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Create new room", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(invitation).toBeVisible();
    expect((await invitation.textContent())!.trim()).not.toEqual(url);
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});

test("private QR invitation pairs browsers; content uses direct WebRTC only", async ({
  browser,
}) => {
  const senderContext = await newPeerContext(browser);
  const receiverContext = await newPeerContext(browser, true);
  const outsiderContext = await newPeerContext(browser);
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  const outsider = await outsiderContext.newPage();
  const cloudMessages: string[] = [];
  for (const page of [sender, receiver, outsider]) {
    page.on("request", (request) => {
      if (request.postData()) cloudMessages.push(request.postData()!);
    });
    page.on("websocket", (socket) => {
      socket.on("framesent", (frame) =>
        cloudMessages.push(String(frame.payload)),
      );
      socket.on("framereceived", (frame) =>
        cloudMessages.push(String(frame.payload)),
      );
    });
  }
  try {
    await sender.goto("https://localhost:3443");
    await sender
      .getByRole("button", { name: "Connect a device", exact: true })
      .first()
      .click();
    await expect(
      sender.getByRole("dialog").getByText("Private invitation ready"),
    ).toBeVisible();
    const invitation = await sender
      .getByRole("dialog")
      .locator(".qr-frame svg title")
      .textContent();
    expect(invitation).toContain("Join this private");
    // Read the generated link from provider-driven Settings instead of needing clipboard permissions.
    await sender
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await sender
      .getByRole("link", { name: "Settings", exact: true })
      .first()
      .click();
    const link = await sender
      .locator("code")
      .filter({ hasText: "/#join=" })
      .first()
      .textContent();
    expect(link).toContain("/#join=");
    await receiver.goto(link!.trim());
    await outsider.goto("https://localhost:3443");
    await sender
      .getByRole("link", { name: "Send", exact: true })
      .first()
      .click();
    await expect(
      sender
        .getByRole("combobox", { name: "SEND TO", exact: true })
        .locator("option"),
    ).toHaveCount(2);
    await expect(outsider.locator(".peer-device")).toHaveCount(0);
    await sender
      .getByRole("combobox", { name: "SEND TO", exact: true })
      .selectOption({ index: 1 });
    await sender.getByRole("tab", { name: "Text", exact: true }).click();
    await sender.getByLabel("Text or code").fill("Direct-only private text");
    await sender
      .getByRole("button", { name: "Send over", exact: true })
      .click();
    await receiver
      .getByRole("link", { name: "History", exact: true })
      .first()
      .click();
    await expect(
      receiver.getByText("Direct-only private text").first(),
    ).toBeVisible({ timeout: 30_000 });
    await outsider
      .getByRole("link", { name: "History", exact: true })
      .first()
      .click();
    await expect(outsider.getByText("Direct-only private text")).toHaveCount(0);
    await sender.getByRole("tab", { name: "Files", exact: true }).click();
    const bytes = Buffer.concat([
      Buffer.from("Byte-perfect data delivered without uploading to Oracle.\n"),
      randomBytes(8 * 1024 * 1024),
    ]);
    await sender
      .getByRole("tabpanel")
      .getByLabel("Select files", { exact: true })
      .setInputFiles({
        name: "direct.txt",
        mimeType: "text/plain",
        buffer: bytes,
      });
    await sender
      .getByRole("button", { name: "Send 1 file", exact: true })
      .click();
    const started = Date.now();
    await receiver
      .getByRole("button", { name: "Accept", exact: true })
      .filter({ visible: true })
      .click();
    const downloaded = receiver.waitForEvent("download");
    await receiver
      .getByRole("link", { name: "Download direct.txt", exact: true })
      .filter({ visible: true })
      .click();
    const download = await downloaded;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    console.log(
      `direct transfer ${bytes.length} bytes in ${Date.now() - started} ms`,
    );
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(
      cloudMessages.some((message) => message.includes("peer:signal")),
    ).toBe(true);
    expect(cloudMessages.join("\n")).not.toContain("Direct-only private text");
    expect(cloudMessages.join("\n")).not.toContain(
      "Byte-perfect data delivered",
    );
    expect(cloudMessages.join("\n")).not.toContain(
      bytes.subarray(0, 16384).toString("base64"),
    );
  } finally {
    await senderContext.close();
    await receiverContext.close();
    await outsiderContext.close();
  }
});
