/** 构建新鲜度回归：只操作临时目录，不修改实际源码或 dist。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-needs-build-"));
try {
  fs.mkdirSync(path.join(tmp, "scripts"));
  fs.mkdirSync(path.join(tmp, "client/dist"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "client/src"));
  fs.mkdirSync(path.join(tmp, "shared"));
  const script = path.join(tmp, "scripts/needs-build.mjs");
  fs.copyFileSync(new URL("./needs-build.mjs", import.meta.url), script);
  const { needsBuild } = await import(pathToFileURL(script).href);
  assert.equal(needsBuild().stale, true);

  const marker = path.join(tmp, "client/dist/index.html");
  fs.writeFileSync(marker, "<html></html>");
  assert.equal(needsBuild().reason, "dist 里没有 instagram.html");
  fs.writeFileSync(path.join(tmp, "client/dist/instagram.html"), "<html></html>");
  const source = path.join(tmp, "client/src/index.js");
  const shared = path.join(tmp, "shared/tts.mjs");
  fs.writeFileSync(source, "export const client = true;\n");
  fs.writeFileSync(shared, "export const channel = true;\n");
  const before = new Date(Date.now() - 60000);
  const after = new Date(Date.now() + 60000);
  fs.utimesSync(source, before, before);
  fs.utimesSync(shared, before, before);
  assert.equal(needsBuild().stale, false);

  fs.utimesSync(shared, after, after);
  assert.equal(needsBuild().stale, true);
  assert.match(needsBuild().reason, /shared[/\\]tts\.mjs/);
  fs.utimesSync(shared, before, before);
  fs.utimesSync(source, after, after);
  assert.equal(needsBuild().stale, true);
  fs.utimesSync(source, before, before);
  fs.rmSync(path.join(tmp, "shared"), { recursive: true });
  assert.equal(needsBuild().stale, false);
  console.log("构建新鲜度全部通过：缺失入口、前端源码、共享模块和可选目录");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
