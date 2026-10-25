import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerWslEvalTool } from "./src/tools/wsl-eval";
import { registerWslBashTool } from "./src/tools/wsl-bash";
import { registerWslInfoTool } from "./src/tools/wsl-info";
import { registerWslCommand } from "./src/commands/wsl-command";
import { registerWslToolCallHooks } from "./src/hooks";
import { loadWslConfig } from "./src/config";
import { ensureBridgeExecutable, getDefaultDistro } from "./src/wsl";
import * as path from "node:path";

export default function wslPlugin(pi: ExtensionAPI) {
  pi.setLabel("WSL Integration");

  // Register tools
  registerWslEvalTool(pi);
  registerWslBashTool(pi);
  registerWslInfoTool(pi);

  // Register command
  registerWslCommand(pi);

  // Register tool_call hooks for path translation and wsl bash interception
  registerWslToolCallHooks(pi);

  // Session start hook
  pi.on("session_start", async (_event, ctx) => {
    const config = loadWslConfig(ctx.cwd);
    const distro = config.distro || getDefaultDistro();

    // Ensure bridge executable is present
    const bridgeExe = ensureBridgeExecutable(path.resolve(__dirname));

    // If eval routing is enabled, apply runtime override to python.interpreter
    if (config.routeEval !== false) {
      try {
        // Exception: Optional host runtime subpath provided by omp container that is not resolvable during external standalone builds
        const registry = await import("@oh-my-pi/pi-coding-agent/config/registry").catch(() => null);
        if (registry && typeof registry.lookup === "function" && pi.pi && "settings" in pi.pi) {
          const pySetting = registry.lookup("python.interpreter");
          if (pySetting) {
            pySetting.override(pi.pi.settings, bridgeExe);
          }
        }
      } catch {}
    }

    ctx.ui.notify(`WSL Integration active (${distro})`, "info");
  });
}
