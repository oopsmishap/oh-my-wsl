import type { WslDistroInfo, WslPythonEnv } from "./wsl";
import type { WslConfig } from "./config";

// ═══════════════════════════════════════════════════════════════════════════
// Minimal self-contained TSP (Tern Surface Protocol) node builders
// Zero runtime dependencies so tests and external builds work cleanly
// ═══════════════════════════════════════════════════════════════════════════

export type TspTone = "neutral" | "accent" | "info" | "success" | "warning" | "error" | "pending" | "muted" | "user";

export interface TspSpan {
  t: string;
  s?: string;
}

export type TspText = string | readonly TspSpan[];

export interface NativeNode {
  readonly k: string;
  readonly p?: Record<string, unknown>;
  readonly c?: readonly NativeNode[];
  readonly key?: string;
}

export interface NativeToolHead {
  readonly title?: TspText;
  readonly target?: TspText;
  readonly targetKind?: "command" | "path" | "pattern" | "query" | "text";
  readonly lang?: string;
  readonly command?: string;
  readonly meta?: readonly TspText[];
  readonly badges?: readonly { text: string; tone?: TspTone; title?: string }[];
  readonly note?: TspText;
  readonly exit?: number | null;
}

export interface NativeToolView {
  readonly tool?: NativeToolHead;
  readonly head?: TspText;
  readonly body?: readonly NativeNode[];
  readonly tone?: TspTone;
  readonly preview?: { lines: number } | { tail: number } | "none" | "children";
  readonly open?: boolean;
  readonly inline?: boolean;
}

export interface RenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
  executionStarted?: boolean;
  elapsedMs?: number;
  cancelled?: boolean;
  spinnerFrame?: number;
}

export interface Component {
  render(width: number): readonly string[];
}

export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  format: { bracketLeft: string; bracketRight: string };
  sep: { dot: string };
}

class Text implements Component {
  constructor(
    private text: string,
    private x: number,
    private y: number,
  ) {}
  render(): readonly string[] {
    return this.text.split("\n");
  }
}

function highlightCode(source: string, _language: string): string[] {
  return source.split("\n");
}

function span(t: string, s?: string): TspSpan {
  return s ? { t, s } : { t };
}

function node(k: string, p?: Record<string, unknown>, c?: readonly NativeNode[], key?: string): NativeNode {
  const n: Record<string, unknown> = { k };
  if (p !== undefined) n.p = p;
  if (c !== undefined) n.c = c;
  if (key !== undefined) n.key = key;
  return n as unknown as NativeNode;
}

function compact<T>(items: readonly (T | undefined | null | false)[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (item !== undefined && item !== null && item !== false) out.push(item);
  }
  return out;
}

const RUN_INPUT_PREVIEW_LINES = 8;
const RUN_OUTPUT_PREVIEW_LINES = 10;

type RunState = "running" | "done" | "failed" | "cancelled" | "timed-out";

const RUN_STATE_META: Record<RunState, { word: string; tone: TspTone }> = {
  running: { word: "Running", tone: "pending" },
  done: { word: "Done", tone: "success" },
  failed: { word: "Failed", tone: "error" },
  cancelled: { word: "Cancelled", tone: "muted" },
  "timed-out": { word: "Timed out", tone: "warning" },
};

function runInput(source: string, p: { role: string; lang: string; wrap: boolean }): NativeNode {
  return node(
    "code",
    {
      text: source.trimEnd(),
      role: p.role,
      lang: p.lang,
      wrap: p.wrap,
      preview: { lines: RUN_INPUT_PREVIEW_LINES },
    },
    undefined,
    "input",
  );
}

function runOutput(output: string, p: { role: string; previewLines?: number; key?: string }): NativeNode {
  return node(
    "ansi",
    {
      text: output,
      role: p.role,
      follow: true,
      preview: { lines: p.previewLines ?? RUN_OUTPUT_PREVIEW_LINES },
    },
    undefined,
    p.key ?? "output",
  );
}

