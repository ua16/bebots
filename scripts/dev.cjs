const { spawn } = require("node:child_process");

const args = process.argv.slice(2);

// Feature flags are converted to env vars (read in apps/desktop/src/main/index.ts)
// instead of being forwarded to the electron-vite CLI, which rejects unknown options.
const FLAG_ENV = {
  "--show-extra-logs": "SHOW_EXTRA_LOGS",
  "--show-mcp-logs": "SHOW_MCP_LOGS",
  "--show-scheduling-logs": "SHOW_SCHEDULING_LOGS",
  "--headless": "BEBOTS_HEADLESS",
};
const flagNames = Object.keys(FLAG_ENV);
const forwarded = args.filter((a) => !flagNames.includes(a));

const env = { ...process.env };
for (const flag of flagNames) {
  if (args.includes(flag)) env[FLAG_ENV[flag]] = "1";
}

const child = spawn("bun", ["run", "--cwd", "apps/desktop", "dev", ...forwarded], {
  stdio: "inherit",
  env,
  shell: true,
  cwd: require("node:path").join(__dirname, ".."),
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
