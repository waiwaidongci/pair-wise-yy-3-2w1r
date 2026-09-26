import http from "node:http";
import {
  FlowError,
  addSlice,
  createSample,
  deliver,
  findSample,
  loadDb,
  logStep,
  reviewSlice,
  rework,
  saveDb
} from "./lib/store.js";
import {
  PRODUCTION_STEPS,
  STATUSES,
  STEPS,
  decorateSample
} from "./lib/flow.js";

const port = Number(process.env.PORT || 3025);

function findSliceOrThrow(sample, sliceId) {
  const slice = sample.slices.find(item => item.id === sliceId);
  if (!slice) throw new FlowError("slice_not_found");
  return slice;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

const ERROR_MESSAGES = {
  sample_not_found: "样本不存在",
  slice_not_found: "切片不存在",
  reviewer_required: "请填写复核人",
  review_not_pending: "该切片当前不处于待复核状态",
  reviewer_matches_operator: "复核人不能与最近操作人相同",
  review_required_before_delivery: "所有切片复核通过后才可交付",
  already_delivered: "样本已交付",
  operator_required: "请填写操作人",
  invalid_step: "返工步骤无效",
  no_reworkable_slice: "没有可返工的待复核切片",
  slice_already_approved: "切片已复核通过，如需修改请走返工流程"
};

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --warn:#9a5b27; --ok:#3d6b3a; --stone:#73706a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2,h3 { margin:0 0 12px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:60px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    button.warn { background:var(--warn); } button:disabled { opacity:.45; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.review { border-color:var(--warn); color:var(--warn); } .pill.ok { border-color:var(--ok); color:var(--ok); } .pill.done { background:var(--accent); color:#fff; border-color:var(--accent); }
    .badge { font-size:12px; border-radius:6px; padding:4px 8px; } .badge.review { background:#f6e9dc; color:var(--warn); } .badge.ok { background:#e4eee0; color:var(--ok); }
    .slice { border-top:1px solid var(--line); padding-top:10px; display:grid; gap:6px; }
    .rework-reason { background:#f6e9dc; border-radius:6px; padding:7px 9px; font-size:13px; color:var(--warn); }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; } .row3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
    .error { color:#a23b2e; font-size:13px; min-height:16px; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">制片步骤 · 复核 · 返工与交付（复核通过才可交付）</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="error" id="globalError"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(STATUSES)};
    const steps = ${JSON.stringify(STEPS)};
    const productionSteps = ${JSON.stringify(PRODUCTION_STEPS)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const globalError = document.querySelector("#globalError");
    let samples = [];

    const ERROR_MESSAGES = ${JSON.stringify(ERROR_MESSAGES)};
    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(ERROR_MESSAGES[data.error] || data.error || "请求失败");
      return data;
    }
    function fmtTime(at) { return at ? new Date(at).toLocaleString("zh-CN") : ""; }
    function pillClass(status) {
      if (status === "已交付") return "done";
      if (status === "可交付") return "ok";
      if (status === "待复核") return "review";
      return "";
    }

    function renderSlice(sample, slice) {
      const pending = slice.reviewState === "待复核";
      const approved = slice.reviewState === "复核通过";
      const rework = slice.reworkReason;
      const options = steps.map(step => '<option value="'+step+'"'+(step===slice.status?" selected":"")+">"+step+"</option>").join("");
      let html = '<div class="slice"><b>'+esc(slice.id)+'</b>'
        + '<div class="meta">'+esc(slice.method)+' · 当前步骤 '+esc(slice.status)+' · 状态 '+esc(slice.reviewState)+'</div>'
        + '<div class="meta">最近操作人：'+esc(slice.lastOperator || "（无）")+'</div>';
      if (slice.observation) html += '<div class="meta">观察记录：'+esc(slice.observation)+'</div>';
      if (slice.review && approved) html += '<div class="meta">复核：'+esc(slice.review.reviewer)+' 通过 · '+fmtTime(slice.review.at)+'</div>';
      if (rework) html += '<div class="rework-reason">返工原因：'+esc(rework.reason)+'（回到 '+esc(rework.to)+'，操作人 '+esc(rework.operator||"—")+'，'+fmtTime(rework.at)+'）</div>';

      // 原有记录入口保留：制片步骤 / 观察记录
      html += '<label>记录步骤（观察完成后需复核）</label>'
        + '<div class="row3"><select data-key="step" data-sample="'+sample.id+'" data-slice="'+slice.id+'">'+options+'</select>'
        + '<input data-key="operator" data-sample="'+sample.id+'" data-slice="'+slice.id+'" placeholder="操作人">'
        + '<button data-action="log" data-sample="'+sample.id+'" data-slice="'+slice.id+'">记录步骤</button></div>'
        + '<textarea data-key="note" data-sample="'+sample.id+'" data-slice="'+slice.id+'" placeholder="步骤备注或观察结果"></textarea>';

      // 复核入口
      if (pending) {
        const stepOptions = productionSteps.map(s => '<option value="'+s+'"'+(s==="染色"?" selected":"")+">"+s+"</option>").join("");
        html += '<div class="badge review">待复核：复核人不可为最近操作人（'+esc(slice.lastOperator || "无")+'）</div>'
          + '<label>复核人</label><input data-key="reviewer" data-sample="'+sample.id+'" data-slice="'+slice.id+'" placeholder="复核人姓名">'
          + '<div class="row"><select data-key="conclusion" data-sample="'+sample.id+'" data-slice="'+slice.id+'"><option value="通过">复核通过</option><option value="退回">复核退回（返工）</option></select>'
          + '<select data-key="returnStep" data-sample="'+sample.id+'" data-slice="'+slice.id+'">'+stepOptions+'</select></div>'
          + '<textarea data-key="reviewNote" data-sample="'+sample.id+'" data-slice="'+slice.id+'" placeholder="观察结论 / 复核意见（退回时即返工原因）"></textarea>'
          + '<button data-action="review" data-sample="'+sample.id+'" data-slice="'+slice.id+'">提交复核</button>';
      }
      html += '</div>';
      return html;
    }

    function renderCard(sample) {
      let badges = "";
      if (sample.status === "待复核") badges = '<span class="badge review">待复核：'+sample.slices.filter(s => s.reviewState==="待复核").length+' 个切片未复核</span>';
      if (sample.deliverable) badges = '<span class="badge ok">可交付：全部切片复核通过</span>';
      if (sample.reworking) badges += ' <span class="badge review">返工件：按卡片内返工原因重做</span>';

      const stepOptions = productionSteps.map(s => '<option value="'+s+'">'+s+'</option>').join("");
      return '<article class="card">'
        + '<h3>'+esc(sample.project)+'</h3>'
        + '<span class="pill '+pillClass(sample.status)+'">'+esc(sample.status)+'</span>'
        + (badges ? '<div>'+badges+'</div>' : '')
        + '<div class="meta">'+esc(sample.borehole)+' · '+esc(sample.coreBox)+' · '+esc(sample.depth)+' · 负责人 '+esc(sample.owner)+' · 交付：'+esc(sample.delivery)+'</div>'
        + '<label>新增切片</label><div class="row3"><input data-key="newSlice" data-sample="'+sample.id+'" placeholder="切片编号">'
        + '<input data-key="newMethod" data-sample="'+sample.id+'" placeholder="染色方法">'
        + '<button data-action="add" data-sample="'+sample.id+'">添加切片</button></div>'
        + sample.slices.map(slice => renderSlice(sample, slice)).join("")
        + '<label>返工（全部待复核切片重做；已交付会先撤交付，旧结论留档不计统计）</label>'
        + '<div class="row"><select data-key="reworkStep" data-sample="'+sample.id+'">'+stepOptions+'</select>'
        + '<input data-key="reworkOperator" data-sample="'+sample.id+'" placeholder="返工操作人"></div>'
        + '<textarea data-key="reworkReason" data-sample="'+sample.id+'" placeholder="返工原因"></textarea>'
        + '<button class="warn" data-action="rework" data-sample="'+sample.id+'">返工重做</button>'
        + '<button data-action="deliver" data-sample="'+sample.id+'" '+(sample.deliverable?"":"disabled")+'>'+(sample.delivery==="已交付"?"已交付":"标记交付")+'</button>'
        + '</article>';
    }

    function render() {
      globalError.textContent = "";
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+samples.filter(item => item.status === s).length+'</strong></div>').join("");
      samplesEl.innerHTML = samples.map(renderCard).join("");
    }

    function fields(sampleId, sliceId) {
      const attrSel = '[data-sample="'+sampleId+'"]' + (sliceId ? '[data-slice="'+sliceId+'"]' : '');
      const out = {};
      document.querySelectorAll(attrSel).forEach(el => { if (el.dataset.key) out[el.dataset.key] = el; });
      return out;
    }

    samplesEl.addEventListener("click", async event => {
      const btn = event.target.closest("button[data-action]");
      if (!btn) return;
      const sampleId = btn.dataset.sample;
      const sliceId = btn.dataset.slice;
      const f = fields(sampleId, sliceId);
      const sf = fields(sampleId);
      try {
        if (btn.dataset.action === "add") {
          await api('/api/samples/'+sampleId+'/slices', { method:'POST', body: JSON.stringify({ id: f.newSlice.value, method: f.newMethod.value || "未指定" }) });
        } else if (btn.dataset.action === "log") {
          await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', { method:'POST', body: JSON.stringify({ step: f.step.value, note: f.note.value, operator: f.operator.value }) });
        } else if (btn.dataset.action === "review") {
          await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/reviews', { method:'POST', body: JSON.stringify({ reviewer: f.reviewer.value, conclusion: f.conclusion.value, returnStep: f.returnStep.value, note: f.reviewNote.value }) });
        } else if (btn.dataset.action === "rework") {
          await api('/api/samples/'+sampleId+'/rework', { method:'POST', body: JSON.stringify({ step: sf.reworkStep.value, reason: sf.reworkReason.value, operator: sf.reworkOperator.value }) });
        } else if (btn.dataset.action === "deliver") {
          await api('/api/samples/'+sampleId+'/deliver', { method:'POST', body: JSON.stringify({}) });
        }
        await load();
      } catch (error) { globalError.textContent = error.message; }
    });

    async function load(){ samples = await api("/api/samples"); render(); }
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        await api("/api/samples", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); await load();
      } catch (error) { globalError.textContent = error.message; }
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") {
      return sendJson(res, 200, db.samples.map(decorateSample));
    }
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const sample = createSample(input);
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, decorateSample(sample));
    }
    const addSliceMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSliceMatch && req.method === "POST") {
      const sample = findSample(db, addSliceMatch[1]);
      const input = await body(req);
      addSlice(sample, input);
      await saveDb(db);
      return sendJson(res, 201, decorateSample(sample));
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const sample = findSample(db, logMatch[1]);
      const slice = findSliceOrThrow(sample, logMatch[2]);
      const input = await body(req);
      logStep(sample, slice, input);
      await saveDb(db);
      return sendJson(res, 200, decorateSample(sample));
    }
    const reviewMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/reviews$/);
    if (reviewMatch && req.method === "POST") {
      const sample = findSample(db, reviewMatch[1]);
      const slice = findSliceOrThrow(sample, reviewMatch[2]);
      const input = await body(req);
      reviewSlice(sample, slice, input);
      await saveDb(db);
      return sendJson(res, 200, decorateSample(sample));
    }
    const reworkMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/rework$/);
    if (reworkMatch && req.method === "POST") {
      const sample = findSample(db, reworkMatch[1]);
      const input = await body(req);
      rework(sample, input);
      await saveDb(db);
      return sendJson(res, 200, decorateSample(sample));
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sample = findSample(db, deliverMatch[1]);
      const input = await body(req);
      deliver(sample, input);
      await saveDb(db);
      return sendJson(res, 200, decorateSample(sample));
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof FlowError) return sendJson(res, 400, { error: error.code, message: ERROR_MESSAGES[error.code] || error.code });
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
