import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Safari 16 is the WebKit that ships with macOS 13, the proposed minimum.
const target = ["safari16", "es2022"];

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: { target },
  worker: { format: "es" },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: { environment: "node" },
});
