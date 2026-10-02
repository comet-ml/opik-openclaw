import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Every openclaw/plugin-sdk subpath the plugin imports resolves to the same local stub.
    alias: [
      {
        find: /^openclaw\/plugin-sdk(\/.*)?$/,
        replacement: fileURLToPath(
          new URL("./.scripts/vitest-openclaw-plugin-sdk.mjs", import.meta.url),
        ),
      },
    ],
  },
});
