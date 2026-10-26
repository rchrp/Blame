// Portable counterpart of fake-wsl.cs for running the PowerShell suite on Unix.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const env = process.env;
const stdout = (text) => process.stdout.write(text);
const stderr = (text) => process.stderr.write(text);
appendFileSync(env.BLAME_TEST_WSL_LOG, `${JSON.stringify(args)}\n`);
let code = 0;
if (args[0] === "--echo") stdout(JSON.stringify(args));
else if (args[0] === "--warning") {
  stdout("ok");
  stderr("warning");
} else if (args[0] === "--fail") {
  stdout("partial");
  stderr("failed");
  code = 23;
} else if (args[0] === "--flood") {
  stdout("o".repeat(262144));
  stderr("e".repeat(262144));
  stdout(readFileSync(0, "utf8"));
} else if (args[0] === "--status") stderr("WSL warning");
else if (args[0] === "--list") {
  stdout("  NAME STATE VERSION\n* BlameRuntime Running 2\n");
  stderr("list warning");
  if (env.BLAME_TEST_WSL_FAIL === "list") code = 19;
} else if (args[0] === "--unregister") {
  stderr("unregister failed");
  code = 17;
} else if (args[4] !== "--exec") {
  stderr("Guest commands must bypass the default shell");
  code = 80;
} else if (args[5] === "wslpath") {
  stdout(`${env.BLAME_TEST_WSL_PATH}\n`);
  stderr("translation warning");
  if (env.BLAME_TEST_WSL_FAIL === "wslpath") code = 21;
} else if (args[5] === "cp") {
  if (env.BLAME_TEST_WSL_FAIL === "cp") code = 22;
} else if (args[5] === "sh" && args[6] === "-s") {
  const content = readFileSync(0, "utf8");
  writeFileSync(env.BLAME_TEST_WSL_INPUT, content);
  stdout(content);
  stderr("script warning");
  if (env.BLAME_TEST_WSL_FAIL === "provision") code = 24;
} else {
  stdout(JSON.stringify(args));
  stderr("command warning");
  code = 29;
}
process.exitCode = code;
