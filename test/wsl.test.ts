import { describe, it, expect } from "bun:test";
import { toWslPath, toWinPath, loadWslConfig } from "../src/config";
import { getWslDistros, getDefaultDistro, detectVenvs, executeWslBash, executeWslPython } from "../src/wsl";
import { rewriteCodeString } from "../bin/bridge";
import { wslBashRenderer, wslEvalRenderer, wslInfoRenderer } from "../src/render";
import { registerWslToolCallHooks } from "../src/hooks";

// Mock theme for ANSI renderer tests
const mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `[bold]${text}[/bold]`,
  format: { bracketLeft: "[", bracketRight: "]" },
  sep: { dot: " · " },
};

describe("Path Conversion", () => {
  it("converts Windows drive paths to WSL /mnt/ paths", () => {
    expect(toWslPath("C:\\project\\oh-my-wsl")).toBe("/mnt/c/project/oh-my-wsl");
    expect(toWslPath("C:/Users/mishap/vllm")).toBe("/mnt/c/Users/mishap/vllm");
    expect(toWslPath("d:\\data\\models")).toBe("/mnt/d/data/models");
  });

  it("converts UNC WSL paths to Linux absolute paths", () => {
    expect(toWslPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\mishap")).toBe("/home/mishap");
    expect(toWslPath("\\\\wsl$\\Ubuntu-24.04\\etc\\os-release")).toBe("/etc/os-release");
  });

  it("converts WSL paths back to Windows UNC paths", () => {
    expect(toWinPath("/home/mishap/vllm-env", "Ubuntu-24.04")).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\mishap\\vllm-env");
    expect(toWinPath("/mnt/c/project/oh-my-wsl", "Ubuntu-24.04")).toBe("C:\\project\\oh-my-wsl");
  });
});

describe("Bridge Code Rewriter", () => {
  it("rewrites __omp_cwd and __omp_env Windows paths to WSL paths", () => {
    const original = [
      "import os, sys",
      '__omp_cwd = "C:\\\\project\\\\oh-my-wsl"',
      "os.chdir(__omp_cwd)",
      '__omp_env = {"PI_SESSION_FILE":"C:\\\\Users\\\\mishap\\\\session.jsonl","PI_ARTIFACTS_DIR":"C:\\\\Users\\\\mishap\\\\artifacts","PI_TOOL_BRIDGE_URL":"http://127.0.0.1:59016"}',
      "for __omp_key, __omp_val in __omp_env.items():",
      "    os.environ[__omp_key] = __omp_val",
      "if __omp_cwd not in sys.path:",
      "    sys.path.insert(0, __omp_cwd)",
    ].join("\n");

    const rewritten = rewriteCodeString(original);
    expect(rewritten).toContain('__omp_cwd = "/mnt/c/project/oh-my-wsl"');
    expect(rewritten).toContain('"/mnt/c/Users/mishap/session.jsonl"');
    expect(rewritten).toContain('"/mnt/c/Users/mishap/artifacts"');
    expect(rewritten).toContain('"http://127.0.0.1:59016"');
  });

  it("leaves normal Python code untouched", () => {
    const code = "import math\nprint(math.sqrt(16))";
    expect(rewriteCodeString(code)).toBe(code);
  });
});

describe("WSL Environment Discovery", () => {
  it("lists WSL distributions and identifies running/default", () => {
    const distros = getWslDistros();
    expect(distros.length).toBeGreaterThan(0);
    const ubuntu = distros.find(d => d.name.includes("Ubuntu"));
    expect(ubuntu).toBeDefined();
    expect(getDefaultDistro()).toBeTruthy();
  });

  it("detects Python venvs in the default distro", () => {
    const venvs = detectVenvs("Ubuntu-24.04");
    expect(venvs.length).toBeGreaterThan(0);
    const vllmEnv = venvs.find(v => v.path.includes("vllm-env"));
    expect(vllmEnv).toBeDefined();
    expect(vllmEnv?.isVenv).toBe(true);
  });
});

describe("WSL Command Execution", () => {
  it("executes bash commands cleanly via executeWslBash", async () => {
    const res = await executeWslBash({
      command: "echo 'hello from wsl-test'; uname -s",
      distro: "Ubuntu-24.04",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello from wsl-test");
    expect(res.stdout).toContain("Linux");
  });

  it("executes Python code directly via executeWslPython", async () => {
    const res = await executeWslPython({
      code: "import sys\nprint('PLATFORM:', sys.platform)",
      distro: "Ubuntu-24.04",
      python: "/home/mishap/vllm-env/bin/python",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("PLATFORM: linux");
  });
});

describe("TSP Renderers", () => {
  it("wsl_bash describeCall returns clean runBox with distro badge", () => {
    const view = wslBashRenderer.describeCall(
      { command: "echo hello", distro: "Ubuntu-24.04" },
      { executionStarted: true },
    );
    expect(view.tool?.title).toBe("WSL Bash");
    expect(view.tool?.badges).toEqual([{ text: "Ubuntu-24.04", tone: "info", title: "WSL Distribution: Ubuntu-24.04" }]);
    expect(view.tool?.command).toBe("echo hello");
    expect(view.body).toBeDefined();
    expect(view.body![0].k).toBe("col");
    expect(view.body![0].p?.role).toBe("omp.run");
  });

  it("wsl_bash describeResult merges output and foot with exit code", () => {
    const view = wslBashRenderer.describeResult(
      {
        content: [{ type: "text", text: "output" }],
        details: { distro: "Ubuntu-24.04", stdout: "output", exitCode: 0, wallTimeMs: 120 },
      },
      { isPartial: false },
      { command: "echo hello" },
    );
    expect(view.tool?.exit).toBeUndefined(); // exit 0 is not an error chip
    const foot = view.body![0].c![2];
    expect(foot.k).toBe("row");
    expect(foot.p?.role).toBe("omp.run.foot");
  });

  it("wsl_eval describeCall shows venv badge and code input", () => {
    const view = wslEvalRenderer.describeCall(
      { code: "import sys", python: "/home/mishap/vllm-env/bin/python", distro: "Ubuntu-24.04" },
      { executionStarted: false },
    );
    expect(view.tool?.title).toBe("WSL Python");
    expect(view.tool?.badges).toEqual([
      { text: "vllm-env", tone: "accent", title: "/home/mishap/vllm-env/bin/python" },
      { text: "Ubuntu-24.04", tone: "info", title: "WSL Distribution: Ubuntu-24.04" },
    ]);
    expect(view.body![0].c![0].k).toBe("code");
    expect(view.body![0].c![0].p?.lang).toBe("python");
  });

  it("wsl_eval describeResult filters numa_balancing noise from stderr", () => {
    const view = wslEvalRenderer.describeResult(
      {
        content: [{ type: "text", text: "success" }],
        details: {
          stdout: "success",
          stderr: "cat: /proc/sys/kernel/numa_balancing: No such file or directory",
          exitCode: 0,
        },
      },
      { isPartial: false },
      { code: "print('success')" },
    );
    const body = view.body![0];
    const stdoutNode = body.c![1];
    expect(stdoutNode.k).toBe("ansi");
    expect(stdoutNode.p?.text).toBe("success");
    // stderr should be filtered out
    expect(body.c!.length).toBe(3); // input, stdout, foot
  });

  it("wsl_info describeResult renders tables and kv summary", () => {
    const view = wslInfoRenderer.describeResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          distros: [
            { name: "Ubuntu-24.04", state: "Running", version: 2, isDefault: true },
            { name: "docker-desktop", state: "Stopped", version: 2, isDefault: false },
          ],
          venvs: [{ path: "/home/mishap/vllm-env/bin/python", name: "vllm-env", isVenv: true }],
          config: { distro: "Ubuntu-24.04", python: "/home/mishap/vllm-env/bin/python" },
          activeDistro: "Ubuntu-24.04",
          activePython: "/home/mishap/vllm-env/bin/python",
          bridgeExists: true,
        },
      },
      { isPartial: false },
      {},
    );
    expect(view.tool?.title).toBe("WSL Environment");
    expect(view.tool?.badges).toEqual([
      { text: "Ubuntu-24.04", tone: "info" },
      { text: "vllm-env", tone: "accent" },
    ]);
    expect(view.tool?.meta).toEqual(["2 distros · 1 python envs"]);
    expect(view.body!.some(n => n.k === "kv")).toBe(true);
    expect(view.body!.some(n => n.k === "table")).toBe(true);
  });
});

describe("ANSI Renderers", () => {
  it("wsl_bash renderCall returns Text with title and highlighted command", () => {
    const comp = wslBashRenderer.renderCall(
      { command: "echo hello", distro: "Ubuntu-24.04" },
      { expanded: false },
      mockTheme as unknown as Parameters<typeof wslBashRenderer.renderCall>[2],
    );
    const lines = comp.render(80);
    expect(lines.join("\n")).toContain("[toolTitle][bold]WSL Bash[/bold][/toolTitle]");
    expect(lines.join("\n")).toContain("[info] [Ubuntu-24.04][/info]");
  });

  it("wsl_eval renderResult shows status icon, code, and output", () => {
    const comp = wslEvalRenderer.renderResult(
      {
        content: [{ type: "text", text: "output" }],
        details: { python: "/home/mishap/vllm-env/bin/python", stdout: "output", exitCode: 0, wallTimeMs: 500 },
      },
      { isPartial: false, expanded: false },
      mockTheme as unknown as Parameters<typeof wslEvalRenderer.renderResult>[2],
      { code: "print('output')", title: "test" },
    );
    const lines = comp.render(80);
    const text = lines.join("\n");
    expect(text).toContain("[success]✔[/success]");
    expect(text).toContain("[accent][vllm-env][/accent]");
    expect(text).toContain("0.50s");
  });
});

describe("Tool Call Hooks", () => {
  it("translates Linux paths to UNC paths for native tools", async () => {
    let capturedResult: unknown;
    const mockPi = {
      on: (event: string, handler: (event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>) => {
        if (event === "tool_call") {
          capturedResult = handler({
            toolName: "read",
            input: { path: "/home/mishap/project/file.py" },
          });
        }
      },
    } as unknown as ExtensionAPI;

    registerWslToolCallHooks(mockPi);

    const result = await (capturedResult as Promise<{ input: Record<string, unknown>; additionalContext: string }>);
    expect(result.input.path).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\mishap\\project\\file.py");
    expect(result.additionalContext).toContain("WSL bridge");
  });

  it("leaves Windows paths unchanged", async () => {
    let capturedResult: unknown;
    const mockPi = {
      on: (event: string, handler: (event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>) => {
        if (event === "tool_call") {
          capturedResult = handler({
            toolName: "read",
            input: { path: "C:\\project\\file.py" },
          });
        }
      },
    } as unknown as ExtensionAPI;

    registerWslToolCallHooks(mockPi);

    const result = await (capturedResult as Promise<unknown>);
    expect(result).toBeUndefined(); // no revision needed
  });

  it("provides guidance when nested wsl bash -c is used", async () => {
    let capturedResult: unknown;
    const mockPi = {
      on: (event: string, handler: (event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>) => {
        if (event === "tool_call") {
          capturedResult = handler({
            toolName: "bash",
            input: { command: 'wsl -d Ubuntu-24.04 -- bash -c "echo hello"' },
          });
        }
      },
    } as unknown as ExtensionAPI;

    registerWslToolCallHooks(mockPi);

    const result = await (capturedResult as Promise<{ additionalContext: string }>);
    expect(result.additionalContext).toContain("wsl_bash");
    expect(result.additionalContext).toContain("wsl_eval");
  });
});
