import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

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

    await page.getByRole("link", { name: "History", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "A little history." }),
    ).toBeVisible();
    await expect(page.locator("tbody tr:visible")).toHaveCount(3);
    await expectTimeFormat(page, true);
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
    await page.setViewportSize({ width, height: 900 });
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
