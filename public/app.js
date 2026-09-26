// 岩芯切片实验室 —— 页面交互层
// 只负责渲染与事件；流程判断在服务端 lib/workflow.js，数据写入在 lib/store.js。

const statsEl = document.querySelector("#stats");
const samplesEl = document.querySelector("#samples");
const sampleForm = document.querySelector("#sample-form");

let meta = { statuses: [], steps: [], reviewResults: [] };
let samples = [];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

async function api(path, options) {
  const res = await fetch(path, options && options.body
    ? { ...options, headers: { "Content-Type": "application/json" } }
    : options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function fmtTime(at) {
  return at ? new Date(at).toLocaleString("zh-CN", { hour12: false }) : "";
}

// ---------- 统计（撤交付/返工归档的旧记录不计入） ----------

function renderStats() {
  const cards = meta.statuses.map(s => ({
    label: s,
    value: samples.filter(item => item.status === s).length,
  }));
  const pendingReview = samples.reduce(
    (n, s) => n + s.slices.filter(sl => sl.state === "待复核").length, 0);
  const deliveredNow = samples.filter(s => s.delivery === "已交付").length;
  const archived = samples.reduce(
    (n, s) => n + s.slices.reduce((m, sl) => m + sl.archived.length, 0), 0);
  cards.push(
    { label: "待复核切片", value: pendingReview },
    { label: "当前已交付", value: deliveredNow },
    { label: "归档旧结论(不计入)", value: archived },
  );
  statsEl.innerHTML = cards
    .map(c => `<div class="stat"><span>${esc(c.label)}</span><strong>${c.value}</strong></div>`)
    .join("");
}

// ---------- 卡片渲染 ----------

function statusBanner(sample) {
  if (sample.status === "已交付") {
    return `<div class="banner info">已交付（${esc(fmtTime(sample.deliveredAt))}）。如需修改请走返工，系统会先撤回本次交付并留档。</div>`;
  }
  if (sample.status === "可交付") {
    return `<div class="banner ok">所有切片复核通过，可交付。</div>`;
  }
  if (sample.status === "待复核") {
    return `<div class="banner warn">切片已进入观察，等待复核：${esc(sample.pendingSlices.join("、"))}。复核通过前不可交付。</div>`;
  }
  if (sample.status === "制片中") {
    return `<div class="banner warn">切片制片中，完成“观察”并复核通过后才可交付。</div>`;
  }
  return "";
}

function reviewList(slice) {
  if (!slice.reviews.length) return "";
  const items = slice.reviews.map(r =>
    `<div class="meta">${esc(fmtTime(r.at))} · 复核人 ${esc(r.reviewer)} · <b>${esc(r.result)}</b> · 结论：${esc(r.conclusion)}</div>`);
  return `<div class="logs"><b>复核记录</b>${items.join("")}</div>`;
}

function archivedList(slice) {
  if (!slice.archived.length) return "";
  const items = slice.archived.map(a => {
    const reviews = (a.reviews || [])
      .map(r => `复核人 ${esc(r.reviewer)} ${esc(r.result)}：${esc(r.conclusion)}`)
      .join("；") || "无复核记录";
    return `<div class="archived-item">
      <div>${esc(fmtTime(a.at))} · ${esc(a.type)} · 操作人 ${esc(a.operator)} · 退回「${esc(a.toStep)}」</div>
      <div>返工原因：${esc(a.reason)}</div>
      <div>旧观察结论：${esc(a.observation || "（无）")}</div>
      <div>旧复核：${reviews}</div>
    </div>`;
  }).join("");
  return `<details><summary>归档旧结论 ${slice.archived.length} 条（留档，不计入统计）</summary>${items}</details>`;
}

function deliveryLedger(sample) {
  if (!sample.deliveryHistory.length) return "";
  const items = sample.deliveryHistory.map(h => {
    const extra = h.type === "撤交付"
      ? ` · 原因：${esc(h.reason)} · 操作人 ${esc(h.operator)}（留档不计入统计）`
      : "";
    return `<div class="meta">${esc(fmtTime(h.at))} · ${esc(h.type)}${extra}</div>`;
  }).join("");
  return `<details><summary>交付记录 ${sample.deliveryHistory.length} 条</summary>${items}</details>`;
}

function stepForm(sample, slice) {
  const disabled = sample.delivery === "已交付";
  const options = meta.steps
    .map(s => `<option ${s === slice.status ? "selected" : ""}>${s}</option>`).join("");
  return `<form data-form="step" data-sample="${esc(sample.id)}" data-slice="${esc(slice.id)}">
    <h4>记录步骤</h4>
    <div class="row">
      <div><label>步骤</label><select name="step" ${disabled ? "disabled" : ""}>${options}</select></div>
      <div><label>操作人</label><input name="operator" placeholder="操作人" ${disabled ? "disabled" : ""} required></div>
    </div>
    <label>备注 / 观察结果</label>
    <textarea name="note" placeholder="步骤备注或观察结果" ${disabled ? "disabled" : ""}></textarea>
    <button ${disabled ? "disabled" : ""}>记录步骤</button>
  </form>`;
}

function reviewForm(sample, slice) {
  if (slice.status !== "观察" || sample.delivery === "已交付") return "";
  const hint = slice.latestOperator
    ? `最近操作人：${esc(slice.latestOperator)}（复核人不能与其相同）`
    : "尚无操作人记录";
  const options = meta.reviewResults.map(r => `<option>${r}</option>`).join("");
  return `<form data-form="review" data-sample="${esc(sample.id)}" data-slice="${esc(slice.id)}">
    <h4>复核</h4>
    <div class="meta">${hint}</div>
    <div class="row">
      <div><label>复核人</label><input name="reviewer" required></div>
      <div><label>复核结果</label><select name="result">${options}</select></div>
    </div>
    <label>观察结论</label>
    <textarea name="conclusion" placeholder="复核后的观察结论" required></textarea>
    <button>提交复核</button>
  </form>`;
}

function reworkForm(sample, slice) {
  const options = meta.steps
    .map(s => `<option ${s === slice.status ? "" : ""}>${s}</option>`).join("");
  return `<details><summary>申请返工（退回指定步骤重做）</summary>
    <form data-form="rework" data-sample="${esc(sample.id)}" data-slice="${esc(slice.id)}">
      <div class="row">
        <div><label>退回步骤</label><select name="step">${options}</select></div>
        <div><label>操作人</label><input name="operator" required></div>
      </div>
      <label>返工原因</label>
      <textarea name="reason" placeholder="必填，将随旧结论一起归档" required></textarea>
      <button class="warn">提交返工</button>
    </form>
  </details>`;
}

function sliceCard(sample, slice) {
  const rework = slice.archived.length ? slice.archived[slice.archived.length - 1] : null;
  const reworkBanner = rework
    ? `<div class="banner bad">最近返工：退回「${esc(rework.toStep)}」 · 原因：${esc(rework.reason)} · 操作人 ${esc(rework.operator)} · ${esc(fmtTime(rework.at))}</div>`
    : "";
  const logs = slice.logs.map(l =>
    `${esc(l.step)}（${esc(l.operator || "未记录")}）：${esc(l.note)}`).join(" / ");
  return `<div class="slice">
    <div class="slice-head">
      <b>${esc(slice.id)}</b>
      <span class="pill status-${esc(slice.state)}">${esc(slice.state)}</span>
    </div>
    <div class="meta">${esc(slice.method)} · 当前步骤 ${esc(slice.status)} · 最近操作人 ${esc(slice.latestOperator || "未记录")}</div>
    ${slice.observation ? `<div class="meta">观察结果：${esc(slice.observation)}</div>` : ""}
    ${reworkBanner}
    ${reviewList(slice)}
    ${stepForm(sample, slice)}
    ${reviewForm(sample, slice)}
    ${reworkForm(sample, slice)}
    ${archivedList(slice)}
    <div class="logs meta">${logs}</div>
  </div>`;
}

function sampleCard(sample) {
  const deliverBtn = sample.delivery === "已交付"
    ? ""
    : `<button data-deliver="${esc(sample.id)}" ${sample.deliverable ? "" : "disabled"}>标记交付</button>`;
  return `<article class="card">
    <div class="card-head">
      <h3>${esc(sample.project)}</h3>
      <span>
        <span class="pill status-${esc(sample.status)}">${esc(sample.status)}</span>
        <span class="pill">${esc(sample.delivery)}</span>
      </span>
    </div>
    <div class="meta">${esc(sample.id)} · ${esc(sample.borehole)} · ${esc(sample.coreBox)} · ${esc(sample.depth)} · 负责人 ${esc(sample.owner)}</div>
    ${statusBanner(sample)}
    <form data-form="add-slice" data-sample="${esc(sample.id)}">
      <h4>新增切片</h4>
      <div class="row">
        <div><label>切片编号</label><input name="id" required></div>
        <div><label>染色方法</label><input name="method" placeholder="未指定"></div>
      </div>
      <label>操作人（默认负责人）</label><input name="operator" placeholder="${esc(sample.owner)}">
      <button class="ghost">添加切片</button>
    </form>
    ${sample.slices.map(s => sliceCard(sample, s)).join("")}
    <div class="actions">${deliverBtn}</div>
    ${deliveryLedger(sample)}
  </article>`;
}

function render() {
  renderStats();
  samplesEl.innerHTML = samples.map(sampleCard).join("");
}

// ---------- 事件 ----------

async function run(action) {
  try {
    await action();
    await load();
  } catch (error) {
    alert(error.message);
  }
}

async function load() {
  samples = await api("/api/samples");
  render();
}

sampleForm.onsubmit = event => {
  event.preventDefault();
  run(async () => {
    await api("/api/samples", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(sampleForm).entries())),
    });
    sampleForm.reset();
  });
};

