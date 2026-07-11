const { buildSync } = require("esbuild");
const { resolve } = require("path");

const root = resolve(__dirname, "..");

buildSync({
  entryPoints: [resolve(root, "src/main.ts").replace(/\\/g, "/")],
  bundle: true,
  format: "esm",
  target: "es2020",
  outfile: resolve(root, "behavior_pack/scripts/main.js").replace(/\\/g, "/"),
  external: ["@minecraft/server", "@minecraft/server-ui"],
});

console.log("Build complete!");