function runFoot(input: {
  state: RunState;
  exitCode?: number;
  elapsedMs?: number;
  facts?: readonly string[];
}): NativeNode {
  const failedWithCode = input.state === "failed" && input.exitCode !== undefined && input.exitCode !== 0;
  const stateInfo = failedWithCode
    ? { word: `exit ${input.exitCode}`, tone: "error" as TspTone }
    : RUN_STATE_META[input.state];

  const cleanFacts = (input.facts ?? []).map(f => f.trim()).filter(Boolean);
  const ms = input.elapsedMs === undefined ? undefined : Math.max(0, Math.round(input.elapsedMs));

  const timeNode =
    ms === undefined
      ? undefined
      : node(
          "elapsed",
          input.state === "running"
            ? { role: "omp.run.time", age: ms, format: "short" }
            : { role: "omp.run.time", age: ms, stopped: ms, format: "short" },
          undefined,
          "time",
        );

  return node(
    "row",
    { role: "omp.run.foot", gap: "sm", align: "center" },
    compact<NativeNode>([
      node("text", { spans: [span(stateInfo.word)], role: "omp.run.state", tone: stateInfo.tone }, undefined, "state"),
      timeNode,
      cleanFacts.length > 0 &&
        node("text", { spans: [span(cleanFacts.join(" · "), "muted")], role: "omp.run.facts", wrap: "word" }, undefined, "facts"),
    ]),
    "foot",
  );
}

function runBox(children: readonly (NativeNode | undefined | false)[], p: { key: string; tone?: TspTone }): NativeNode {
  return node("col", { role: "omp.run", gap: "none", tone: p.tone }, compact(children), p.key);
}

function extractIntent(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  if (!("i" in args)) return undefined;
  const val = args.i;
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : undefined;
}

function shortenVenvName(pyPath: string | undefined): string {
  if (!pyPath) return "python";
  const parts = pyPath.replace(/\\/g, "/").split("/").filter(Boolean);
  // e.g. /home/mishap/vllm-env/bin/python -> vllm-env
  const binIdx = parts.lastIndexOf("bin");
  if (binIdx > 0) {
    return parts[binIdx - 1] || "python";
  }
  return parts[parts.length - 1] || "python";
}

