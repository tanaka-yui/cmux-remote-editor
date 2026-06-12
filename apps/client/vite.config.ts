import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "cmux Remote",
        short_name: "cmux",
        start_url: "/",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#1a1a2e",
        background_color: "#1a1a2e",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // SPA fallback, but never intercept the WebSocket bridge or health check.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/ws/, /^\/health/],
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm,woff2}"],
      },
    }),
  ],
  server: {
    host: true,
    proxy: {
      "/ws": {
        target: "ws://localhost:48701",
        ws: true,
      },
      "/health": {
        target: "http://localhost:48701",
      },
    },
  },
});
