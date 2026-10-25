import { spawn, spawnSync } from "node:child_process";
import { loadWslConfig, toWslPath, getBridgeBinaryPath } from "./config";
import * as path from "node:path";
import * as fs from "node:fs";

export interface WslDistroInfo {
  name: string;
  state: "Running" | "Stopped" | string;
  version: number;
  isDefault: boolean;
}

export interface WslPythonEnv {
  path: string;
  name: string;
  version?: string;
  isVenv: boolean;
}

export interface WslExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  wallTimeMs: number;
  timedOut?: boolean;
}

export function getWslDistros(): WslDistroInfo[] {
  try {
    const res = spawnSync("wsl.exe", ["-l", "-v"], { encoding: "utf-8", windowsHide: true });
    if (!res.stdout) return [];

    const lines = res.stdout.split(/\r?\n/).map(l => l.replace(/\0/g, "").trim()).filter(Boolean);
    const distros: WslDistroInfo[] = [];

    // Skip header line (e.g. NAME STATE VERSION)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      const isDefault = line.startsWith("*");
      const cleanLine = line.replace(/^\*\s*/, "").trim();
      const parts = cleanLine.split(/\s+/);
      if (parts.length >= 3) {
        distros.push({
          name: parts[0]!,
          state: parts[1]!,
          version: parseInt(parts[2]!, 10) || 2,
          isDefault,
        });
      }
    }

    return distros;
  } catch {
    return [];
  }
}

export function getDefaultDistro(): string {
  const distros = getWslDistros();
  const def = distros.find(d => d.isDefault);
  if (def) return def.name;
  const running = distros.find(d => d.state.toLowerCase() === "running");
  if (running) return running.name;
  return distros[0]?.name || "Ubuntu-24.04";
}

export function detectVenvs(distro?: string): WslPythonEnv[] {
  const targetDistro = distro || loadWslConfig().distro || getDefaultDistro();
  const envs: WslPythonEnv[] = [];

  try {
    const findCmd = "find /home -maxdepth 3 -name 'pyvenv.cfg' -exec dirname {} \\; 2>/dev/null";
    const res = spawnSync("wsl.exe", ["-d", targetDistro, "--", "bash", "-c", findCmd], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 5000,
    });

    if (res.stdout) {
      const paths = res.stdout.trim().split(/\r?\n/).map(p => p.trim()).filter(Boolean);
      for (const p of paths) {
        const binPy = `${p}/bin/python`;
        const name = p.split("/").pop() || p;
        envs.push({
          path: binPy,
          name,
          isVenv: true,
        });
      }
    }
  } catch {}

  try {
    const whichRes = spawnSync("wsl.exe", ["-d", targetDistro, "--", "bash", "-c", "which python3 python 2>/dev/null"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 3000,
    });
    if (whichRes.stdout) {
      const paths = whichRes.stdout.trim().split(/\r?\n/).map(p => p.trim()).filter(Boolean);
      for (const p of paths) {
        if (!envs.some(e => e.path === p)) {
          envs.push({
            path: p,
            name: `system (${p.split("/").pop()})`,
            isVenv: false,
          });
        }
      }
    }
  } catch {}

  return envs;
}

export function resolveTargetPython(distro?: string): string {
  const config = loadWslConfig();
  if (config.python) return config.python;

  const targetDistro = distro || config.distro || getDefaultDistro();
  const venvs = detectVenvs(targetDistro);
  if (venvs.length > 0) {
    return venvs[0]!.path;
  }
  return "/usr/bin/python3";
}

