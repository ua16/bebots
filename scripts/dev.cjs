const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const extra = args.includes("--show-extra-logs");
const forwarded = args.filter((a) => a !== "--show-extra-logs");

const env = { ...process.env };
if (extra) env.SHOW_EXTRA_LOGS = "1";

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
