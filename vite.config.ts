/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// `npm run preview:build` produces one self-contained HTML file (sample data only)
// that can be opened anywhere. The normal build is what the Mac app loads.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "preview" ? [viteSingleFile()] : [])],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: {
    outDir: mode === "preview" ? "dist-preview" : "dist",
    target: "es2022",
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
}));
