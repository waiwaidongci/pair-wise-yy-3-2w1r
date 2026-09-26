// 数据写入层：负责加载/保存数据与所有业务写入；流程是否合法由 flow.js 判断
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED,
  PRODUCTION_STEPS,
  REJECTED,
  computeSampleStatus,
  isApproved,
  isPendingReview,
  reviewIssue
} from "./flow.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "core-slices.json");

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        {
          id: "SL-001-A",
          method: "茜素红染色",
          observation: "",
          status: "研磨",
          logs: [
            { at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置", operator: "" },
            { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切", operator: "" }
          ]
        }
      ]
    }
  ]
};

export class FlowError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function now() { return new Date().toISOString(); }

// 兼容旧数据：补齐复核/返工/操作人字段
function normalizeSlice(slice) {
  if (!slice.logs) slice.logs = [];
  slice.logs.forEach(log => { if (!("operator" in log)) log.operator = ""; });
  if (!slice.reviews) slice.reviews = [];
  if (!slice.reworks) slice.reworks = [];
  if (slice.review && slice.review.conclusion === APPROVED && !slice.review.archivedAt) {
    // JSON 往返后 review 与 reviews 中的记录是两个对象，按 at/reviewer 重新指向同一引用
    const linked = slice.reviews.find(r =>
      r.conclusion === APPROVED && !r.archivedAt &&
      r.at === slice.review.at && r.reviewer === slice.review.reviewer
    );
    if (linked) {
      // 以较完整的一份为准并合并归档标记
      if (slice.review.archivedAt && !linked.archivedAt) linked.archivedAt = slice.review.archivedAt;
      slice.review = linked;
    } else {
      // reviews 中缺失（旧数据）：补挂到数组，保证留档完整
      slice.reviews.push(slice.review);
    }
  }
  if (!slice.review) {
    // 旧数据可能有复核记录但未标记当前结论，取最近一条未被返工归档的通过记录
    const latestApproved = [...slice.reviews].reverse().find(r => r.conclusion === APPROVED && !r.archivedAt);
    if (latestApproved) slice.review = latestApproved;
  }
  return slice;
}

function normalizeSample(sample) {
  if (!sample.deliveries) sample.deliveries = [];
  if (sample.delivery === "已交付" && !sample.deliveries.some(d => d.status === "已交付")) {
    sample.deliveries.push({ at: "", by: sample.owner || "", status: "已交付" });
  }
  sample.slices.forEach(normalizeSlice);
  return sample;
}

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.samples.forEach(normalizeSample);
  return db;
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

export function refreshSampleStatus(sample) {
  sample.status = computeSampleStatus(sample);
  return sample;
}

export function findSample(db, sampleId) {
  const sample = db.samples.find(item => item.id === sampleId);
  if (!sample) throw new FlowError("sample_not_found");
  return sample;
}

function findSlice(sample, sliceId) {
  const slice = sample.slices.find(item => item.id === sliceId);
  if (!slice) throw new FlowError("slice_not_found");
  return slice;
}

export function createSample(input) {
  const sample = {
    id: `CORE-${Date.now()}`,
    project: input.project,
    borehole: input.borehole,
    coreBox: input.coreBox,
    depth: input.depth,
    owner: input.owner,
    status: "待切割",
    delivery: "未交付",
    deliveries: [],
    slices: [
      {
        id: input.sliceId,
        method: input.method,
        observation: "",
        status: "取样",
        logs: [{ at: now(), step: "取样", note: "创建初始切片任务", operator: input.owner || "" }],
        reviews: [],
        reworks: []
      }
    ]
  };
  return refreshSampleStatus(sample);
}

export function addSlice(sample, input) {
  sample.slices.push({
    id: input.id,
    method: input.method || "未指定",
    observation: "",
    status: "取样",
    logs: [{ at: now(), step: "取样", note: "新增切片任务", operator: input.operator || sample.owner || "" }],
    reviews: [],
    reworks: []
  });
  return refreshSampleStatus(sample);
}

// 原有记录入口：记录制片步骤（含观察）。观察只是制片完成，不等于通过
export function logStep(sample, slice, input) {
  const step = input.step;
  const operator = (input.operator || "").trim();
  if (!operator) throw new FlowError("operator_required");
  if (isApproved(slice)) throw new FlowError("slice_already_approved");
  if (![...PRODUCTION_STEPS, "观察"].includes(step)) throw new FlowError("invalid_step");
  slice.status = step;
  if (step === "观察") {
    // 新一轮观察：清除上一轮被返工的当前复核标记（旧结论已留档在 reviews 中）
    slice.observation = input.note || slice.observation;
  }
  slice.logs.push({ at: now(), step, note: input.note || "", operator });
  return refreshSampleStatus(sample);
}

