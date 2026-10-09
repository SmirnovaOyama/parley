// Runs the API and restarts it when a file under server/ changes. (Node's own --watch also reacts
// to activity inside node_modules on macOS, which restarts the server in a loop.)
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";

let child: ChildProcess | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function start() {
  child = spawn(process.execPath, ["--env-file-if-exists=.env", "server/index.ts"], { stdio: "inherit" });
}

function restart(file: string) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`Restarting the API (${file} changed)`);
    if (child && child.exitCode === null) {
      child.once("exit", start);
      child.kill();
    } else {
      start();
    }
  }, 100);
}

watch("server", { recursive: true }, (_event, file) => {
  if (file && /\.ts$/.test(file)) restart(`server/${file}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child?.kill();
    process.exit(0);
  });
}

start();