export async function executeWslBash(options: {
  command: string;
  distro?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  onChunk?: (chunk: { stdout?: string; stderr?: string }) => void;
}): Promise<WslExecutionResult> {
  const { promise, resolve, reject } = Promise.withResolvers<WslExecutionResult>();
  const config = loadWslConfig();
  const distro = options.distro || config.distro || getDefaultDistro();
  const timeoutMs = (options.timeout ?? 300) * 1000;
  const startTime = Date.now();

  let script = "";
  if (options.cwd) {
    const wslCwd = toWslPath(options.cwd);
    script += `cd "${wslCwd}" 2>/dev/null || true\n`;
  }
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      script += `export ${k}="${v.replace(/"/g, '\\"')}"\n`;
    }
  }
  script += options.command + "\n";

  const child = spawn("wsl.exe", ["-d", distro, "--", "bash"], {
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  let timeoutTimer: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  }

  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      child.kill();
    });
  }

  child.stdout.on("data", (chunk: Buffer | string) => {
    const str = chunk.toString();
    stdout += str;
    options.onChunk?.({ stdout: str });
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    const str = chunk.toString();
    stderr += str;
    options.onChunk?.({ stderr: str });
  });

  child.on("close", (code) => {
    clearTimeout(timeoutTimer);
    const wallTimeMs = Date.now() - startTime;
    resolve({
      stdout: stdout.trimEnd(),
      stderr: stderr.trimEnd(),
      exitCode: code ?? (timedOut ? 124 : 0),
      wallTimeMs,
      timedOut,
    });
  });

  child.on("error", (err) => {
    clearTimeout(timeoutTimer);
    reject(err);
  });

  child.stdin.write(script);
  child.stdin.end();

  return promise;
}

export async function executeWslPython(options: {
  code: string;
  distro?: string;
  python?: string;
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  onChunk?: (chunk: { stdout?: string; stderr?: string }) => void;
}): Promise<WslExecutionResult> {
  const { promise, resolve, reject } = Promise.withResolvers<WslExecutionResult>();
  const config = loadWslConfig();
  const distro = options.distro || config.distro || getDefaultDistro();
  const pythonBin = options.python || config.python || resolveTargetPython(distro);
  const timeoutMs = (options.timeout ?? 60) * 1000;
  const startTime = Date.now();

  let bootstrapCode = "";
  if (options.cwd) {
    const wslCwd = toWslPath(options.cwd);
    bootstrapCode += `import os, sys\nos.chdir("${wslCwd}")\nif "${wslCwd}" not in sys.path: sys.path.insert(0, "${wslCwd}")\n`;
  }
  bootstrapCode += options.code;

  const child = spawn("wsl.exe", ["-d", distro, "--", pythonBin, "-"], {
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  let timeoutTimer: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  }

  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      child.kill();
    });
  }

  child.stdout.on("data", (chunk: Buffer | string) => {
    const str = chunk.toString();
    stdout += str;
    options.onChunk?.({ stdout: str });
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    const str = chunk.toString();
    stderr += str;
    options.onChunk?.({ stderr: str });
  });

  child.on("close", (code) => {
    clearTimeout(timeoutTimer);
    const wallTimeMs = Date.now() - startTime;
    resolve({
      stdout: stdout.trimEnd(),
      stderr: stderr.trimEnd(),
      exitCode: code ?? (timedOut ? 124 : 0),
      wallTimeMs,
      timedOut,
    });
  });

  child.on("error", (err) => {
    clearTimeout(timeoutTimer);
    reject(err);
  });

  child.stdin.write(bootstrapCode);
  child.stdin.end();

  return promise;
}

export function ensureBridgeExecutable(extensionDir?: string): string {
  const baseDir = extensionDir || path.resolve(__dirname, "..");
  const bridgeExe = path.join(baseDir, "bin", "wsl-python-bridge.exe");
  const bridgeCmd = path.join(baseDir, "bin", "bridge.cmd");

  if (!fs.existsSync(bridgeExe)) {
    try {
      const bridgeTs = path.join(baseDir, "bin", "bridge.ts");
      if (fs.existsSync(bridgeTs)) {
        const res = spawnSync("bun", ["build", "--compile", bridgeTs, "--outfile", bridgeExe], {
          windowsHide: true,
        });
        if (res.status === 0 && fs.existsSync(bridgeExe)) {
          return bridgeExe;
        }
      }
    } catch {}
  }

  if (fs.existsSync(bridgeExe)) {
    return bridgeExe;
  }
  if (fs.existsSync(bridgeCmd)) {
    return bridgeCmd;
  }
  return bridgeExe;
}
