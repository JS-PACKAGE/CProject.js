import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const apiProxy = {
  "/api": {
    target: process.env.CPROJECT_DEV_API_TARGET ?? "http://127.0.0.1:18787",
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 1420, strictPort: true, proxy: apiProxy },
  preview: { port: 1420, strictPort: true, proxy: apiProxy },
  test: {
    pool: "forks",
    env: { TZ: "America/New_York" },
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts"],
      exclude: [
        "src/core/**/*.test.ts",
        "src/core/**/*.test-helper.ts",
        "src/core/types.ts",
      ],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
      reporter: ["text", "html", "json-summary"],
    },
  },
});
