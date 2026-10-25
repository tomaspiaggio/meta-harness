import type { MetadataRoute } from "next";

/** Lets iOS/Android "Add to Home Screen" open without the browser chrome. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Meta Harness",
    short_name: "Harness",
    description: "A durable place for your work.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f6f2ea",
    theme_color: "#f6f2ea",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
