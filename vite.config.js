import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // pdfjs-dist ships a web worker; tell Vite to treat it as a URL asset
  optimizeDeps: {
    include: ["pdfjs-dist"],
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // Split large vendor chunks so first-load is faster
        manualChunks: {
          "pdfjs": ["pdfjs-dist"],
          "mammoth": ["mammoth"],
          "react-vendor": ["react", "react-dom"],
        },
      },
    },
  },
  worker: {
    format: "es",
  },
});
