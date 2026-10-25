import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getWslDistros, detectVenvs, getDefaultDistro, executeWslBash, executeWslPython, resolveTargetPython } from "../wsl";
import { loadWslConfig, saveWslConfig, getBridgeBinaryPath } from "../config";
import * as fs from "node:fs";

interface WslOverlayComponent {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  dispose?(): void;
}

export function registerWslCommand(pi: ExtensionAPI) {
  pi.registerCommand("wsl", {
    description: "Manage WSL integration (status, switch distro, switch venv, toggle built-in eval routing)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcmd = parts[0]?.toLowerCase() || "status";
      const value = parts.slice(1).join(" ").trim();
      const config = loadWslConfig(ctx.cwd);
      const defaultDistro = getDefaultDistro();
      const currentDistro = config.distro || defaultDistro;

      const exitSummary = (text: string) => {
        ctx.ui.notify(text, "info");
      };

      if (subcmd === "status") {
        const venvs = detectVenvs(currentDistro);
        const bridgeExe = getBridgeBinaryPath();
        const bridgeExists = fs.existsSync(bridgeExe);

        exitSummary(
          `WSL Status:\n` +
          `• Distro: ${currentDistro}\n` +
          `• Python: ${config.python || (venvs[0]?.path ?? "/usr/bin/python3")}\n` +
          `• Eval Routing: ${config.routeEval ? "enabled" : "disabled"}\n` +
          `• Bridge Exe: ${bridgeExists ? "ready" : "missing"}`
        );
        return;
      }

      if (subcmd === "distro") {
        if (!value) {
          const distros = getWslDistros();
          const list = distros.map(d => `${d.name} (${d.state})${d.name === currentDistro ? " [active]" : ""}`).join("\n");
          exitSummary(`Available distros:\n${list}\n\nUsage: /wsl distro <name>`);
          return;
        }

        saveWslConfig({ distro: value }, "project", ctx.cwd);
        exitSummary(`Active WSL distro set to "${value}" (saved to .omp/wsl.json)`);
        return;
      }

      if (subcmd === "venv" || subcmd === "python") {
        if (!value) {
          const venvs = detectVenvs(currentDistro);
          const list = venvs.map(v => `${v.path} (${v.name})${v.path === config.python ? " [active]" : ""}`).join("\n");
          exitSummary(`Detected Python environments in ${currentDistro}:\n${list}\n\nUsage: /wsl venv <path>`);
          return;
        }

        saveWslConfig({ python: value }, "project", ctx.cwd);
        exitSummary(`WSL Python interpreter set to "${value}" (saved to .omp/wsl.json)`);
        return;
      }

      if (subcmd === "eval") {
        const flag = value.toLowerCase();
        let enable = !config.routeEval;
        if (flag === "on" || flag === "true" || flag === "1" || flag === "enable") {
          enable = true;
        } else if (flag === "off" || flag === "false" || flag === "0" || flag === "disable") {
          enable = false;
        }

        saveWslConfig({ routeEval: enable }, "project", ctx.cwd);
        const bridgeExe = getBridgeBinaryPath();

        if (enable) {
          exitSummary(`Built-in eval routing to WSL enabled.\nBridge: ${bridgeExe}`);
        } else {
          exitSummary("Built-in eval routing to WSL disabled.");
        }
        return;
      }

      if (subcmd === "list") {
        const distros = getWslDistros();
        const venvs = detectVenvs(currentDistro);
        const distroStr = distros.map(d => `• ${d.name} (v${d.version}, ${d.state})${d.isDefault ? " [default]" : ""}`).join("\n");
        const venvStr = venvs.map(v => `• ${v.path} (${v.name})`).join("\n");

        exitSummary(
          `Distributions:\n${distroStr}\n\n` +
          `Python Environments in ${currentDistro}:\n${venvStr || "• None found"}`
        );
        return;
      }

      if (subcmd === "build") {
        exitSummary("Compiling standalone wsl-python-bridge.exe...");
        const exePath = getBridgeBinaryPath();
        exitSummary(`Bridge ready at: ${exePath}`);
        return;
      }

      // /wsl bash <command> and /wsl eval <code>
      if (subcmd === "bash" || subcmd === "eval") {
        if (!value) {
          exitSummary(`Usage: /wsl ${subcmd} <${subcmd === "bash" ? "command" : "python code"}>`);
          return;
        }
        if (!ctx.hasUI) {
          exitSummary("Interactive UI not available for streaming /wsl execution.");
          return;
        }

        const overlayTitle = `WSL ${subcmd === "bash" ? "Bash" : "Python Eval"}`;
        let output = "";
        let cancelled = false;
        const controller = new AbortController();
        let done = false;

        ctx.ui.custom<undefined>((_tui, theme, _kb, finish) => {
          const renderOverlay = (): readonly string[] => {
            const lines = output.split("\n");
            const body = lines.slice(-40).join("\n");
            const rows: string[] = [
              theme.fg("accent", `══ ${overlayTitle} ══`),
              theme.fg("dim", `Distro: ${currentDistro}`),
              "",
              theme.fg("toolOutput", body || "(waiting for output...)"),
              "",
            ];
            const footerText = cancelled
              ? theme.fg("warning", "Cancelled")
              : done
                ? theme.fg("success", "Done — press Esc to close")
                : theme.fg("muted", "Running... (Esc to cancel)");
            rows.push(footerText);
            return rows;
          };

          const component: WslOverlayComponent = {
            render(_width: number): readonly string[] {
              return renderOverlay();
            },
            handleInput(data: string) {
              if (data === "\u001b") {
                if (!done && !cancelled) {
                  cancelled = true;
                  controller.abort();
                }
                finish(undefined);
              }
            },
            dispose() {},
          };

          return component;
        });

        try {
          if (subcmd === "bash") {
            const res = await executeWslBash({
              command: value,
              distro: currentDistro,
              cwd: ctx.cwd,
              signal: controller.signal,
              onChunk: chunk => {
                output += chunk.stdout ?? "";
                if (chunk.stderr) output += `[stderr] ${chunk.stderr}`;
              },
            });
            output = res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : "");
            done = true;
          } else {
            const res = await executeWslPython({
              code: value,
              distro: currentDistro,
              python: config.python || resolveTargetPython(currentDistro),
              cwd: ctx.cwd,
              signal: controller.signal,
              onChunk: chunk => {
                output += chunk.stdout ?? "";
                if (chunk.stderr) output += `[stderr] ${chunk.stderr}`;
              },
            });
            output = res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : "");
            done = true;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          output += `\nError: ${msg}`;
          done = true;
        }
        return;
      }

      exitSummary(
        `Unknown subcommand "${subcmd}". Valid options:\n` +
        `/wsl status         - Show current WSL settings\n` +
        `/wsl eval on|off    - Toggle routing built-in eval to WSL\n` +
        `/wsl distro <name>  - Select WSL distribution\n` +
        `/wsl venv <path>    - Select Python virtual environment\n` +
        `/wsl bash <cmd>     - Run bash command in WSL\n` +
        `/wsl eval <code>    - Run Python code in WSL\n` +
        `/wsl list           - List distros and Python environments\n` +
        `/wsl build          - Rebuild bridge binary`
      );
    },
  });
}