function resolveRunState(
  details: { exitCode?: number; timedOut?: boolean; cancelled?: boolean } | undefined,
  isError: boolean | undefined,
  isPartial: boolean | undefined,
  cancelled: boolean | undefined,
): RunState {
  if (cancelled || details?.cancelled) return "cancelled";
  if (isPartial) return "running";
  if (details?.timedOut) return "timed-out";
  if (isError || (details?.exitCode !== undefined && details.exitCode !== 0)) return "failed";
  return "done";
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. WSL Bash Renderer
// ═══════════════════════════════════════════════════════════════════════════

export interface WslBashArgs {
  command?: string;
  distro?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  i?: string;
}

export interface WslBashDetails {
  distro?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  wallTimeMs?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  error?: string;
}

function formatWslBashInput(args: WslBashArgs | undefined): string {
  if (!args) return "…";
  const parts: string[] = [];
  if (args.cwd) parts.push(`cd ${args.cwd} &&`);
  if (args.env && Object.keys(args.env).length > 0) {
    const envStr = Object.entries(args.env)
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
      .join(" ");
    parts.push(envStr);
  }
  parts.push(args.command || "…");
  return parts.join(" ");
}

function buildWslBashHead(
  args: WslBashArgs | undefined,
  details: WslBashDetails | undefined,
  settled: boolean,
): NativeToolHead {
  const distro = details?.distro || args?.distro;
  const intent = extractIntent(args);
  const cmdText = formatWslBashInput(args);
  const exit = settled && details?.exitCode !== undefined && details.exitCode !== 0 ? details.exitCode : undefined;

  const badges: { text: string; tone?: TspTone; title?: string }[] = [];
  if (distro) {
    badges.push({ text: distro, tone: "info", title: `WSL Distribution: ${distro}` });
  } else {
    badges.push({ text: "WSL", tone: "info" });
  }

  return {
    title: "WSL Bash",
    target: intent,
    targetKind: intent ? "text" : undefined,
    command: cmdText,
    badges,
    exit,
    note: settled && details?.timedOut ? "timed out" : undefined,
  };
}

export const wslBashRenderer = {
  mergeCallAndResult: true,

  describeCall(args: WslBashArgs, options: RenderOptions): NativeToolView {
    const command = formatWslBashInput(args);
    const started = options.executionStarted === true;
    return {
      tool: buildWslBashHead(args, undefined, false),
      body: [
        runBox(
          [
            runInput(command, { role: "omp.tool.bash.command", lang: "bash", wrap: true }),
            started && runFoot({ state: options.cancelled ? "cancelled" : "running", elapsedMs: options.elapsedMs }),
          ],
          { key: "run" },
        ),
      ],
      preview: "children",
    };
  },

  describeResult(
    result: { content: Array<{ type: string; text?: string }>; details?: WslBashDetails; isError?: boolean },
    options: RenderOptions,
    args?: WslBashArgs,
  ): NativeToolView {
    const details = result.details;
    const isPartial = options.isPartial === true;
    const state = resolveRunState(details, result.isError, isPartial, options.cancelled);
    const command = formatWslBashInput(args);
    const elapsedMs = isPartial ? options.elapsedMs : (details?.wallTimeMs ?? options.elapsedMs);

    const stdout = details?.stdout?.trimEnd() ?? "";
    const stderr = details?.stderr?.trimEnd() ?? "";
    const fallbackText = !details ? (result.content.find(c => c.type === "text")?.text?.trimEnd() ?? "") : "";
    const combinedOutput = details
      ? [stdout, stderr ? `\x1b[33m${stderr}\x1b[39m` : ""].filter(Boolean).join("\n")
      : fallbackText;

    const boxTone: TspTone | undefined = state === "failed" ? "error" : state === "timed-out" ? "warning" : undefined;

    return {
      tool: buildWslBashHead(args, details, !isPartial),
      body: [
        runBox(
          [
            runInput(command, { role: "omp.tool.bash.command", lang: "bash", wrap: true }),
            combinedOutput.trim().length > 0 &&
              runOutput(combinedOutput, { role: "omp.tool.bash.output", previewLines: RUN_OUTPUT_PREVIEW_LINES }),
            runFoot({
              state,
              exitCode: details?.exitCode,
              elapsedMs,
            }),
          ],
          { key: "run", tone: boxTone },
        ),
      ],
      tone: state === "timed-out" ? "warning" : undefined,
      preview: "children",
    };
  },

  renderCall(args: WslBashArgs, options: RenderOptions, theme: Theme): Component {
    const distro = args?.distro ? ` [${args.distro}]` : "";
    const title = `${theme.fg("toolTitle", theme.bold("WSL Bash"))}${theme.fg("info", distro)}`;
    const cmd = formatWslBashInput(args);
    const highlighted = highlightCode(cmd.replace(/\t/g, "  "), "bash");
    const maxLines = options.expanded ? highlighted.length : RUN_INPUT_PREVIEW_LINES;
    const shown = highlighted.slice(0, maxLines).map((l, idx) => (idx === 0 ? `${theme.fg("dim", "$ ")}${l}` : `  ${l}`));
    if (highlighted.length > maxLines) {
      shown.push(theme.fg("muted", `… (${highlighted.length - maxLines} more lines)`));
    }
    return new Text(`${title}\n${shown.join("\n")}`, 0, 0);
  },

  renderResult(
    result: { content: Array<{ type: string; text?: string }>; details?: WslBashDetails; isError?: boolean },
    options: RenderOptions,
    theme: Theme,
    args?: WslBashArgs,
  ): Component {
    const details = result.details;
    const distro = details?.distro || args?.distro;
    const badge = distro ? ` ${theme.fg("info", `[${distro}]`)}` : "";
    const statusSym = result.isError ? theme.fg("error", "✘") : options.isPartial ? theme.fg("accent", "⋯") : theme.fg("success", "✔");
    const duration = details?.wallTimeMs !== undefined ? theme.fg("dim", ` ${(details.wallTimeMs / 1000).toFixed(2)}s`) : "";
    const header = `${statusSym} ${theme.fg("toolTitle", theme.bold("WSL Bash"))}${badge}${duration}`;

    const cmd = formatWslBashInput(args);
    const highlighted = highlightCode(cmd.replace(/\t/g, "  "), "bash");
    const cmdShown = highlighted.slice(0, options.expanded ? highlighted.length : 6).map((l, idx) =>
      idx === 0 ? `${theme.fg("dim", "$ ")}${l}` : `  ${l}`,
    );

    const outLines: string[] = [header, ...cmdShown];
    const stdout = details?.stdout?.trimEnd() ?? "";
    const stderr = details?.stderr?.trimEnd() ?? "";
    const bodyText = details ? [stdout, stderr].filter(Boolean).join("\n") : (result.content[0]?.text ?? "");

    if (bodyText.trim()) {
      const rawLines = bodyText.replace(/\t/g, "  ").split("\n");
      const limit = options.expanded ? rawLines.length : RUN_OUTPUT_PREVIEW_LINES;
      const tail = rawLines.slice(-limit);
      if (rawLines.length > limit) {
        outLines.push(theme.fg("dim", `… (${rawLines.length - limit} earlier lines)`));
      }
      for (const line of tail) {
        outLines.push(theme.fg("toolOutput", line));
      }
    }

    return new Text(outLines.join("\n"), 0, 0);
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 2. WSL Python Eval Renderer
// ═══════════════════════════════════════════════════════════════════════════

export interface WslEvalArgs {
  code?: string;
  title?: string;
  distro?: string;
  python?: string;
  cwd?: string;
  timeout?: number;
  i?: string;
}

export interface WslEvalDetails {
  distro?: string;
  python?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  wallTimeMs?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  error?: string;
}

function buildWslEvalHead(
  args: WslEvalArgs | undefined,
  details: WslEvalDetails | undefined,
  settled: boolean,
): NativeToolHead {
  const distro = details?.distro || args?.distro;
  const pyPath = details?.python || args?.python;
  const venvLabel = pyPath ? shortenVenvName(pyPath) : "python";
  const titleText = args?.title?.trim() || extractIntent(args) || "WSL Python";
  const exit = settled && details?.exitCode !== undefined && details.exitCode !== 0 ? details.exitCode : undefined;

  const badges: { text: string; tone?: TspTone; title?: string }[] = [
    { text: venvLabel, tone: "accent", title: pyPath || "Python" },
  ];
  if (distro) {
    badges.push({ text: distro, tone: "info", title: `WSL Distribution: ${distro}` });
  }

  return {
    title: titleText,
    badges,
    exit,
    note: settled && details?.timedOut ? "timed out" : undefined,
  };
}

export const wslEvalRenderer = {
  mergeCallAndResult: true,

  describeCall(args: WslEvalArgs, options: RenderOptions): NativeToolView {
    const codeStr = args?.code ?? "";
    const started = options.executionStarted === true;
    return {
      tool: buildWslEvalHead(args, undefined, false),
      body: [
        runBox(
          [
            codeStr.trim().length > 0 &&
              runInput(codeStr, { role: "omp.tool.eval.input", lang: "python", wrap: false }),
            started && runFoot({ state: options.cancelled ? "cancelled" : "running", elapsedMs: options.elapsedMs }),
          ],
          { key: "cell-0" },
        ),
      ],
      preview: "children",
    };
  },

  describeResult(
    result: { content: Array<{ type: string; text?: string }>; details?: WslEvalDetails; isError?: boolean },
    options: RenderOptions,
    args?: WslEvalArgs,
  ): NativeToolView {
    const details = result.details;
    const isPartial = options.isPartial === true;
    const state = resolveRunState(details, result.isError, isPartial, options.cancelled);
    const codeStr = args?.code ?? "";
    const elapsedMs = isPartial ? options.elapsedMs : (details?.wallTimeMs ?? options.elapsedMs);

    const stdout = details?.stdout?.trimEnd() ?? "";
    const stderr = details?.stderr?.trimEnd() ?? "";
    const fallbackText = !details ? (result.content.find(c => c.type === "text")?.text?.trimEnd() ?? "") : "";

    // Filter noisy WSL/aiter kernel warnings unless there is no stdout or an actual error occurred
    let cleanStderr = stderr;
    if (!result.isError && stdout.length > 0 && stderr.length > 0) {
      const filteredLines = stderr
        .split("\n")
        .filter(line => !line.includes("/proc/sys/kernel/numa_balancing: No such file"));
      cleanStderr = filteredLines.join("\n").trimEnd();
    }

    const outputNodes: NativeNode[] = [];
    if (details) {
      if (stdout.length > 0) {
        outputNodes.push(runOutput(stdout, { role: "omp.tool.eval.output", previewLines: RUN_OUTPUT_PREVIEW_LINES, key: "stdout" }));
      }
      if (cleanStderr.length > 0) {
        const styledErr = cleanStderr
          .split("\n")
          .map(l => `\x1b[2m${l}\x1b[22m`)
          .join("\n");
        outputNodes.push(
          runOutput(result.isError ? `\x1b[31m${cleanStderr}\x1b[39m` : styledErr, {
            role: "omp.tool.eval.output",
            previewLines: 6,
            key: "stderr",
          }),
        );
      }
    } else if (fallbackText.length > 0 && fallbackText !== "(no output)") {
      outputNodes.push(runOutput(fallbackText, { role: "omp.tool.eval.output", previewLines: RUN_OUTPUT_PREVIEW_LINES }));
    }

    const boxTone: TspTone | undefined = state === "failed" ? "error" : state === "timed-out" ? "warning" : undefined;
    const facts: string[] = [];
    if (details?.python) facts.push(shortenVenvName(details.python));

    return {
      tool: buildWslEvalHead(args, details, !isPartial),
      body: [
        runBox(
          [
            codeStr.trim().length > 0 &&
              runInput(codeStr, { role: "omp.tool.eval.input", lang: "python", wrap: false }),
            ...outputNodes,
            runFoot({
              state,
              exitCode: details?.exitCode,
              elapsedMs,
              facts,
            }),
          ],
          { key: "cell-0", tone: boxTone },
        ),
      ],
      tone: state === "timed-out" ? "warning" : undefined,
      preview: "children",
    };
  },

  renderCall(args: WslEvalArgs, options: RenderOptions, theme: Theme): Component {
    const venv = args?.python ? shortenVenvName(args.python) : "python";
    const distro = args?.distro ? ` · ${args.distro}` : "";
    const title = args?.title?.trim() || "WSL Python";
    const head = `${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("accent", `[${venv}${distro}]`)}`;
    const codeLines = highlightCode((args?.code ?? "").replace(/\t/g, "    "), "python");
    const limit = options.expanded ? codeLines.length : RUN_INPUT_PREVIEW_LINES;
    const shown = codeLines.slice(0, limit);
    if (codeLines.length > limit) {
      shown.push(theme.fg("muted", `… (${codeLines.length - limit} more lines)`));
    }
    return new Text(`${head}\n${shown.join("\n")}`, 0, 0);
  },

  renderResult(
    result: { content: Array<{ type: string; text?: string }>; details?: WslEvalDetails; isError?: boolean },
    options: RenderOptions,
    theme: Theme,
    args?: WslEvalArgs,
  ): Component {
    const details = result.details;
    const venv = shortenVenvName(details?.python || args?.python);
    const distro = details?.distro || args?.distro;
    const badge = ` ${theme.fg("accent", `[${venv}${distro ? ` · ${distro}` : ""}]`)}`;
    const statusSym = result.isError ? theme.fg("error", "✘") : options.isPartial ? theme.fg("accent", "⋯") : theme.fg("success", "✔");
    const duration = details?.wallTimeMs !== undefined ? theme.fg("dim", ` ${(details.wallTimeMs / 1000).toFixed(2)}s`) : "";
    const title = args?.title?.trim() || "WSL Python";
    const header = `${statusSym} ${theme.fg("toolTitle", theme.bold(title))}${badge}${duration}`;

    const codeLines = highlightCode((args?.code ?? "").replace(/\t/g, "    "), "python");
    const codeLimit = options.expanded ? codeLines.length : 6;
    const outLines: string[] = [header, ...codeLines.slice(0, codeLimit)];
    if (codeLines.length > codeLimit) {
      outLines.push(theme.fg("dim", `… (${codeLines.length - codeLimit} more code lines)`));
    }

    const stdout = details?.stdout?.trimEnd() ?? "";
    const stderr = details?.stderr?.trimEnd() ?? "";
    if (stdout) {
      outLines.push(theme.fg("dim", "─── Output ───"));
      const lines = stdout.split("\n");
      const limit = options.expanded ? lines.length : RUN_OUTPUT_PREVIEW_LINES;
      for (const l of lines.slice(-limit)) {
        outLines.push(theme.fg("toolOutput", l));
      }
    }
    if (stderr) {
      const style = result.isError ? "error" : "dim";
      for (const l of stderr.split("\n").slice(-6)) {
        outLines.push(theme.fg(style, l));
      }
    }

    return new Text(outLines.join("\n"), 0, 0);
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 3. WSL Info Renderer
// ═══════════════════════════════════════════════════════════════════════════

export interface WslInfoArgs {
  distro?: string;
  i?: string;
}

export interface WslInfoDetails {
  distros?: WslDistroInfo[];
  venvs?: WslPythonEnv[];
  config?: WslConfig;
  activeDistro?: string;
  activePython?: string;
  bridgeExists?: boolean;
}

export const wslInfoRenderer = {
  mergeCallAndResult: true,

  describeCall(args: WslInfoArgs): NativeToolView {
    return {
      tool: {
        title: "WSL Environment",
        target: args?.distro,
        targetKind: args?.distro ? "text" : undefined,
        badges: [{ text: "WSL", tone: "info" }],
      },
      inline: true,
    };
  },

  describeResult(
    result: { content: Array<{ type: string; text?: string }>; details?: WslInfoDetails; isError?: boolean },
    _options: RenderOptions,
    args?: WslInfoArgs,
  ): NativeToolView {
    const details = result.details;
    if (!details) {
      const text = result.content.find(c => c.type === "text")?.text ?? "";
      return {
        tool: { title: "WSL Environment" },
        body: [node("md", { text })],
      };
    }

    const distros = details.distros ?? [];
    const venvs = details.venvs ?? [];
    const activeDistro = details.activeDistro || details.config?.distro || args?.distro || "Ubuntu-24.04";
    const activePython = details.activePython || details.config?.python || venvs[0]?.path || "/usr/bin/python3";

    const distroTable =
      distros.length > 0
        ? node(
            "table",
            {
              cols: [
                { id: "name", head: "Distribution", grow: 1 },
                { id: "state", head: "State" },
                { id: "ver", head: "WSL", align: "end" },
                { id: "role", head: "Role" },
              ],
              rows: distros.map((d, i) => ({
                id: `d${i}`,
                cells: {
                  name: [span(d.name, d.name === activeDistro ? "accent strong" : "strong")],
                  state: [span(d.state, d.state.toLowerCase() === "running" ? "success" : "muted")],
                  ver: `v${d.version}`,
                  role: [
                    span(
                      [d.name === activeDistro ? "active" : "", d.isDefault ? "default" : ""].filter(Boolean).join(", ") || "—",
                      "muted",
                    ),
                  ],
                },
              })),
            },
            undefined,
            "distros",
          )
        : undefined;

    const venvTable =
      venvs.length > 0
        ? node(
            "table",
            {
              cols: [
                { id: "name", head: "Python Env" },
                { id: "type", head: "Kind" },
                { id: "path", head: "Path", grow: 1 },
              ],
              rows: venvs.map((v, i) => ({
                id: `v${i}`,
                cells: {
                  name: [span(v.name, v.path === activePython ? "accent strong" : "strong")],
                  type: [span(v.isVenv ? "virtualenv" : "system", v.isVenv ? "info" : "muted")],
                  path: [span(v.path, "path")],
                },
              })),
            },
            undefined,
            "venvs",
          )
        : undefined;

    const kvSummary = node(
      "kv",
      {
        items: [
          { k: [span("Active Distro", "muted")], v: [span(activeDistro, "accent strong")] },
          { k: [span("Active Python", "muted")], v: [span(activePython, "path")] },
          {
            k: [span("Built-in Eval Bridge", "muted")],
            v: [
              span(
                details.config?.routeEval !== false && details.bridgeExists ? "enabled (ready)" : "disabled",
                details.config?.routeEval !== false && details.bridgeExists ? "success" : "muted",
              ),
            ],
          },
        ],
      },
      undefined,
      "summary",
    );

    return {
      tool: {
        title: "WSL Environment",
        badges: [
          { text: activeDistro, tone: "info" },
          { text: shortenVenvName(activePython), tone: "accent" },
        ],
        meta: [`${distros.length} distros · ${venvs.length} python envs`],
      },
      body: compact([kvSummary, distroTable, venvTable]),
    };
  },

  renderCall(args: WslInfoArgs, _options: RenderOptions, theme: Theme): Component {
    const target = args?.distro ? ` (${args.distro})` : "";
    return new Text(`${theme.fg("toolTitle", theme.bold("WSL Environment"))}${theme.fg("muted", target)}`, 0, 0);
  },

  renderResult(
    result: { content: Array<{ type: string; text?: string }>; details?: WslInfoDetails; isError?: boolean },
    _options: RenderOptions,
    theme: Theme,
  ): Component {
    const text = result.content.find(c => c.type === "text")?.text ?? "";
    return new Text(theme.fg("toolOutput", text), 0, 0);
  },
};
