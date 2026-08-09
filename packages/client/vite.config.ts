import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 5173 unless the launcher assigned another one because it was taken; strictPort stays on so
// a clash still fails loudly rather than landing somewhere nobody opens. An empty PORT is not
// a request for port 0 — Number("") is 0, which would do exactly that.
const requestedPort = process.env.PORT?.trim();
const parsedPort = requestedPort ? Number(requestedPort) : Number.NaN;
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 5173;

export default defineConfig({
  // Relative base so the same bundle loads from Vite, file:// and the packaged app.
  base: "./",
  plugins: [react()],
  server: {
    port,
    strictPort: true,
  },
  build: {
    target: "chrome120",
    sourcemap: false,
  },
});
