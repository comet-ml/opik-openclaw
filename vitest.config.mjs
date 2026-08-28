import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/diagnostic-runtime": fileURLToPath(
        new URL("./.scripts/vitest-openclaw-plugin-sdk.mjs", import.meta.url),
      ),
      "openclaw/plugin-sdk/plugin-entry": fileURLToPath(
        new URL("./.scripts/vitest-openclaw-plugin-sdk.mjs", import.meta.url),
      ),
    },
  },
});
