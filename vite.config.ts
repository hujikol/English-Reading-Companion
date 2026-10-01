import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ponytail: no proxy, no env plumbing — nothing calls an API yet.
export default defineConfig({ plugins: [react()] });
