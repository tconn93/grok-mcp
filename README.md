# grok-mcp

A TypeScript MCP server that gives AI agents full access to an Ubuntu VM — files, shell commands, background processes, interactive terminals, networking, services, and more.

## Tools (40 total)

### Files
| Tool | Description |
|---|---|
| `read_file` | Read file contents |
| `write_file` | Write/create a file (auto-creates parent dirs) |
| `append_file` | Append content to a file |
| `delete_file` | Delete a file or directory |
| `move_file` | Move or rename a file/directory |
| `copy_file` | Copy a file |
| `list_directory` | List directory contents with type and size |
| `make_directory` | Create a directory (recursive) |
| `file_info` | Stat a file: size, permissions, timestamps |
| `find_files` | Search for files by name, type, size |
| `grep_files` | Search file contents by pattern |

> `write_file` and `append_file` automatically decode HTML entities (`&lt;`, `&gt;`, `&amp;`, `&#60;`, `&#x3C;`, etc.) so content from agent frameworks that HTML-encode tool arguments is written correctly.

### Shell & Process Management
| Tool | Description |
|---|---|
| `run_command` | Run a shell command synchronously, returns stdout/stderr/exit code |
| `run_background` | Run a command in the background, returns a `session_id` |
| `get_process_output` | Get stdout/stderr of a background process by `session_id` |
| `get_process_status` | Get status, PID, exit code of a background process |
| `kill_process` | Send a signal to a managed background process |
| `list_processes` | List all tracked background processes |
| `get_system_info` | CPU, memory, disk, uptime, hostname, load average |
| `list_system_processes` | `ps aux` with optional name filter |
| `kill_system_process` | Kill any process by PID |
| `service_control` | `systemctl` start/stop/restart/status/enable/disable |
| `list_services` | List systemd services, filterable by state |
| `package_manager` | `apt` install/remove/purge/update/upgrade/search/info/list |

### Interactive Terminal (PTY)
| Tool | Description |
|---|---|
| `session_create` | Open an interactive terminal session, returns a `session_id` |
| `session_write` | Send input to the terminal (`\n` to submit, `\x03` for Ctrl-C) |
| `session_read` | Read output accumulated since last read (buffer clears on read) |
| `session_resize` | Resize the terminal window |
| `session_close` | Close and terminate a session |
| `list_sessions` | List all PTY sessions and their status |

Use PTY sessions for anything that requires stateful back-and-forth: SSH, Python/Node REPLs, database CLIs, interactive installers, etc.

### Networking
| Tool | Description |
|---|---|
| `http_request` | HTTP/HTTPS request with method, headers, body, timeout |
| `check_port` | Check if a TCP port is open on a host |
| `list_network_interfaces` | List all network interfaces with IPs and MACs |
| `dns_lookup` | Resolve a hostname (A, AAAA, MX, TXT, CNAME, NS, etc.) |

### System & Scheduling
| Tool | Description |
|---|---|
| `change_permissions` | `chmod` a file or directory |
| `change_ownership` | `chown` a file or directory |
| `get_env` | Read one or all environment variables |
| `set_env` | Set or unset an environment variable (persists for server session) |
| `cron_manage` | List, add, remove, or clear crontab entries |
| `get_logs` | Read logs via `journalctl` or tail a log file |
| `archive` | Compress or extract tar, tar.gz, tar.bz2, zip archives |

## Installation

```bash
git clone <repo> && cd grok-mcp
npm install
npm run build
```

> **Note:** `node-pty` (used for PTY sessions) requires native compilation. On Ubuntu, make sure you have `build-essential` and `python3` installed:
> ```bash
> sudo apt install build-essential python3
> ```

## Running

### HTTP mode (default — binds to a port)

```bash
node dist/index.js
# [grok-mcp] HTTP server listening on http://0.0.0.0:8083
# [grok-mcp]   MCP    → http://0.0.0.0:8083/mcp
# [grok-mcp]   Health → http://0.0.0.0:8083/health
```

Override the port or bind address with environment variables:

```bash
PORT=9000 HOST=127.0.0.1 node dist/index.js
```

### Stdio mode (MCP client spawns the process directly)

```bash
node dist/index.js --stdio
```

## MCP Client Configuration

### HTTP (remote VM over the network)

```json
{
  "mcpServers": {
    "grok-mcp": {
      "url": "http://your-vm-ip:8083/mcp"
    }
  }
}
```

### Stdio (local process)

```json
{
  "mcpServers": {
    "grok-mcp": {
      "command": "node",
      "args": ["/path/to/grok-mcp/dist/index.js", "--stdio"]
    }
  }
}
```

### Health check

```bash
curl http://your-vm-ip:8083/health
# {"status":"ok","active_sessions":0}
```

## Background Process Pattern

```
run_background("npm run dev") → { session_id: "proc_..." }
get_process_status("proc_...")  → { status: "running", pid: 1234 }
get_process_output("proc_...")  → { stdout: "...", stderr: "..." }
kill_process("proc_...")
```

## Interactive PTY Pattern

```
session_create()                          → { session_id: "pty_..." }
session_write("pty_...", "python3\n")
session_read("pty_...", wait_ms: 500)     → { output: "Python 3.x.x ..." }
session_write("pty_...", "print('hi')\n")
session_read("pty_...", wait_ms: 200)     → { output: "hi\n>>>" }
session_close("pty_...")
```

## Development

```bash
npm run watch   # TypeScript watch mode
npm run build   # One-shot build
npm start       # Run compiled server
```
