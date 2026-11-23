import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Setu - Local Sharing",
    short_name: "Setu",
    description:
      "Your local sharing space. Files, text, and links between your devices.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#1A1A1B",
    theme_color: "#1A1A1B",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
