---
name: wsl-native-tools
description: Prefer built-in native tools for WSL file access over bash one-liners
alwaysApply: true
---

# Native WSL Tool Usage

When working inside Windows Subsystem for Linux (WSL), always prefer omp's built-in native tools over running `wsl -d ... -- bash -c "..."` or using `wsl_bash` for simple file operations.

### File System Access
The built-in tools natively understand WSL paths through the UNC prefix `\\wsl.localhost\<distro>\...` (e.g., `\\wsl.localhost\Ubuntu-24.04\home\user\project\src\main.py`).

| Task | Do this | Don't do this |
|---|---|---|
| Read a file | Use `read` with `path: "\\wsl.localhost\Ubuntu-24.04\home\user\src\file.py"` or `path: "/home/user/src/file.py"` | Use `wsl_bash` with `cat` or `head` |
| Search content | Use `grep` with `path: "/home/user/src"` | Use `wsl_bash` with `grep` or `rg` |
| Find files | Use `glob` with `path: "/home/user/src"` | Use `wsl_bash` with `find` or `ls` |
| Edit a file | Use `edit` or `write` | Use `wsl_bash` with `sed -i` |

### Running Code
- For Python code execution in WSL, use `wsl_eval`. It provides state persistence, `%pip` magic, structured tables, and clean error handling.
- For shell commands that genuinely need WSL (e.g., `nvidia-smi`, `apt`, `docker` inside WSL, complex pipelines), use `wsl_bash`.
- Never nest `wsl -d ... -- bash -c "..."` inside the built-in `bash` tool; use `wsl_bash` directly.
