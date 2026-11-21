import { execFileSync } from "node:child_process";

interface ProcessRow {
  readonly pid: number;
  readonly parent: number;
}

function windowsProcessRows(): ProcessRow[] {
  const csv = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }"],
    { encoding: "utf8" },
  );
  return csv
    .split(/\r?\n/)
    .filter((line) => line.includes(","))
    .map((line) => {
      const [pid, parent] = line.split(",").map(Number);
      return { pid: pid!, parent: parent! };
    });
}

function posixProcessRows(): ProcessRow[] {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((fields) => fields.length === 2 && fields.every(Number.isInteger))
    .map(([pid, parent]) => ({ pid: pid!, parent: parent! }));
}

/** `root` and every process descended from it that is running now. */
export function processTreeOf(root: number): number[] {
  const rows = process.platform === "win32" ? windowsProcessRows() : posixProcessRows();
  const tree = [root];
  for (let index = 0; index < tree.length; index++) {
    const parent = tree[index];
    tree.push(...rows.filter((row) => row.parent === parent && row.pid !== parent).map((row) => row.pid));
  }
  return tree;
}

/** Whether a process of that pid exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
