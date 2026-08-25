import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "puppetloom-web.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
    minify: "esbuild",
    sourcemap: true
  }
});