samplesEl.addEventListener("submit", event => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const { form: kind, sample, slice } = form.dataset;
  const data = Object.fromEntries(new FormData(form).entries());
  run(async () => {
    if (kind === "add-slice") {
      await api(`/api/samples/${encodeURIComponent(sample)}/slices`, { method: "POST", body: JSON.stringify(data) });
    } else if (kind === "step") {
      await api(`/api/samples/${encodeURIComponent(sample)}/slices/${encodeURIComponent(slice)}/logs`, { method: "POST", body: JSON.stringify(data) });
    } else if (kind === "review") {
      await api(`/api/samples/${encodeURIComponent(sample)}/slices/${encodeURIComponent(slice)}/reviews`, { method: "POST", body: JSON.stringify(data) });
    } else if (kind === "rework") {
      await api(`/api/samples/${encodeURIComponent(sample)}/slices/${encodeURIComponent(slice)}/rework`, { method: "POST", body: JSON.stringify(data) });
    }
  });
});

samplesEl.addEventListener("click", event => {
  const btn = event.target.closest("[data-deliver]");
  if (!btn) return;
  run(() => api(`/api/samples/${encodeURIComponent(btn.dataset.deliver)}/deliver`, {
    method: "POST",
    body: JSON.stringify({}),
  }));
});

document.querySelector("#reload").onclick = load;

(async () => {
  meta = await api("/api/meta");
  await load();
})();
