import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  base: "./",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Betaflight AI Copilot",
        short_name: "BF Copilot",
        description: "AI copilot that configures and tunes Betaflight flight controllers.",
        theme_color: "#0d1117",
        background_color: "#0d1117",
        display: "standalone",
        start_url: "./",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallbackDenylist: [/^\/auth/],
      },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // happy-dom everywhere: the component tests need a DOM, and the store reads
    // localStorage at module load, so the node environment cannot import it.
    environment: "happy-dom",
  },
} as never);
