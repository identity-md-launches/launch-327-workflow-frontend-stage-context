import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "development-deployment-files",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const path = request.url?.split("?")[0];
          if (
            path !== "/imd-deployment.json" &&
            !/^\/abi\/\w+\.json$/.test(path ?? "")
          )
            return next();
          try {
            const bytes = await readFile(
              new URL(`../dist${path}`, import.meta.url),
            );
            response.setHeader("Content-Type", "application/json");
            response.end(bytes);
          } catch {
            response.statusCode = 503;
            response.end(
              "Run npm run build before starting the development server.",
            );
          }
        });
      },
    },
  ],
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true, sourcemap: false },
});
