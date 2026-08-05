import { spawnSync } from "node:child_process";
import "./prepare-rustpush.mjs";

const platformFeatures = process.platform === "darwin"
  ? ["--no-default-features", "--features", "nac-apple-framework"]
  : ["--features", "hardware-key"];

const result = spawnSync(
  process.platform === "win32" ? "cargo.exe" : "cargo",
  [
    "build",
    "--release",
    "--manifest-path",
    "pkg/rustpushgo/Cargo.toml",
    "--bin",
    "iblue-native",
    ...platformFeatures,
  ],
  { stdio: "inherit", shell: false },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
