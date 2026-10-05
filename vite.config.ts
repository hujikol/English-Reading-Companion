import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    env: {
      // Some CLI scripts under scripts/ run their main() when their own file is
      // the entry. A test importing one would take that branch and exit the
      // runner, so they check for this flag. Set here, not in the test file,
      // because it must be set BEFORE any module is imported.
      ERC_NO_CLI: "1",
    },
  },
});
