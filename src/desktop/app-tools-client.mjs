import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assertAppToolsPipePath, configuredDesktopThreadId, configuredNodePath, requireAppToolsServer } from "./config.mjs";

const PIPE_ENV = "CODEX_APP_TOOLS_PIPE_PATH";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_CHARS = 8 * 1024;
const PROTOCOL_VERSION = "2025-06-18";

/**
 * Minimal newline-delimited JSON-RPC client for the official Codex App Tools
 * MCP server. The server itself owns the app-tools pipe; this client only
 * talks to it through MCP stdio.
 */
export class AppToolsMcpClient {
  constructor({
    pipePath = process.env[PIPE_ENV],
    serverPath,
    threadId,
    nodePath = configuredNodePath(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.pipePath = pipePath ? assertAppToolsPipePath(pipePath) : "";
    this.serverPath = serverPath ? requireAppToolsServer(serverPath) : resolveServerPath();
    this.threadId = threadId ?? configuredDesktopThreadId();
    this.nodePath = nodePath;
    this.timeoutMs = timeoutMs;

    this.child = null;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.pending = new Map();
    this.nextRequestId = 1;
    this.toolCatalog = null;
    this.initializing = null;
    this.closed = false;
    this.fatalError = null;
  }

  async connect() {
    if (this.closed) throw new Error("MCP client is closed");
    if (this.fatalError) throw this.fatalError;
    if (this.child) return;
    if (!this.pipePath) {
      throw new Error(`${PIPE_ENV} is not set; the Codex App Tools server cannot connect`);
    }
    if (!this.serverPath) throw new Error("Codex App Tools server is not installed or configured");
    if (typeof this.threadId !== "string" || !this.threadId.trim()) throw new Error("Codex Desktop thread is not configured");

    let child;
    try {
      const effectiveServerPath = requireAppToolsServer(this.serverPath);
      child = spawn(this.nodePath, [effectiveServerPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, [PIPE_ENV]: this.pipePath },
      });
    } catch {
      throw new Error("Could not start the configured Codex App Tools MCP server");
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stdout.on("error", () => this._fail(new Error("MCP server stdout closed unexpectedly")));
    child.stderr.on("data", (chunk) => this._onStderr(chunk));
    child.stderr.on("error", () => {});
    child.stdin.on("error", (error) => {
      this._fail(new Error(`MCP server stdin failed${error?.code ? ` (${error.code})` : ""}`));
    });
    child.once("error", (error) => {
      this._fail(
        new Error(`Could not start the configured Codex App Tools MCP server${error?.code ? ` (${error.code})` : ""}`),
      );
    });
    child.once("exit", (code, signal) => {
      if (!this.closed && !this.fatalError) {
        const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
        this._fail(new Error(`Codex App Tools MCP server exited (${status})`));
      }
    });
    child.once("close", () => {
      if (!this.closed && !this.fatalError) {
        this._fail(new Error("Codex App Tools MCP server closed unexpectedly"));
      }
    });
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    if (this.closed) throw new Error("MCP client is closed");
    this.initializing = (async () => {
      await this.connect();
      const result = await this._request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "codex-app-tools-local-client", version: "0.1.0" },
      });
      await this._writeMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      return result;
    })();
    try {
      return await this.initializing;
    } catch (error) {
      this.initializing = null;
      throw error;
    }
  }

  async listTools({ refresh = false, timeoutMs = this.timeoutMs } = {}) {
    await this.initialize();
    if (this.toolCatalog && !refresh) return this.toolCatalog;
    const result = await this._request("tools/list", {}, timeoutMs);
    this.toolCatalog = Array.isArray(result?.tools) ? result.tools : [];
    return this.toolCatalog;
  }

  async list(options) {
    return this.listTools(options);
  }

  async callTool(name, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (typeof name !== "string" || !name.trim()) throw new TypeError("Tool name is required");
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw new TypeError("Tool arguments must be an object");
    }
    await this.initialize();
    const result = await this._request(
      "tools/call",
      {
        name,
        arguments: args,
        _meta: {
          "openai/threadId": this.threadId,
          "openai/toolCallId": randomUUID(),
        },
      },
      timeoutMs,
    );
    return withParsedTextContent(result);
  }

  async call(name, args = {}, options) {
    return this.callTool(name, args, options);
  }

  async sendMessage(input, options) {
    const tool = await this._findTool(["send_message_to_thread", "sendMessage"]);
    const args = this._convenienceArgs(tool, input);
    if (hasProperty(tool, "threadId") && args.threadId == null) args.threadId = this.threadId;
    this._assertRequired(tool, args);
    return this.callTool(tool.name, args, options);
  }

  async readThread(input = {}, options) {
    const tool = await this._findTool(["read_thread", "readThread"]);
    const args = this._convenienceArgs(tool, input);
    if (hasProperty(tool, "threadId") && args.threadId == null) args.threadId = this.threadId;
    this._assertRequired(tool, args);
    return this.callTool(tool.name, args, options);
  }

  async waitThreads(input = {}, options) {
    const tool = await this._findTool(["wait_threads", "waitThreads"]);
    const args = this._convenienceArgs(tool, input);
    if (hasProperty(tool, "targets") && args.targets == null) {
      const target = { threadId: args.threadId ?? this.threadId };
      delete args.threadId;
      for (const key of ["hostId", "afterCursor"]) {
        if (args[key] != null) {
          target[key] = args[key];
          delete args[key];
        }
      }
      args.targets = [target];
    }
    this._assertRequired(tool, args);
    return this.callTool(tool.name, args, options);
  }

  async close({ graceMs = 500 } = {}) {
    if (this.closed) return;
    this.closed = true;
    this._rejectPending(new Error("MCP client closed"));
    const child = this.child;
    this.child = null;
    if (!child) return;

    await new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(forceKill);
        clearTimeout(finalize);
        resolve();
      };
      child.once("close", finish);
      const finalize = setTimeout(finish, Math.max(graceMs, 1) + 1_500);
      const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, Math.max(graceMs, 1));
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      else if (child.exitCode !== null || child.signalCode !== null) finish();
    });
  }

  async _findTool(aliases) {
    const tools = await this.listTools();
    const normalizedAliases = aliases.map(normalizeToolName);
    const tool = tools.find((candidate) => {
      const name = normalizeToolName(candidate?.name ?? "");
      return normalizedAliases.some((alias) => name === alias || name.endsWith(alias));
    });
    if (!tool) throw new Error(`Required Codex App Tools method is not available: ${aliases[0]}`);
    return tool;
  }

  _convenienceArgs(tool, input) {
    const properties = tool?.inputSchema?.properties ?? {};
    let args;
    if (typeof input === "string") {
      args = {};
      if (Object.hasOwn(properties, "prompt")) args.prompt = input;
      else if (Object.hasOwn(properties, "threadId")) args.threadId = input;
      else throw new TypeError(`Tool ${tool.name} does not accept a string shorthand`);
    } else if (Array.isArray(input)) {
      args = Object.hasOwn(properties, "targets") ? { targets: input } : {};
    } else if (input && typeof input === "object") {
      args = { ...input };
    } else {
      args = {};
    }

    return args;
  }

  _assertRequired(tool, args) {
    const missing = (tool?.inputSchema?.required ?? []).filter((key) => args[key] === undefined);
    if (missing.length) {
      throw new TypeError(`Missing required ${tool.name} argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
    }
  }

  _onStdout(chunk) {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_LINE_BYTES && !this.stdoutBuffer.includes("\n")) {
      this._fail(new Error("MCP server response exceeded the maximum line size"));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this._fail(new Error("MCP server response exceeded the maximum line size"));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this._fail(new Error("MCP server returned an invalid JSON-RPC message"));
        return;
      }
      if (message?.id === undefined || message?.id === null) continue;
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "MCP request failed"));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  _onStderr(chunk) {
    this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_CHARS);
  }

  _request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.child || this.closed) return Promise.reject(new Error("MCP client is not connected"));
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this._writeMessage({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        const pending = this.pending.get(String(id));
        if (!pending) return;
        this.pending.delete(String(id));
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  _writeMessage(message) {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed || this.closed) {
      return Promise.reject(new Error("MCP server stdin is unavailable"));
    }
    const serialized = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      child.stdin.write(serialized, (error) => {
        if (error) reject(new Error(`Could not write to MCP server stdin${error.code ? ` (${error.code})` : ""}`));
        else resolve();
      });
    });
  }

  _fail(error) {
    if (this.fatalError) return;
    this.fatalError = error;
    this._rejectPending(error);
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function resolveServerPath() {
  try { return requireAppToolsServer(); } catch { return null; }
}

function normalizeToolName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasProperty(tool, name) {
  return Object.hasOwn(tool?.inputSchema?.properties ?? {}, name);
}

function withParsedTextContent(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) return result;
  const parsedContent = result.content.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    try {
      return { ...block, parsed: JSON.parse(block.text) };
    } catch {
      return block;
    }
  });
  return { ...result, content: result.content, parsedContent };
}

export default AppToolsMcpClient;
