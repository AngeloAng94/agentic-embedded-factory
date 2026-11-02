import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Shared core logic with the web app (statuses, patches, safety, export).
      "@core": path.resolve(__dirname, "../../src/lib/core"),
    },
  },
  server: {
    port: 5174,
    fs: { allow: [path.resolve(__dirname, "../..")] },
  },
  build: {
    outDir: "dist",
  },
});
