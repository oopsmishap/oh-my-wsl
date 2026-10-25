import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { executeWslPython, resolveTargetPython } from "../wsl";
import { loadWslConfig } from "../config";
import { wslEvalRenderer, type WslEvalArgs, type WslEvalDetails } from "../render";

export function registerWslEvalTool(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "wsl_eval",
    label: "WSL Python",
    description: "Execute Python code directly inside Windows Subsystem for Linux (WSL). Runs in the selected distribution and virtual environment (e.g. /home/mishap/vllm-env/bin/python) without nested bash -c or quote-escaping issues.",
    parameters: z.object({
      code: z.string().describe("Python source code to execute inside WSL"),
      title: z.string().optional().describe("Short transcript label (e.g. 'inspect vllm config')"),
      distro: z.string().optional().describe("WSL distribution name (e.g. Ubuntu-24.04). Defaults to configured or default distro"),
      python: z.string().optional().describe("Python binary or virtualenv path inside WSL (e.g. /home/mishap/vllm-env/bin/python)"),
      cwd: z.string().optional().describe("Working directory inside WSL or Windows path (e.g. /mnt/c/project or C:\\project)"),
      timeout: z.number().optional().describe("Execution timeout in seconds (default: 60)"),
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
      const targetPython = params.python || config.python || resolveTargetPython(targetDistro);
      const targetCwd = params.cwd || ctx.cwd;

      let liveStdout = "";
      let liveStderr = "";

      try {
        const result = await executeWslPython({
          code: params.code,
          distro: targetDistro,
          python: targetPython,
          cwd: targetCwd,
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
              const liveDetails: WslEvalDetails = {
                distro: targetDistro,
                python: targetPython,
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

        const details: WslEvalDetails = {
          distro: targetDistro,
          python: targetPython,
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
          content: [{ type: "text", text: `WSL Python execution error: ${errorMessage}` }],
          details: {
            distro: targetDistro,
            python: targetPython,
            error: errorMessage,
          },
          isError: true,
        };
      }
    },
    describeCall: wslEvalRenderer.describeCall,
    describeResult: wslEvalRenderer.describeResult,
    renderCall: wslEvalRenderer.renderCall,
    renderResult: wslEvalRenderer.renderResult,
  } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
}
