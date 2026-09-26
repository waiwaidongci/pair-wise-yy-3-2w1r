// 岩芯切片实验室 —— HTTP 路由层
// 只做请求解析、静态文件与错误映射；流程判断见 lib/workflow.js，数据写入见 lib/store.js。

import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { addSample, addSlice, deliver, listSamples, logStep, review, rework } from "./lib/store.js";
import { errorMessage, reviewResults, sampleStatuses, taskSteps } from "./lib/workflow.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3025);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

// 业务结果统一映射：ok → 200/201，否则 400 + 中文错误信息
function sendResult(res, result, okStatus = 200) {
  if (result.ok) return sendJson(res, okStatus, result.sample);
  const status = result.code === "sample_not_found" || result.code === "slice_not_found" ? 404 : 400;
  return sendJson(res, status, { error: errorMessage(result.code), code: result.code });
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/api/meta") {
      return sendJson(res, 200, { statuses: sampleStatuses, steps: taskSteps, reviewResults });
    }
    if (req.method === "GET" && path === "/api/samples") {
      return sendJson(res, 200, await listSamples());
    }
    if (req.method === "POST" && path === "/api/samples") {
      return sendResult(res, await addSample(await body(req)), 201);
    }

    let match = path.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (match && req.method === "POST") {
      return sendResult(res, await addSlice(decodeURIComponent(match[1]), await body(req)), 201);
    }
    match = path.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (match && req.method === "POST") {
      return sendResult(res, await logStep(decodeURIComponent(match[1]), decodeURIComponent(match[2]), await body(req)));
    }
    match = path.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/reviews$/);
    if (match && req.method === "POST") {
      return sendResult(res, await review(decodeURIComponent(match[1]), decodeURIComponent(match[2]), await body(req)));
    }
    match = path.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/rework$/);
    if (match && req.method === "POST") {
      return sendResult(res, await rework(decodeURIComponent(match[1]), decodeURIComponent(match[2]), await body(req)));
    }
    match = path.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (match && req.method === "POST") {
      return sendResult(res, await deliver(decodeURIComponent(match[1])));
    }

    if (req.method === "GET") return serveStatic(res, path);
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
