import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Worktrees under .claude/worktrees have no node_modules — Node resolves
// packages from the MAIN checkout, outside Vite's default fs.allow, so the
// Inter woff2s 403 (the Segoe UI fallback corrupts type feel-checks).
// @ts-expect-error process is a nodejs global
const mainRoot = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/.exec(process.cwd())?.[1];

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available.
  // PORT override: lets preview tooling run a second dev server without
  // colliding with `tauri dev` (which sets no PORT and gets 1420).
  server: {
    // @ts-expect-error process is a nodejs global
    port: Number(process.env.PORT) || 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      // Listing `allow` REPLACES Vite's default — restate it first.
      allow: [
        // @ts-expect-error process is a nodejs global
        searchForWorkspaceRoot(process.cwd()),
        ...(mainRoot ? [mainRoot] : []),
      ],
    },
  },
}));
