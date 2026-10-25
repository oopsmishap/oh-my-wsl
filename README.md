# oh-my-wsl 🐧⚡

> **Native WSL integration for [oh-my-pi](https://omp.sh).**  
> Seamlessly run Python, execute bash commands, and access Linux files directly in Windows Subsystem for Linux — zero shell escaping, zero path headaches.

---

## Why You Need This

Working on Windows with Linux-first libraries (PyTorch, CUDA, vLLM, Triton, ROCm) usually forces coding models into quote-escaping gymnastics:

```bash
# ❌ Before: Nested quoting hell, no state persistence, broken eval
wsl -d Ubuntu-24.04 -- bash -c "/home/mishap/vllm-env/bin/python -c \"from vllm.config.compilation import CompilationConfig; import dataclasses; for f in dataclasses.fields(CompilationConfig): print(f.name, f.default)\""
```

With `oh-my-wsl`, models interact with WSL natively:

```python
# ✅ After: Built-in eval runs directly in your WSL virtualenv with full state persistence!
from vllm.config.compilation import CompilationConfig
import dataclasses
for f in dataclasses.fields(CompilationConfig):
    print(f.name, f.default)
```

---

## ⚡ Quick Start

### 1. Install Plugin

In your terminal or omp session:

```bash
# Install directly from GitHub
omp plugin install github:oopsmishap/oh-my-wsl
```

*Or for local development / clone:*

```bash
git clone https://github.com/oopsmishap/oh-my-wsl.git
cd oh-my-wsl
omp plugin link .
```

### 2. Verify Installation

Start omp and check plugin status:

```text
/wsl status
```

You'll see:
```text
WSL Status:
• Distro: Ubuntu-24.04
• Python: /home/mishap/vllm-env/bin/python
• Eval Routing: enabled
• Bridge Exe: ready
```

That's it! `oh-my-wsl` automatically discovers your default running WSL distro and finds virtual environments in `/home`.

---

## 🚀 Key Features

### 1. Transparent Built-in `eval` Routing
Whenever the model executes Python via omp's built-in `eval` tool, `oh-my-wsl` intercepts the execution and routes it through a lightweight bridge into your WSL Python virtualenv.
- **Variables persist across cells**
- `%pip install` installs directly into your WSL environment
- `%load` and top-level `await` work out of the box
- Clean, native output rendering with live execution timers

### 2. Built-in Tool File Bridging
Models can use native tools (`read`, `grep`, `glob`, `find`, `edit`, `write`) with Linux paths:
```text
read path="/home/mishap/vllm-env/pyvenv.cfg"
```
The plugin automatically bridges the Linux path into `\\wsl.localhost\Ubuntu-24.04\home\mishap\vllm-env\pyvenv.cfg`. No more shelling out to `cat` or `sed`!

### 3. Dedicated WSL Tools
For tasks that explicitly need Linux execution:
- **`wsl_eval`**: Execute Python snippets in WSL without nested shell wrappers.
- **`wsl_bash`**: Run Linux bash scripts, pipelines, and commands via streaming stdin.
- **`wsl_info`**: Inspect distros, states, and discovered Python environments.

### 4. Native Cards in TUI and Tern (TSP)
Clean cards styled to match your theme:
- Command and syntax-highlighted code blocks
- Separate stdout and styled stderr
- Elapsed runtime clock and exit status badges
- Noise filter for WSL kernel warnings (`numa_balancing`)

---

## 🎮 Slash Commands

Use `/wsl` inside omp to inspect and change settings on the fly:

| Command | Description |
|---|---|
| `/wsl status` | Display active distro, python path, and eval routing status |
| `/wsl list` | Enumerate all installed WSL distros and discovered venvs |
| `/wsl distro <name>` | Switch active distribution (e.g. `/wsl distro Ubuntu-24.04`) |
| `/wsl venv <path>` | Switch active Python environment (e.g. `/wsl venv /home/mishap/vllm-env/bin/python`) |
| `/wsl eval on\|off` | Toggle whether omp's built-in `eval` tool routes to WSL |
| `/wsl bash <command>` | Run an ad-hoc bash command in an interactive overlay with streaming output |
| `/wsl eval <code>` | Run ad-hoc Python code in an interactive overlay |
| `/wsl build` | Recompile the standalone bridge executable |

---

## ⚙️ Configuration

Settings can be stored in `.omp/wsl.json` (per project) or `~/.omp/wsl.json` (user global):

```json
{
  "distro": "Ubuntu-24.04",
  "python": "/home/mishap/vllm-env/bin/python",
  "routeEval": true,
  "interceptBash": false
}
```

### Environment Variables
You can also override settings via environment variables:
- `OMP_WSL_DISTRO`: Target distribution name
- `OMP_WSL_PYTHON`: Target Python executable path in WSL
- `OMP_WSL_ROUTE_EVAL`: `1` to enable built-in eval routing, `0` to disable

---

## 🧪 Development & Testing

```bash
# Clone the repository
git clone https://github.com/oopsmishap/oh-my-wsl.git
cd oh-my-wsl

# Install dependencies and build bridge
bun install
bun run build:bridge

# Run full test suite (unit tests, path translation, renderers)
bun test

# Link into local omp
omp plugin link .
```

---

## 📄 License

MIT © [mishap](https://github.com/oopsmishap)
