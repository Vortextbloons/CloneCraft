const { buildSync } = require("esbuild");
const { resolve } = require("path");

const root = resolve(__dirname, "..");

buildSync({
  absWorkingDir: root,
  entryPoints: ["./src/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2020",
  outfile: "./behavior_pack/scripts/main.js",
  external: ["@minecraft/server", "@minecraft/server-ui"],
});

console.log("Build complete!");
