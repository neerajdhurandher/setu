import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";
import { CHUNK_SIZE, type Welcome } from "../lib/protocol";

async function rename(page: Page, name: string) {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Device name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("status")).toContainText("Preferences saved.");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
}

async function expectTimeFormat(page: Page, hour12: boolean) {
  const time = page.locator("tbody tr:visible time").first();
  const expected = await time.evaluate(
    (element, use12Hour) =>
      new Date(element.getAttribute("datetime")!).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: use12Hour,
      }),
    hour12,
  );
  await expect(time).toHaveText(expected);
}

test("pairing opens from the sidebar or mobile header on every page", async ({
  page,
}, testInfo) => {
  for (const route of ["/", "/history", "/settings"]) {
    await page.goto(route);
    await expect(page.locator(".network-pill")).toHaveText("Local session");
    const placement =
      testInfo.project.name === "mobile"
        ? page.locator("header")
        : page.locator("aside");
    const connect = placement.getByRole("button", {
      name: "Connect a device",
      exact: true,
    });
    await expect(connect).toBeVisible();
    await expect(
      page
        .locator(".page-heading")
        .getByRole("button", { name: "Connect a device" }),
    ).toHaveCount(0);
    await connect.click();
    const dialog = page.getByRole("dialog", {
      name: "Bring another device closer",
    });
    await expect(dialog).toHaveCount(1);
    await expect(dialog.locator(".qr-frame svg")).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

test("Settings previews, resets, and persists the system theme", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.locator(".network-pill")).toHaveText("Local session");
  await expect(
    page.getByRole("button", { name: "Save preferences" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".unsaved-indicator")).toHaveText(
    "Unsaved changes",
  );
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("status")).toContainText("Preferences saved.");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "System", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your sharing space." }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("transfer feedback shows real progress, speed, pause, and interruption", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.locator(".network-pill")).toHaveText("Local session");
  await rename(page, "Feedback Receiver");
  const sender = io(new URL("/", page.url()).origin, {
    transports: ["websocket"],
    reconnection: false,
    auth: {
      sessionId: randomUUID(),
      name: "Feedback Sender",
      platform: "desktop",
      os: "Test",
      pin: "",
    },
  });
  try {
    const welcome = await new Promise<Welcome>((resolve, reject) => {
      sender.once("welcome", resolve);
      sender.once("connect_error", reject);
    });
    const recipient = welcome.devices.find(
      (device) => device.name === "Feedback Receiver",
    )!;
    const offered = await sender.timeout(5000).emitWithAck("offer", {
      kind: "file",
      recipientId: recipient.id,
      name: "measured.bin",
      size: CHUNK_SIZE * 4,
      mime: "application/octet-stream",
    });
    expect(offered.ok).toBe(true);
    const queued = await sender.timeout(5000).emitWithAck("offer", {
      kind: "file",
      recipientId: recipient.id,
      name: "queued.bin",
      size: CHUNK_SIZE * 4,
      mime: "application/octet-stream",
    });
    expect(queued.ok).toBe(true);
    const dialog = page.getByRole("dialog");
    const transfer = dialog
      .locator(".transfer-item")
      .filter({ hasText: "measured.bin" });
    await transfer.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(transfer.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    const chunk = await sender.timeout(5000).emitWithAck("chunk", {
      id: offered.transfer.id,
      offset: 0,
      data: Buffer.alloc(CHUNK_SIZE, 1),
    });
    expect(chunk.ok).toBe(true);
    await expect(transfer.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    await expect(transfer.locator(".transfer-telemetry")).toContainText("25%");
    await expect(transfer.locator(".transfer-telemetry")).toContainText("/s");
    await expect(transfer.locator(".transfer-telemetry")).toContainText(
      "remaining",
    );
    await expect(
      page.locator(
        '.transfer-section [aria-label="Overall transfer progress"]:visible',
      ),
    ).toHaveAttribute("aria-valuenow", "13");
    await page.screenshot({
      path: testInfo.outputPath("transfer-feedback.png"),
      animations: "disabled",
    });
    await transfer
      .getByRole("button", { name: "Pause measured.bin", exact: true })
      .click();
    await expect(transfer.getByRole("status")).toHaveText("Paused");
    await transfer
      .getByRole("button", { name: "Resume measured.bin", exact: true })
      .click();
    await expect(transfer.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    sender.disconnect();
    await expect(transfer.getByRole("status")).toHaveText("Failed");
    await expect(transfer).toContainText("Reconnect both devices");
  } finally {
    sender.disconnect();
  }
});

test("sharing counts, disabled reasons, and tab keyboard navigation are clear", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".network-pill")).toHaveText("Local session");
  const peers = await page.locator(".peer-device").count();
  await expect(page.locator(".devices-section .count-label")).toHaveText(
    String(peers),
  );
  await expect(page.locator(".stats-strip .stat")).toHaveCount(2);
  await expect(page.locator(".stats-strip .stat-label")).toHaveText([
    "Completed shares",
    "Data exchanged",
  ]);
  await expect(
    page.locator(".overview-pairing .pairing-panel.compact"),
  ).toHaveCount(1);
  await expect(page.locator(".overview-summary .pairing-panel")).toHaveCount(0);
  await expect(page.locator(".devices-section .pairing-panel")).toHaveCount(0);
  await expect(page.locator(".self-device")).toContainText("This device");
  await expect(page.locator(".send-status")).toHaveText("Choose a device");
  const files = page.getByRole("tab", { name: "Files", exact: true });
  await files.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Text", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "Text", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "Link", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(files).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("tab", { name: "Link", exact: true }),
  ).toBeFocused();
});

