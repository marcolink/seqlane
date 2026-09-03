import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const studioService = "http://127.0.0.1:57694";
const geistFonts = fileURLToPath(
  new URL("./node_modules/geist/dist/fonts", import.meta.url),
);

export default defineConfig({
  root: "src/client",
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "geist-fonts": geistFonts,
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: studioService,
        configure: (proxy) => {
          proxy.on("proxyRes", (_proxyResponse, _request, response) => {
            setImmediate(() => response.flushHeaders());
          });
        },
      },
      "/health": { target: studioService },
      "/favicon.ico": { target: studioService },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    emptyOutDir: false,
    outDir: "../../dist/client",
  },
});
