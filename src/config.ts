import * as path from "node:path";
import * as fs from "node:fs";

export interface WslConfig {
  distro?: string;
  python?: string;
  routeEval?: boolean;
  interceptBash?: boolean;
}

export function getUserConfigPath(): string {
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";
  return path.join(userProfile, ".omp", "wsl.json");
}

export function getProjectConfigPath(cwd: string = process.cwd()): string {
  return path.join(cwd, ".omp", "wsl.json");
}

export function loadWslConfig(cwd: string = process.cwd()): WslConfig {
  let config: WslConfig = {
    distro: undefined,
    python: undefined,
    routeEval: true,
    interceptBash: false,
  };

  // 1. User config
  const userPath = getUserConfigPath();
  if (fs.existsSync(userPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(userPath, "utf-8"));
      config = { ...config, ...parsed };
    } catch {}
  }

  // 2. Project config
  const projectPath = getProjectConfigPath(cwd);
  if (fs.existsSync(projectPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
      config = { ...config, ...parsed };
    } catch {}
  }

  // 3. Environment overrides
  if (process.env.OMP_WSL_DISTRO) {
    config.distro = process.env.OMP_WSL_DISTRO;
  }
  if (process.env.OMP_WSL_PYTHON) {
    config.python = process.env.OMP_WSL_PYTHON;
  }
  if (process.env.OMP_WSL_ROUTE_EVAL !== undefined) {
    config.routeEval = process.env.OMP_WSL_ROUTE_EVAL === "1" || process.env.OMP_WSL_ROUTE_EVAL === "true";
  }

  return config;
}

export function saveWslConfig(config: Partial<WslConfig>, scope: "user" | "project" = "user", cwd: string = process.cwd()): void {
  const targetPath = scope === "user" ? getUserConfigPath() : getProjectConfigPath(cwd);
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let existing: WslConfig = {};
  if (fs.existsSync(targetPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(targetPath, "utf-8"));
    } catch {}
  }

  const merged = { ...existing, ...config };
  fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2), "utf-8");
}

export function toWslPath(winPath: string): string {
  if (!winPath) return winPath;
  const uncMatch = winPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(\\.*)$/i);
  if (uncMatch) {
    return uncMatch[1].replace(/\\/g, "/");
  }
  const driveMatch = winPath.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  return winPath.replace(/\\/g, "/");
}

export function toWinPath(wslPath: string, distro: string = "Ubuntu-24.04"): string {
  if (!wslPath) return wslPath;
  const mntMatch = wslPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase();
    const rest = mntMatch[2].replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  if (wslPath.startsWith("/")) {
    return `\\\\wsl.localhost\\${distro}${wslPath.replace(/\//g, "\\")}`;
  }
  return wslPath;
}

export function getBridgeBinaryPath(extensionDir?: string): string {
  const baseDir = extensionDir || path.resolve(__dirname, "..");
  const exePath = path.join(baseDir, "bin", "wsl-python-bridge.exe");
  if (fs.existsSync(exePath)) {
    return exePath;
  }
  const cmdPath = path.join(baseDir, "bin", "bridge.cmd");
  if (fs.existsSync(cmdPath)) {
    return cmdPath;
  }
  return exePath;
}
