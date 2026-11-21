import { spawn } from "node:child_process";
import koffi from "koffi";

const ctrlBreakEvent = 1;
const allProcessesOnTheConsole = 0;
const hideWindow = 0;
const relayFailedExit = 90;

const kernel = koffi.load("kernel32.dll");
const freeConsole = kernel.func("int __stdcall FreeConsole()");
const allocConsole = kernel.func("int __stdcall AllocConsole()");
const getConsoleWindow = kernel.func("void* __stdcall GetConsoleWindow()");
const HandlerRoutine = koffi.proto("int __stdcall HandlerRoutine(uint32_t event)");
const setConsoleCtrlHandler = kernel.func("int __stdcall SetConsoleCtrlHandler(HandlerRoutine* handler, int add)");
const generateConsoleCtrlEvent = kernel.func("int __stdcall GenerateConsoleCtrlEvent(uint32_t event, uint32_t group)");
const showWindow = koffi.load("user32.dll").func("int __stdcall ShowWindow(void* window, int command)");

function failRelay(why: string): never {
  console.error(`console-relay: ${why}`);
  process.exit(relayFailedExit);
}

/**
 * `node console-relay.ts <program> <arguments...>`, on Windows only: runs the program on a console of its own and, on
 * any line written to the relay's stdin, sends that console CTRL_BREAK_EVENT, which Node delivers to the program as
 * SIGBREAK. It exits with the code the program exited with.
 *
 * @implNote Node's `kill` on Windows terminates a child outright for every signal, and a console control event reaches
 * only the processes sharing the sender's console, so the relay gives up the console it inherited, allocates a fresh
 * one holding just itself and the program, and swallows the event itself through a handler of its own: Node's own
 * handler, registered before the console existed, does not keep it alive.
 */
function relay(program: string | undefined, programArguments: readonly string[]): void {
  if (program === undefined) {
    failRelay("usage: console-relay <program> [arguments...]");
  }
  freeConsole();
  if (allocConsole() === 0) {
    failRelay("AllocConsole failed");
  }
  const consoleWindow = getConsoleWindow();
  if (consoleWindow !== null) {
    showWindow(consoleWindow, hideWindow);
  }
  const swallowEvent = koffi.register(() => 1, koffi.pointer(HandlerRoutine));
  if (setConsoleCtrlHandler(swallowEvent, 1) === 0) {
    failRelay("SetConsoleCtrlHandler failed");
  }

  const child = spawn(program, programArguments, { stdio: ["ignore", "inherit", "inherit"] });
  process.stdin.on("data", () => {
    if (generateConsoleCtrlEvent(ctrlBreakEvent, allProcessesOnTheConsole) === 0) {
      console.error("console-relay: GenerateConsoleCtrlEvent failed");
    }
  });
  child.on("error", (error) => failRelay(error.message));
  child.on("exit", (code) => process.exit(code ?? relayFailedExit));
}

const [program, ...programArguments] = process.argv.slice(2);
relay(program, programArguments);
