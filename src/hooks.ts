import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadWslConfig, toWinPath } from "./config";

/**
 * Built-in native file tools whose path arguments we can transparently route
 * into the active WSL distro via UNC paths (\\wsl.localhost\<distro>\...).
 */
const PATH_TOOL_PATH_KEYS: Record<string, readonly string[]> = {
  read: ["path"],
  write: ["path"],
  edit: ["path", "paths"],
  glob: ["path"],
  grep: ["path", "paths"],
  find: ["path"],
};

function isLinuxAbsolutePath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false; // already UNC-style
  if (value.startsWith("/mnt/")) return false; // already a WSL mount point
  return true;
}

function translatePathString(value: string, distro: string): { text: string; changed: boolean } {
  if (!isLinuxAbsolutePath(value)) return { text: value, changed: false };
  const unc = toWinPath(value, distro);
  return { text: unc, changed: unc !== value };
}

function translatePathsInValue(value: unknown, distro: string): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const { text, changed } = translatePathString(value, distro);
    return { value: text, changed };
  }
  if (Array.isArray(value)) {
    let anyChanged = false;
    const out = value.map(item => {
      const res = translatePathsInValue(item, distro);
      anyChanged ||= res.changed;
      return res.value;
    });
    return { value: out, changed: anyChanged };
  }
  return { value, changed: false };
}

export function registerWslToolCallHooks(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const config = loadWslConfig();
    const distro = config.distro || "Ubuntu-24.04";

    // 1. Intercept direct `wsl` shell commands in the built-in bash tool
    if (event.toolName === "bash") {
      const input = event.input as { command?: unknown };
      if (typeof input?.command === "string" && /^\s*wsl(\.exe)?\s+(-d\s+\S+\s+)?(--\s+)?bash\s+-c/i.test(input.command)) {
        return {
          additionalContext:
            "Notice: `wsl_bash` and `wsl_eval` tools are available. Use them to execute commands directly inside WSL without nesting `wsl -d ... -- bash -c` and escaping quotes.",
        };
      }
      return;
    }

    // 2. Auto-translate Linux paths for native built-in tools (read, grep, glob, etc.)
    const pathKeys = PATH_TOOL_PATH_KEYS[event.toolName];
    if (!pathKeys) return;

    const rawInput = event.input;
    if (!rawInput || typeof rawInput !== "object") return;

    let changed = false;
    const revised: Record<string, unknown> = { ...rawInput };

    for (const key of pathKeys) {
      if (!(key in revised)) continue;
      const original = revised[key];
      const res = translatePathsInValue(original, distro);
      if (res.changed) {
        revised[key] = res.value;
        changed = true;
      }
    }

    if (!changed) return;

    return {
      input: revised,
      additionalContext: `WSL bridge: translated Linux path(s) in ${event.toolName} arguments to native UNC paths under \\wsl.localhost\\${distro}\\. No need to call wsl -d ... -- bash -c.`,
    };
  });
}
