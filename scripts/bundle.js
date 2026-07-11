// Bundles the addon into a .mcaddon. Asks whether this is a dev pack first.
const { execSync } = require("child_process");
const { existsSync, readFileSync, writeFileSync } = require("fs");
const { resolve, join } = require("path");
const readline = require("readline");

const ROOT = resolve(__dirname, "..");
const BP_SRC = join(ROOT, "behavior_pack");
const DEV_SUFFIX = "-dev";

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveAnswer(answer.trim());
    });
  });
}

function patchManifest(manifestPath, isDev) {
  if (!existsSync(manifestPath)) return null;
  const original = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  manifest.header = manifest.header || {};
  const name = manifest.header.name || "";
  let nextName = name;
  if (isDev && !name.endsWith(DEV_SUFFIX)) {
    nextName = name + DEV_SUFFIX;
  } else if (!isDev && name.endsWith(DEV_SUFFIX)) {
    nextName = name.slice(0, -DEV_SUFFIX.length);
  }
  if (nextName !== name) {
    manifest.header.name = nextName;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  return original;
}

function restoreManifest(manifestPath, original) {
  if (original != null) writeFileSync(manifestPath, original);
}

async function main() {
  const answer = await prompt("Is this a dev pack? (y/N): ");
  const isDev = /^y(es)?$/i.test(answer);

  const manifestPaths = [join(BP_SRC, "manifest.json")];

  const patched = [];
  for (const manifestPath of manifestPaths) {
    const original = patchManifest(manifestPath, isDev);
    if (original != null) patched.push([manifestPath, original]);
  }

  try {
    execSync("npm run build", { stdio: "inherit", cwd: ROOT });
    const deployEnv = { ...process.env, SKIP_BUILD: "1" };
    if (isDev) deployEnv.DEV_PACK = "1";
    execSync("node scripts/deploy.js prod", { stdio: "inherit", cwd: ROOT, env: deployEnv });
  } finally {
    for (const [manifestPath, original] of patched) {
      restoreManifest(manifestPath, original);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
