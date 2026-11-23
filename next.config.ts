import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

const nextConfig: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: Object.values(networkInterfaces())
    .flat()
    .filter(
      (address) => address && address.family === "IPv4" && !address.internal,
    )
    .map((address) => address!.address),
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