// 复核：记录复核人与观察结论；复核人不能与最近操作人相同
export function reviewSlice(sample, slice, input) {
  const reviewer = (input.reviewer || "").trim();
  const issue = reviewIssue(slice, reviewer);
  if (issue) throw new FlowError(issue);
  const conclusion = input.conclusion === REJECTED ? REJECTED : APPROVED;
  const record = {
    at: now(),
    reviewer,
    conclusion,
    observation: input.observation || slice.observation || "",
    note: input.note || ""
  };
  slice.reviews.push(record);
  if (conclusion === APPROVED) slice.review = record;
  else slice.review = null; // 退回/重审前不持有通过结论
  // 复核退回：给出返工原因，回到指定制片步骤重做
  if (conclusion === REJECTED) {
    startRework(sample, slice, { step: input.returnStep, reason: input.note || "复核退回", operator: reviewer });
  }
  return refreshSampleStatus(sample);
}

// 返工：内部复用。旧观察结论保留在 reviews/logs 中，不再作为当前结论
function startRework(sample, slice, input) {
  let step = input.step;
  if (!PRODUCTION_STEPS.includes(step)) step = "染色"; // 默认回到染色重做
  const at = now();
  // 当前通过结论随返工归档（留档但不再生效、不计入交付判定）
  const archivedReview = archiveCurrentReview(slice, at);
  const record = {
    at,
    from: "观察",
    to: step,
    reason: input.reason || "返工重做",
    operator: (input.operator || "").trim(),
    archivedReview
  };
  slice.reworks.push(record);
  slice.status = step;
  slice.review = null; // 当前通过结论失效；历史结论仍在 reviews 留档
  slice.observation = "";
  return record;
}

// 将切片当前的复核通过结论归档（留档但不再生效）
function archiveCurrentReview(slice, at) {
  if (slice.review) {
    if (!slice.review.archivedAt) slice.review.archivedAt = at;
    return slice.review;
  }
  // 兜底：找到最近一条未归档的通过结论并归档
  const latest = [...slice.reviews].reverse().find(r => r.conclusion === APPROVED && !r.archivedAt);
  if (latest) latest.archivedAt = at;
  return latest || null;
}

// 返工入口：未交付的待复核切片由复核退回；已交付样本先撤交付，所有切片回到指定步骤
export function rework(sample, input) {
  const operator = (input.operator || "").trim();
  if (!operator) throw new FlowError("operator_required");
  let step = input.step;
  if (!PRODUCTION_STEPS.includes(step)) throw new FlowError("invalid_step");
  const reason = (input.reason || "").trim() || "返工重做";

  if (sample.delivery === "已交付") {
    // 已交付返工：先撤交付，交付记录留档（状态改为已撤销），不计入当前交付统计
    sample.deliveries.forEach(d => { if (d.status === "已交付") d.status = "已撤销"; });
    sample.delivery = "未交付";
    const revokedAt = now();
    sample.slices.forEach(slice => {
      const archivedReview = archiveCurrentReview(slice, revokedAt);
      slice.reworks.push({
        at: revokedAt,
        from: "已交付",
        to: step,
        reason,
        operator,
        archivedReview,
        revokedDelivery: true
      });
      slice.status = step;
      slice.review = null;
      slice.observation = "";
    });
  } else {
    const targets = sample.slices.filter(isPendingReview);
    if (!targets.length) throw new FlowError("no_reworkable_slice");
    targets.forEach(slice => {
      const at = now();
      const archivedReview = archiveCurrentReview(slice, at);
      slice.reworks.push({ at, from: "观察", to: step, reason, operator, archivedReview });
      slice.status = step;
      slice.review = null;
      slice.observation = "";
    });
  }
  return refreshSampleStatus(sample);
}

// 交付：所有切片复核通过才允许
export function deliver(sample, input) {
  if (!sample.slices.length || !sample.slices.every(isApproved)) {
    throw new FlowError("review_required_before_delivery");
  }
  if (sample.delivery === "已交付") throw new FlowError("already_delivered");
  sample.delivery = "已交付";
  sample.deliveries.push({ at: now(), by: (input.operator || "").trim() || sample.owner || "", status: "已交付" });
  return refreshSampleStatus(sample);
}
