// Builds crates/crypto-wasm and lays the result out as an npm package.
//
// Deliberately not wasm-pack. wasm-pack fetches its own toolchain at build
// time, which is a network dependency in the middle of a build and a version
// this repository does not pin -- and rule 8 says every dependency is pinned.
// `wasm-bindgen-cli` is installed once, at an exact version that must match
// the `wasm-bindgen` crate in Cargo.toml, and this script does the twenty
// lines of layout wasm-pack would otherwise do.
//
//   node scripts/build.mjs              build it
//   node scripts/build.mjs --if-missing only build when pkg/ is absent
//
// The output is NOT committed. CI builds it; a clone builds it once.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..", "pkg");
const repoRoot = resolve(here, "..", "..", "..");

if (process.argv.includes("--if-missing") && existsSync(join(pkgDir, "nexo_crypto_wasm.js"))) {
  console.log("crypto-wasm: pkg/ is already built");
  process.exit(0);
}

// The CLI and the crate must agree exactly; a mismatch produces a module that
// loads and then fails on the first call, which is a bad way to find out.
const wanted = readFileSync(join(repoRoot, "crates", "crypto-wasm", "Cargo.toml"), "utf8")
  .match(/^wasm-bindgen = "=([\d.]+)"/m)?.[1];
if (!wanted) throw new Error("could not read the pinned wasm-bindgen version");

let installed;
try {
  installed = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim().split(/\s+/).pop();
} catch {
  throw new Error(
    `wasm-bindgen-cli is not installed. Run:\n` +
      `  cargo install wasm-bindgen-cli --version ${wanted} --locked`,
  );
}
if (installed !== wanted) {
  throw new Error(
    `wasm-bindgen-cli is ${installed}, the crate is pinned to ${wanted}. Run:\n` +
      `  cargo install wasm-bindgen-cli --version ${wanted} --locked`,
  );
}

const run = (cmd, args) => {
  console.log(`crypto-wasm: ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
};

run("cargo", [
  "build",
  "-p",
  "nexo-crypto-wasm",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
]);

rmSync(pkgDir, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });

// `nodejs` rather than `bundler`: the tests run in Node, and the target only
// decides the shape of the generated glue. Wave 8 adds a `web` build beside
// this one when there is a page to load it from.
run("wasm-bindgen", [
  join(repoRoot, "target", "wasm32-unknown-unknown", "release", "nexo_crypto_wasm.wasm"),
  "--out-dir",
  pkgDir,
  "--target",
  "nodejs",
]);

console.log(`crypto-wasm: built into ${pkgDir}`);
