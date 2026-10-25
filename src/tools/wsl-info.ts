import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getWslDistros, detectVenvs, getDefaultDistro } from "../wsl";
import { loadWslConfig, getBridgeBinaryPath } from "../config";
import { wslInfoRenderer, type WslInfoDetails } from "../render";
import * as fs from "node:fs";

export function registerWslInfoTool(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "wsl_info",
    label: "WSL Environment",
    description: "Inspect installed WSL distributions, running status, detected Python virtual environments, and active WSL configuration for oh-my-pi.",
    parameters: z.object({
      distro: z.string().optional().describe("Optional specific distro to inspect for Python environments"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadWslConfig(ctx.cwd);
      const distros = getWslDistros();
      const defaultDistro = getDefaultDistro();
      const targetDistro = params.distro || config.distro || defaultDistro;
      const venvs = detectVenvs(targetDistro);
      const bridgeExe = getBridgeBinaryPath();
      const bridgeExists = fs.existsSync(bridgeExe);
      const activePython = config.python || (venvs[0]?.path ?? "/usr/bin/python3");

      const lines: string[] = [];
      lines.push("### WSL Distributions");
      if (distros.length === 0) {
        lines.push("- No WSL distributions found or WSL is not running.");
      } else {
        for (const d of distros) {
          const defMark = d.isDefault ? " *(default)*" : "";
          const activeMark = d.name === targetDistro ? " **[active]**" : "";
          lines.push(`- **${d.name}** (v${d.version}, ${d.state})${defMark}${activeMark}`);
        }
      }

      lines.push("");
      lines.push(`### Detected Python Environments in \`${targetDistro}\``);
      if (venvs.length === 0) {
        lines.push("- No Python virtual environments detected.");
      } else {
        for (const env of venvs) {
          const activeMark = env.path === config.python ? " **[configured]**" : "";
          lines.push(`- \`${env.path}\` (${env.name})${activeMark}`);
        }
      }

      lines.push("");
      lines.push("### Plugin Configuration");
      lines.push(`- Active Distro: \`${targetDistro}\``);
      lines.push(`- Active Python: \`${activePython}\``);
      lines.push(`- Built-in Eval Routing: \`${config.routeEval ? "enabled" : "disabled"}\``);
      lines.push(`- Python Bridge Binary: \`${bridgeExe}\` (${bridgeExists ? "built" : "missing"})`);

      const details: WslInfoDetails = {
        distros,
        venvs,
        config,
        activeDistro: targetDistro,
        activePython,
        bridgeExists,
      };

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details,
      };
    },
    describeCall: wslInfoRenderer.describeCall,
    describeResult: wslInfoRenderer.describeResult,
    renderCall: wslInfoRenderer.renderCall,
    renderResult: wslInfoRenderer.renderResult,
  } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
}
