const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const electronDir = path.join(process.cwd(), "apps", "desktop", "node_modules", "electron");
const pkgPath = path.join(electronDir, "package.json");

if (!fs.existsSync(pkgPath)) {
  console.log("electron not installed; skipping");
  process.exit(0);
}

const { version } = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

function platformPath() {
  switch (process.platform) {
    case "darwin":
    case "mas":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
    case "freebsd":
    case "openbsd":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error("Unsupported platform: " + process.platform);
  }
}

const target = platformPath();
const pathFile = path.join(electronDir, "path.txt");
const binaryPath = path.join(electronDir, "dist", target);

if (fs.existsSync(pathFile) && fs.existsSync(binaryPath)) {
  try {
    if (fs.readFileSync(pathFile, "utf8").trim() === target) {
      console.log("electron already installed");
      process.exit(0);
    }
  } catch {
    // fall through
  }
}

const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
const platform =
  process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const zipName = `electron-v${version}-${platform}-${arch}.zip`;
const cacheDir = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  "Library",
  "Caches",
  "electron",
);
const cachedZip = path.join(cacheDir, zipName.replace(/[^a-zA-Z0-9._-]/g, "_"));

// Try to find any cached zip matching version
let zipPath = null;
if (fs.existsSync(cachedZip)) zipPath = cachedZip;
if (!zipPath) {
  // search cache dir
  try {
    const files = fs.readdirSync(cacheDir);
    const found = files.find((f) => f.includes(version) && f.endsWith(".zip"));
    if (found) zipPath = path.join(cacheDir, found);
  } catch {
    // ignore
  }
}

if (!zipPath) {
  const url = `https://github.com/electron/electron/releases/download/v${version}/${zipName}`;
  zipPath = path.join(electronDir, zipName);
  console.log(`Downloading ${url}`);
  // synchronous download via execSync curl
  execFileSync("curl", ["-L", "-o", zipPath, url], { stdio: "inherit" });
}

// extract
const distDir = path.join(electronDir, "dist");
fs.mkdirSync(distDir, { recursive: true });
if (process.platform === "win32") {
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${distDir}' -Force`,
    ],
    {
      stdio: "inherit",
    },
  );
} else {
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", distDir], { stdio: "inherit" });
}

fs.writeFileSync(pathFile, target);
console.log("electron installed");
