import { spawn, spawnSync } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";

// Windows -> WSL path converter
export function toWslPath(winPath: string): string {
  if (!winPath) return winPath;
  // UNC path \\wsl.localhost\Distro\... or \\wsl$\Distro\...
  const uncMatch = winPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(\\.*)$/i);
  if (uncMatch) {
    return uncMatch[1].replace(/\\/g, "/");
  }
  // Drive letter C:\... or c:/...
  const driveMatch = winPath.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  return winPath.replace(/\\/g, "/");
}

export function rewriteCodeString(code: string): string {
  if (!code.includes("__omp_cwd") || !code.includes("__omp_env")) {
    return code;
  }

  try {
    const cwdMatch = code.match(/__omp_cwd\s*=\s*"([^"]+)"/);
    let wslCwd = "/mnt/c";
    if (cwdMatch) {
      const clean = cwdMatch[1].replace(/\\\\/g, "\\");
      wslCwd = toWslPath(clean);
    }

    const envMatch = code.match(/__omp_env\s*=\s*(\{.*\})/);
    if (envMatch) {
      const parsed = JSON.parse(envMatch[1]);
      for (const key of Object.keys(parsed)) {
        const val = parsed[key];
        if (typeof val === "string") {
          if (key === "PI_EVAL_LOCAL_ROOTS") {
            try {
              const roots = JSON.parse(val);
              for (const rk of Object.keys(roots)) {
                if (typeof roots[rk] === "string") {
                  roots[rk] = toWslPath(roots[rk]);
                }
              }
              parsed[key] = JSON.stringify(roots);
            } catch {}
          } else if (key === "PI_TOOL_BRIDGE_SESSION") {
            // Replace Windows paths within "python:session:C:\path:cwd:C:\path"
            parsed[key] = val.replace(/([a-zA-Z]:\\[^:]+)/g, (m) => toWslPath(m));
          } else if (/^[a-zA-Z]:[\\/]/.test(val) || /^\\\\/.test(val)) {
            parsed[key] = toWslPath(val);
          }
        }
      }

      return [
        "import os, sys",
        `__omp_cwd = ${JSON.stringify(wslCwd)}`,
        "os.chdir(__omp_cwd)",
        `__omp_env = ${JSON.stringify(parsed)}`,
        "for __omp_key, __omp_val in __omp_env.items():",
        "    os.environ[__omp_key] = __omp_val",
        "if __omp_cwd not in sys.path:",
        "    sys.path.insert(0, __omp_cwd)",
      ].join("\n");
    }
  } catch {}

  return code;
}

export function resolveWslConfig(): { distro: string; pythonBin: string } {
  // 1. Check environment variables
  let distro = process.env.OMP_WSL_DISTRO || "";
  let pythonBin = process.env.OMP_WSL_PYTHON || "";

  // 2. Check ~/.omp/wsl.json or .omp/wsl.json
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";
  const configPaths = [
    path.join(process.cwd(), ".omp", "wsl.json"),
    path.join(userProfile, ".omp", "wsl.json"),
  ];

  for (const cfgPath of configPaths) {
    if ((!distro || !pythonBin) && fs.existsSync(cfgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        if (!distro && parsed.distro) distro = parsed.distro;
        if (!pythonBin && parsed.python) pythonBin = parsed.python;
      } catch {}
    }
  }

  // 3. Fallback: query wsl.exe for default distro
  if (!distro) {
    try {
      const res = spawnSync("wsl.exe", ["-l", "-v"], { encoding: "utf-8", windowsHide: true });
      if (res.stdout) {
        // Look for line starting with asterisk *
        const lines = res.stdout.split(/\r?\n/);
        for (const line of lines) {
          const match = line.match(/^\s*\*\s*([^\s]+)/);
          if (match) {
            distro = match[1].replace(/\0/g, "").trim();
            break;
          }
        }
      }
    } catch {}
  }
  if (!distro) distro = "Ubuntu-24.04";

  // 4. Fallback for python: probe WSL for common venvs or default python3
  if (!pythonBin) {
    try {
      const res = spawnSync("wsl.exe", ["-d", distro, "--", "bash", "-c", "find /home -maxdepth 3 -name 'pyvenv.cfg' -exec dirname {} \\; 2>/dev/null"], {
        encoding: "utf-8",
        windowsHide: true,
      });
      if (res.stdout) {
        const venvs = res.stdout.trim().split(/\r?\n/).filter(Boolean);
        if (venvs.length > 0) {
          // Check if <venv>/bin/python exists
          pythonBin = `${venvs[0].trim()}/bin/python`;
        }
      }
    } catch {}
  }
  if (!pythonBin) pythonBin = "/usr/bin/python3";

  return { distro, pythonBin };
}

async function main() {
  const { distro, pythonBin } = resolveWslConfig();
  const rawArgs = process.argv.slice(2);

  // Translate any Windows paths in command-line arguments to WSL paths
  const translatedArgs = rawArgs.map(arg => {
    if (/^[a-zA-Z]:[\\/]/.test(arg) || /^\\\\(?:wsl\.localhost|wsl\$)/.test(arg)) {
      return toWslPath(arg);
    }
    return arg;
  });

  const wslArgs = ["-d", distro, "--", pythonBin, ...translatedArgs];

  const child = spawn("wsl.exe", wslArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  const isProbe = rawArgs.includes("-c");
  const isRunnerMode = !isProbe;

  if (isRunnerMode) {
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        child.stdin.write(line + "\n");
        return;
      }
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj.cwd === "string") {
          obj.cwd = toWslPath(obj.cwd);
        }
        if (typeof obj.filename === "string") {
          obj.filename = toWslPath(obj.filename);
        }
        if (obj.env && typeof obj.env === "object") {
          for (const key of Object.keys(obj.env)) {
            const val = obj.env[key];
            if (typeof val === "string" && (/^[a-zA-Z]:[\\/]/.test(val) || /^\\\\/.test(val))) {
              obj.env[key] = toWslPath(val);
            }
          }
        }
        if (typeof obj.code === "string") {
          obj.code = rewriteCodeString(obj.code);
        }
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch {
        child.stdin.write(line + "\n");
      }
    });

    rl.on("close", () => {
      child.stdin.end();
    });
  } else {
    process.stdin.pipe(child.stdin);
  }

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    process.stderr.write(`Failed to spawn wsl.exe: ${err.message}\n`);
    process.exit(1);
  });
}

if (import.meta.main) {
  main();
}