test("two browsers discover, share, download, and manage history", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const receiverContext = await browser.newContext({
    viewport: testInfo.project.use.viewport,
  });
  const receiver = await receiverContext.newPage();
  receiver.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/");
    await expect(page.locator(".network-pill")).toHaveText("Local session");
    await rename(page, "Test Sender");
    await receiver.goto(new URL("/", page.url()).href);
    await expect(receiver.locator(".network-pill")).toHaveText("Local session");
    await rename(receiver, "Test Receiver");
    await expect(
      page.getByRole("button", { name: /Test Receiver/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Test Receiver/ }).click();
    await page.getByRole("tab", { name: "Text", exact: true }).click();
    await page
      .getByLabel("Text or code")
      .fill("const greeting = 'Hello, Setu';");
    await page.getByRole("button", { name: "Send over", exact: true }).click();
    await expect(
      receiver.locator("tbody tr:visible").filter({ hasText: "Hello, Setu" }),
    ).toBeVisible();

    const bytes = Buffer.from("Setu transfer proof.\n".repeat(16_384));
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.getByLabel("Select files", { exact: true }).setInputFiles({
      name: "setu-proof.txt",
      mimeType: "text/plain",
      buffer: bytes,
    });
    await page
      .getByRole("button", { name: "Send 1 file", exact: true })
      .click();
    await expect(
      receiver.getByRole("button", { name: "Accept", exact: true }),
    ).toBeVisible();
    await expect(
      receiver.getByRole("link", { name: "Download setu-proof.txt" }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "Send", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Send something over." }),
    ).toBeVisible();
    const incomingDialog = receiver.getByRole("dialog", {
      name: "Incoming file",
      exact: true,
    });
    await expect(incomingDialog).toContainText("setu-proof.txt");
    await incomingDialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(receiver.getByRole("dialog")).toHaveCount(0);
    await expect(receiver.locator(".transfer-section:visible")).toContainText(
      "setu-proof.txt",
    );
    await receiver.getByRole("link", { name: "Receive", exact: true }).click();
    await expect(
      receiver.getByRole("heading", { name: "Your inbox." }),
    ).toBeVisible();
    await receiver
      .getByRole("button", { name: "Accept", exact: true })
      .filter({ visible: true })
      .click();
    const downloadLink = receiver.getByRole("link", {
      name: "Download setu-proof.txt",
      exact: true,
    });
    await expect(downloadLink).toBeVisible();
    const downloadEvent = receiver.waitForEvent("download");
    await downloadLink.click();
    const download = await downloadEvent;
    expect(await readFile((await download.path())!)).toEqual(bytes);
    await expect(receiver.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("tab", { name: "Link", exact: true }).click();
    await page
      .getByLabel("A link worth sharing")
      .fill("https://example.com/local-sharing");
    await page
      .getByRole("combobox", { name: "SEND TO", exact: true })
      .selectOption({ label: "Test Receiver" });
    await page.getByRole("button", { name: "Send over", exact: true }).click();
    await expect(
      receiver.locator("tbody tr:visible").filter({ hasText: "example.com" }),
    ).toBeVisible();

    await receiver.getByRole("link", { name: "History", exact: true }).click();
    await expect(
      receiver.getByRole("heading", { name: "A little history." }),
    ).toBeVisible();
    const receivedFile = receiver
      .locator("tbody tr:visible")
      .filter({ hasText: "setu-proof.txt" });
    await expect(receivedFile.locator(".download-availability")).toHaveText(
      "Download available",
    );
    await receiver.reload();
    await expect(receivedFile.locator(".download-availability")).toHaveText(
      "Not stored in this tab",
    );
    await expect(
      receivedFile.getByRole("link", { name: "Download setu-proof.txt" }),
    ).toHaveCount(0);
    if (testInfo.project.name === "mobile")
      await expect(receivedFile.locator("time")).toBeVisible();
    await receiver.screenshot({
      path: testInfo.outputPath("received-history.png"),
      fullPage: true,
      animations: "disabled",
    });

    await page.getByRole("link", { name: "History", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "A little history." }),
    ).toBeVisible();
    await expect(page.locator("tbody tr:visible")).toHaveCount(3);
    await expectTimeFormat(page, true);
    await page
      .getByRole("combobox", { name: "Activity type", exact: true })
      .selectOption("file");
    await expect(page.locator("tbody tr:visible")).toHaveCount(1);
    await page
      .getByRole("combobox", { name: "Transfer status", exact: true })
      .selectOption("failed");
    await expect(page.locator("tbody tr:visible")).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "Transfer status", exact: true })
      .selectOption("completed");
    await expect(page.locator("tbody tr:visible")).toHaveCount(1);
    await page
      .getByRole("combobox", { name: "Activity type", exact: true })
      .selectOption("all");
    await page
      .getByRole("combobox", { name: "Transfer status", exact: true })
      .selectOption("all");
    await page
      .getByRole("combobox", { name: "Sort activity", exact: true })
      .selectOption("name-desc");
    await expect(page.locator("tbody tr:visible").first()).toContainText(
      "setu-proof.txt",
    );
    await page
      .getByRole("combobox", { name: "Sort activity", exact: true })
      .selectOption("name-asc");
    await expect(page.locator("tbody tr:visible").first()).toContainText(
      "Hello, Setu",
    );
    await page
      .getByRole("combobox", { name: "Sort activity", exact: true })
      .selectOption("newest");
    await page
      .getByRole("searchbox", { name: "Search activity" })
      .fill("setu-proof");
    await expect(page.locator("tbody tr:visible")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Search activity" }).fill("");
    await page.getByRole("button", { name: "Received", exact: true }).click();
    await expect(page.locator("tbody tr:visible")).toHaveCount(0);
    await page.getByRole("button", { name: "Sent", exact: true }).click();
    await expect(page.locator("tbody tr:visible")).toHaveCount(3);

    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Your sharing space." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Connect a device" }).click();
    await expect(
      page.getByRole("dialog").locator(".qr-frame svg"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    const formIds = await page
      .locator(".quick-share [id]")
      .evaluateAll((elements) => elements.map((element) => element.id));
    expect(new Set(formIds).size).toBe(formIds.length);
    await page.screenshot({
      path: testInfo.outputPath("overview.png"),
      fullPage: true,
      animations: "disabled",
    });

    for (const route of [
      "Overview",
      "Send",
      "Receive",
      "History",
      "Settings",
    ]) {
      await page.getByRole("link", { name: route, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await expect(
      page.getByRole("button", { name: "12-hour", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "24-hour", exact: true }).click();
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByLabel("Device name", { exact: true })).toHaveValue(
      "Test Sender",
    );
    await expect(
      page.getByRole("button", { name: "24-hour", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({
      path: testInfo.outputPath("settings-light.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("link", { name: "History", exact: true }).click();
    await expect(page.locator("tbody tr:visible")).toHaveCount(3);
    await expectTimeFormat(page, false);
    await page
      .getByRole("button", { name: "Clear history", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Clear history", exact: true })
      .click();
    await expect(page.locator("tbody tr:visible")).toHaveCount(0);
    await page.keyboard.press("Alt+1");
    await expect(
      page.getByRole("heading", { name: "Your sharing space." }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      )
      .toBe(true);
    await page.context().setOffline(true);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Your sharing space." }),
    ).toBeVisible();
    await expect(page.locator(".network-pill")).toHaveText("Offline");
    await expect(page.locator(".live-indicator")).toHaveText("Offline");
    await page.context().setOffline(false);
    await expect(page.locator(".network-pill")).toHaveText("Local session");
    expect(errors).toEqual([]);
  } finally {
    await receiverContext.close().catch(() => {});
  }
});

test("incoming files open a global popup with approval and download controls", async ({
  page,
  browser,
}, testInfo) => {
  const receiverContext = await browser.newContext({
    viewport: testInfo.project.use.viewport,
  });
  const receiver = await receiverContext.newPage();
  try {
    await page.goto("/");
    await expect(page.locator(".network-pill")).toHaveText("Local session");
    await rename(page, "Popup Sender");
    await receiver.goto(new URL("/", page.url()).href);
    await expect(receiver.locator(".network-pill")).toHaveText("Local session");
    await rename(receiver, "Popup Receiver");
    await receiver.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(
      receiver.getByRole("heading", { name: "Make yourself at home." }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Popup Receiver/ }).click();
    const bytes = Buffer.from("A file received directly in the popup.");
    await page.getByLabel("Select files", { exact: true }).setInputFiles({
      name: "incoming-notes.txt",
      mimeType: "text/plain",
      buffer: bytes,
    });
    await page
      .getByRole("button", { name: "Send 1 file", exact: true })
      .click();
    const dialog = receiver.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Incoming file");
    await expect(dialog).toContainText("incoming-notes.txt");
    await expect(dialog).toContainText("Popup Sender");
    await expect(dialog.getByRole("status")).toHaveText("Awaiting approval");
    await receiver.screenshot({
      path: testInfo.outputPath("incoming-file.png"),
      animations: "disabled",
    });
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      testInfo.project.use.viewport!.width,
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(dialog).toHaveAccessibleName("File received");
    await expect(dialog.getByRole("status")).toHaveText("Completed");
    const downloadEvent = receiver.waitForEvent("download");
    await dialog
      .getByRole("link", { name: "Download incoming-notes.txt", exact: true })
      .click();
    const download = await downloadEvent;
    expect(await readFile((await download.path())!)).toEqual(bytes);
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(receiver.getByRole("dialog")).toHaveCount(0);

    await page.getByLabel("Select files", { exact: true }).setInputFiles({
      name: "rejected-notes.txt",
      mimeType: "text/plain",
      buffer: bytes,
    });
    await page
      .getByRole("button", { name: "Send 1 file", exact: true })
      .click();
    await expect(dialog).toHaveAccessibleName("Incoming file");
    await expect(dialog).toContainText("rejected-notes.txt");
    await dialog
      .getByRole("button", { name: "Reject rejected-notes.txt", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toHaveText("Rejected");
    await expect(dialog.getByRole("link", { name: /Download/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(
      receiver.getByRole("heading", { name: "Make yourself at home." }),
    ).toBeVisible();
  } finally {
    await receiverContext.close().catch(() => {});
  }
});

test("nearby devices match Quick Share height and pairing stacks vertically", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.locator(".network-pill")).toHaveText("Local session");
  const sockets: ReturnType<typeof io>[] = [];
  try {
    await Promise.all(
      Array.from(
        { length: 12 },
        (_, index) =>
          new Promise<void>((resolve, reject) => {
            const socket = io(new URL("/", page.url()).origin, {
              transports: ["websocket"],
              reconnection: false,
              auth: {
                sessionId: randomUUID(),
                name: `Layout device ${index + 1}`,
                platform: "desktop",
                os: "Test",
                pin: "",
              },
            });
            sockets.push(socket);
            socket.once("welcome", () => resolve());
            socket.once("connect_error", reject);
          }),
      ),
    );
    const widths =
      testInfo.project.name === "mobile"
        ? [390, 320, 760]
        : [1440, 1024, 1920, 800];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ["/", "/send"]) {
        await page.goto(route);
        await expect(page.locator(".peer-device")).toHaveCount(12);
        for (const name of ["Files", "Text", "Link"]) {
          await page.getByRole("tab", { name, exact: true }).click();
          const share = await page.locator(".share-section").boundingBox();
          const devices = await page.locator(".devices-section").boundingBox();
          if (width > 760)
            expect(
              Math.abs(share!.height - devices!.height),
            ).toBeLessThanOrEqual(2);
          const list = page.locator(".devices-section > .device-list");
          const dimensions = await list.evaluate((element) => ({
            height: element.clientHeight,
            content: element.scrollHeight,
          }));
          expect(dimensions.height).toBeGreaterThan(60);
          expect(dimensions.content).toBeGreaterThan(dimensions.height);
          await list.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await expect(
            page.getByRole("button", { name: /Layout device 12/ }),
          ).toBeVisible();
          const pairing = page.locator(".pairing-panel.compact");
          await expect(pairing).toHaveCount(1);
          if (route === "/") {
            await expect(
              page.locator(".overview-pairing .pairing-panel.compact"),
            ).toHaveCount(1);
            await expect(
              page.locator(".overview-summary .pairing-panel"),
            ).toHaveCount(0);
            await expect(page.locator(".stats-strip .stat")).toHaveCount(2);
            if (width > 760) {
              const stats = await page.locator(".stats-strip").boundingBox();
              const paired = await pairing.boundingBox();
              expect(stats!.x + stats!.width).toBeLessThan(paired!.x);
              expect(stats!.height).toBeLessThan(paired!.height);
              const heading = await page.locator(".page-heading").boundingBox();
              const pairingArea = await page
                .locator(".overview-pairing")
                .boundingBox();
              expect(Math.abs(heading!.x - share!.x)).toBeLessThanOrEqual(1);
              expect(Math.abs(stats!.x - share!.x)).toBeLessThanOrEqual(1);
              expect(heading!.y + heading!.height).toBeLessThanOrEqual(
                stats!.y,
              );
              expect(stats!.y + stats!.height).toBeLessThanOrEqual(share!.y);
              expect(share!.y - stats!.y - stats!.height).toBeLessThanOrEqual(
                64,
              );
              expect(Math.abs(pairingArea!.x - devices!.x)).toBeLessThanOrEqual(
                1,
              );
              expect(pairingArea!.y).toBeLessThan(stats!.y);
              expect(pairingArea!.y + pairingArea!.height).toBeLessThanOrEqual(
                devices!.y,
              );
              expect(Math.abs(share!.y - devices!.y)).toBeLessThanOrEqual(1);
            }
          }
          const title = await pairing.locator(".pairing-title").boundingBox();
          const qr = await pairing.locator(".qr-frame").boundingBox();
          const details = await pairing
            .locator(".pairing-details")
            .boundingBox();
          const panel = await pairing.boundingBox();
          expect(title!.y + title!.height).toBeLessThanOrEqual(qr!.y);
          expect(qr!.y + qr!.height).toBeLessThanOrEqual(details!.y);
          expect(
            Math.abs(qr!.x + qr!.width / 2 - (panel!.x + panel!.width / 2)),
          ).toBeLessThanOrEqual(2);
          expect(
            await pairing
              .locator("code")
              .evaluate(
                (element) => element.scrollWidth <= element.clientWidth,
              ),
          ).toBe(true);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          ).toBe(true);
        }
        if (route === "/")
          await page.screenshot({
            path: testInfo.outputPath(`nearby-${width}.png`),
            fullPage: true,
            animations: "disabled",
          });
      }
    }
  } finally {
    sockets.forEach((socket) => socket.disconnect());
  }
});

test("readable typography and sharing controls fit every page", async ({
  page,
}, testInfo) => {
  const widths = testInfo.project.name === "mobile" ? [390, 320] : [1440, 1024];
  const routes = [
    { path: "/", heading: "Your sharing space." },
    { path: "/send", heading: "Send something over." },
    { path: "/receive", heading: "Your inbox." },
    { path: "/history", heading: "A little history." },
    { path: "/settings", heading: "Make yourself at home." },
  ];
  for (const width of widths) {
    await page.setViewportSize({
      width,
      height: testInfo.project.use.viewport!.height,
    });
    for (const theme of ["dark", "light"]) {
      for (const route of routes) {
        await page.goto(route.path);
        await expect(page.locator(".network-pill")).toHaveText("Local session");
        await page.evaluate(
          (value) => (document.documentElement.dataset.theme = value),
          theme,
        );
        await expect(
          page.getByRole("heading", { name: route.heading }),
        ).toBeVisible();
        await expect(page.locator("body")).toHaveCSS("font-size", "16px");
        await expect(page.locator(".sidebar .network-status")).toHaveCount(0);
        await expect(page.locator(".transport-badge")).toContainText("HTTP");
        const contrast = await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.color = "var(--muted-soft)";
          probe.style.backgroundColor = "var(--surface-hover)";
          document.body.append(probe);
          const style = getComputedStyle(probe);
          const foreground = style.color;
          const background = style.backgroundColor;
          probe.remove();
          const luminance = (color: string) => {
            const channels = color
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number)
              .map((channel) => {
                const normalized = channel / 255;
                return normalized <= 0.04045
                  ? normalized / 12.92
                  : ((normalized + 0.055) / 1.055) ** 2.4;
              });
            return (
              channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
            );
          };
          const first = luminance(foreground),
            second = luminance(background);
          return (
            (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
          );
        });
        expect(contrast).toBeGreaterThanOrEqual(4.5);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        const overflowing = await page
          .locator("main button")
          .evaluateAll((buttons) =>
            buttons
              .filter((button) => {
                const bounds = button.getBoundingClientRect();
                return (
                  bounds.width > 0 &&
                  bounds.height > 0 &&
                  (bounds.left < 0 ||
                    bounds.right > window.innerWidth + 1 ||
                    button.scrollWidth > button.clientWidth + 1)
                );
              })
              .map((button) => button.textContent?.trim()),
          );
        expect(overflowing).toEqual([]);
        if (route.path === "/" || route.path === "/send") {
          for (const label of ["Files", "Text", "Link"]) {
            const tab = page.getByRole("tab", { name: label, exact: true });
            await expect(tab.locator("span")).toHaveText(label);
            await expect(tab.locator("span")).toBeVisible();
            await expect(tab.locator("svg")).toBeVisible();
            await expect(tab).toHaveCSS("font-size", "17px");
          }
          const send = page.getByRole("button", {
            name: "Send over",
            exact: true,
          });
          await expect(send.locator("svg")).toHaveClass(/lucide-arrow-right/);
          const labelBounds = await send.locator("span").boundingBox();
          const iconBounds = await send.locator("svg").boundingBox();
          expect(labelBounds!.x + labelBounds!.width).toBeLessThan(
            iconBounds!.x,
          );
          if (width <= 560) {
            const sendBounds = await send.boundingBox();
            expect(sendBounds!.y).toBeGreaterThanOrEqual(0);
            expect(sendBounds!.y + sendBounds!.height).toBeLessThanOrEqual(
              testInfo.project.use.viewport!.height - 65,
            );
            const help = page.getByRole("button", {
              name: "Help & information",
              exact: true,
            });
            await expect(help).toBeVisible();
            const helpBounds = await help.boundingBox();
            expect(helpBounds!.width).toBeGreaterThanOrEqual(44);
            expect(helpBounds!.height).toBeGreaterThanOrEqual(44);
            await help.click();
            await expect(
              page.getByRole("dialog", { name: "About Setu" }),
            ).toBeVisible();
            await page.getByRole("button", { name: "Close dialog" }).click();
          }
        }
        if (route.path === "/" && theme === "dark") {
          await expect(
            page.getByRole("link", { name: "History", exact: true }),
          ).toHaveCSS("color", "rgb(204, 204, 210)");
        }
        if (route.path === "/") {
          await page.screenshot({
            path: testInfo.outputPath(`readable-${theme}-${width}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
      }
    }
  }
});
