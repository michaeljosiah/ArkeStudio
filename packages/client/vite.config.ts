import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the same bundle loads from Vite, file:// and the packaged app.
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "chrome120",
    sourcemap: false,
  },
});
