import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import next from "next";
import { HistoryStore } from "./database/history";
import { createSignalingServer, isLocalAddress } from "./services/signaling";

async function main() {
  if (process.env.SETU_PIN && !/^[0-9]{4,8}$/.test(process.env.SETU_PIN))
    throw new Error("SETU_PIN must be 4 to 8 digits.");
  const port = Number(process.env.PORT ?? 3000);
  const dev = process.env.NODE_ENV !== "production";
  const app = next({ dev, hostname: "0.0.0.0", port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const getAddresses = () => {
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter(
        (address) =>
          address &&
          address.family === "IPv4" &&
          !address.internal &&
          isLocalAddress(address.address),
      )
      .map((address) => `http://${address!.address}:${port}`);
    if (process.env.SETU_PUBLIC_URL) {
      const publicUrl = new URL(process.env.SETU_PUBLIC_URL);
      if (!["http:", "https:"].includes(publicUrl.protocol))
        throw new Error("SETU_PUBLIC_URL must use HTTP or HTTPS.");
      addresses.unshift(publicUrl.origin);
    }
    return addresses;
  };
  const initialAddresses = getAddresses();
  const history = new HistoryStore();
  const server = createServer((request, response) => {
    if (!isLocalAddress(request.socket.remoteAddress ?? "")) {
      response.writeHead(403).end("Setu is only available on a local network.");
      return;
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    handle(request, response).catch((error: unknown) => {
      console.error("Request failed", error);
      if (!response.headersSent) response.writeHead(500);
      response.end("Something went wrong.");
    });
  });
  const io = createSignalingServer(server, history, getAddresses);
  server.on("error", (error) => {
    console.error(
      "Cannot start Setu. Choose another PORT if it is already in use.",
      error,
    );
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`\nSetu is ready: http://localhost:${port}`);
    initialAddresses.forEach((address) =>
      console.log(`On your Wi-Fi: ${address}`),
    );
  });
  const shutdown = () => {
    io.close(() => {
      history.close();
      app.close().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
