import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(FILE), "..");

if (process.argv.includes("--server")) {
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    const callback = args.findLast((value) => typeof value === "function");
    return listen.call(this, 0, "127.0.0.1", () => {
      callback?.();
      process.send({ port: this.address().port });
    });
  };
  globalThis.fetch = async () => {
    throw new Error("Network access is disabled in the authentication routing test");
  };
  await import("../server/src/index.js");
} else {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-auth-routing-"));
  const marker = path.join(temporary, "unexpected-process.txt");
  const fakeKey = "TEST-ONLY-NOT-A-REAL-API-KEY";
  fs.writeFileSync(path.join(temporary, "config.json"), JSON.stringify({
    providers: [{ id: "audit", name: "Test", keys: [fakeKey], models: [] }],
    projects: [],
  }));

  const child = spawn(process.execPath, [FILE, "--server"], {
    cwd: ROOT,
    env: {
      ...process.env,
      URANUS_DATA_DIR: temporary,
      URANUS_IG_PORT: "off",
      IMESSAGE_BRIDGE: "off",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
  }
  const closed = once(child, "close");
  let passed = 0;
  let failed = 0;
  function check(name, actual, expected) {
    try {
      assert.deepEqual(actual, expected);
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch {
      failed += 1;
      console.log(`  ✗ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  try {
    const { port } = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Backend startup timed out\n${output}`)), 30000);
      const finish = (callback, value) => {
        clearTimeout(timer);
        child.off("message", ready);
        child.off("exit", exited);
        child.off("error", errored);
        callback(value);
      };
      const ready = (message) => finish(resolve, message);
      const exited = (code) => finish(reject, new Error(`Backend exited (${code})\n${output}`));
      const errored = (error) => finish(reject, error);
      child.once("message", ready);
      child.once("exit", exited);
      child.once("error", errored);
    });
    const base = `http://127.0.0.1:${port}`;
    const request = (route, { method = "GET", cookie, body } = {}) => fetch(base + route, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const configurationPaths = [
      "/api/config", "/API/config", "/Api/config", "/aPi/config", "/API/CONFIG", "/API/config/",
    ];
    async function checkUnauthenticated(label) {
      for (const route of configurationPaths) {
        const response = await request(route);
        const text = await response.text();
        check(`${label}: GET ${route} requires login`, response.status, 401);
        check(`${label}: GET ${route} does not expose the test key`, text.includes(fakeKey), false);
      }
    }

    console.log("\n=== Authentication on real backend routes ===");
    await checkUnauthenticated("Before password setup");
    for (const route of ["/api/health", "/API/health", "/Api/Auth/State", "/API/AUTH/STATE/"]) {
      const response = await request(route);
      check(`Public endpoint ${route} remains accessible`, response.status, 200);
      await response.text();
    }

    const login = await request("/API/AUTH/LOGIN", {
      method: "POST", body: { username: "Uranus", password: "Uranus" },
    });
    check("Default login remains accessible", login.status, 200);
    const initialCookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(initialCookie, "Default login must issue a cookie");
    await login.text();
    const initialConfiguration = await request("/api/config", { cookie: initialCookie });
    const configuration = await initialConfiguration.json();
    for (const route of ["/api/config", "/API/config", "/API/CONFIG/"]) {
      const response = await request(route, { method: "PUT", cookie: initialCookie, body: configuration });
      check(`Default session cannot modify configuration via ${route}`, response.status, 403);
      await response.text();
    }
    const mcpBody = { server: {
      transport: "stdio",
      command: process.execPath,
      args: ["-e", `
        require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected process execution");
        require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
          const message = JSON.parse(line);
          if (message.id == null) return;
          const result = message.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } }
            : { tools: [] };
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
        });
      `],
    } };
    for (const route of ["/api/mcp/test", "/API/mcp/test", "/Api/Mcp/Test/"]) {
      const response = await request(route, { method: "POST", cookie: initialCookie, body: mcpBody });
      check(`Default session cannot launch MCP via ${route}`, response.status, 403);
      await response.text();
    }

    const changed = await request("/Api/Auth/Change", {
      method: "POST", cookie: initialCookie,
      body: { username: "routing-test", password: "Routing-Test-Only-48291" },
    });
    check("Password change works with mixed-case paths", changed.status, 200);
    const cookie = changed.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "Password change must issue a cookie");
    await changed.text();

    await checkUnauthenticated("After password setup");
    for (const route of ["/api/mcp/test", "/API/mcp/test", "/Api/Mcp/Test/"]) {
      const response = await request(route, { method: "POST", body: mcpBody });
      check(`Unauthenticated ${route} cannot launch MCP`, response.status, 401);
      await response.text();
    }
    check("Blocked MCP requests never start the test process", fs.existsSync(marker), false);
    for (const route of configurationPaths) {
      const response = await request(route, { cookie });
      check(`Authenticated ${route} works`, response.status, 200);
      check(`Authenticated ${route} returns the test configuration`, (await response.text()).includes(fakeKey), true);
    }
    const invalid = await request("/API/config", { cookie: "uranus_session=invalid" });
    check("Invalid cookies are rejected on mixed-case paths", invalid.status, 401);
    await invalid.text();
    const head = await request("/API/config", { method: "HEAD" });
    check("Unauthenticated HEAD requests are rejected", head.status, 401);
    const validMcp = await request("/API/mcp/test", { method: "POST", cookie, body: {} });
    check("Authenticated MCP requests reach input validation", validMcp.status, 400);
    await validMcp.text();
  } finally {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    await closed;
    clearTimeout(force);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed / ${failed} failed\n`);
  process.exitCode = failed ? 1 : 0;
}
