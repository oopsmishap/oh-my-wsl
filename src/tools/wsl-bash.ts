import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { executeWslBash } from "../wsl";
import { loadWslConfig } from "../config";
import { wslBashRenderer, type WslBashDetails } from "../render";

export function registerWslBashTool(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "wsl_bash",
    label: "WSL Bash",
    description: "Execute shell commands directly inside Windows Subsystem for Linux (WSL). Bypasses Windows shell escaping, handles complex pipelines/heredocs cleanly, and avoids nesting 'wsl -d ... -- bash -c \"...\"' command strings.",
    parameters: z.object({
      command: z.string().describe("Bash shell script or command line to execute inside WSL"),
      distro: z.string().optional().describe("WSL distribution name (e.g. Ubuntu-24.04). Defaults to configured or default distro"),
      cwd: z.string().optional().describe("Working directory inside WSL or Windows path (e.g. /mnt/c/project or C:\\project)"),
      env: z.record(z.string()).optional().describe("Environment variables to export inside WSL for this execution"),
      timeout: z.number().optional().describe("Execution timeout in seconds (default: 300)"),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Cancelled" }],
          details: { cancelled: true },
          isError: true,
        };
      }

      const config = loadWslConfig(ctx.cwd);
      const targetDistro = params.distro || config.distro;
      const targetCwd = params.cwd || ctx.cwd;

      let liveStdout = "";
      let liveStderr = "";

      try {
        const result = await executeWslBash({
          command: params.command,
          distro: targetDistro,
          cwd: targetCwd,
          env: params.env,
          timeout: params.timeout,
          signal,
          onChunk: (chunk) => {
            let changed = false;
            if (chunk.stdout) {
              liveStdout += chunk.stdout;
              changed = true;
            }
            if (chunk.stderr) {
              liveStderr += chunk.stderr;
              changed = true;
            }
            if (changed && onUpdate) {
              const liveDetails: WslBashDetails = {
                distro: targetDistro,
                stdout: liveStdout,
                stderr: liveStderr,
              };
              onUpdate({
                content: [{ type: "text", text: liveStdout }],
                details: liveDetails,
              });
            }
          },
        });

        const stdout = result.stdout;
        const stderr = result.stderr;
        let modelText = stdout;
        if (stderr) {
          modelText += modelText ? `\n[stderr]\n${stderr}` : `[stderr]\n${stderr}`;
        }
        if (result.exitCode !== 0) {
          modelText += modelText ? `\nCommand exited with code ${result.exitCode}` : `Command exited with code ${result.exitCode}`;
        }
        if (!modelText) modelText = "(no output)";

        const details: WslBashDetails = {
          distro: targetDistro,
          stdout,
          stderr,
          exitCode: result.exitCode,
          wallTimeMs: result.wallTimeMs,
          timedOut: result.timedOut,
        };

        return {
          content: [{ type: "text", text: modelText }],
          details,
          isError: result.exitCode !== 0 || result.timedOut,
        };
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `WSL Bash execution error: ${errorMessage}` }],
          details: {
            distro: targetDistro,
            error: errorMessage,
          },
          isError: true,
        };
      }
    },
    describeCall: wslBashRenderer.describeCall,
    describeResult: wslBashRenderer.describeResult,
    renderCall: wslBashRenderer.renderCall,
    renderResult: wslBashRenderer.renderResult,
  } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
}
