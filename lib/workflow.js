// 岩芯切片实验室 —— 流程判断层
// 纯函数：只负责状态机规则与流程校验，不读写文件、不处理 HTTP。

export const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];
export const sampleStatuses = ["待切割", "制片中", "待复核", "可交付", "已交付"];
export const reviewResults = ["通过", "驳回"];
export const DELIVERED = "已交付";
export const NOT_DELIVERED = "未交付";

export function ts() {
  return new Date().toISOString();
}

const errorMessages = {
  field_required: "请完整填写必填信息",
  duplicate_slice: "切片编号已存在",
  bad_step: "指定的制片步骤无效",
  operator_required: "请填写操作人",
  not_observed: "切片尚未完成“观察”步骤，不能复核",
  reviewer_required: "请填写复核人",
  reviewer_matches_operator: "复核人不能与最近操作人相同",
  conclusion_required: "请填写观察结论",
  bad_result: "复核结果只能是“通过”或“驳回”",
  reason_required: "请填写返工原因",
  use_rework: "观察之后退回步骤必须走“返工”，以便撤回交付并归档旧结论",
  delivered_use_rework: "样本已交付，修改流程必须先走返工（会先撤回交付）",
  already_delivered: "样本已经是交付状态",
  no_slice: "样本还没有切片，不能交付",
  review_incomplete: "所有切片复核通过后才可交付",
  sample_not_found: "样本不存在",
  slice_not_found: "切片不存在",
};
export function errorMessage(code) {
  return errorMessages[code] || "操作失败";
}

// ---------- 派生状态（流程判断） ----------

export function latestLog(slice) {
  return slice.logs.length ? slice.logs[slice.logs.length - 1] : null;
}
export function latestOperator(slice) {
  return latestLog(slice)?.operator || "";
}
export function latestReview(slice) {
  return slice.reviews.length ? slice.reviews[slice.reviews.length - 1] : null;
}

// 切片状态：制片中 / 待复核 / 复核驳回 / 复核通过
export function sliceState(slice) {
  if (slice.status !== "观察") return "制片中";
  const review = latestReview(slice);
  if (!review) return "待复核";
  return review.result === "通过" ? "复核通过" : "复核驳回";
}
export function isSliceApproved(slice) {
  return sliceState(slice) === "复核通过";
}

// 复核校验：必须已观察，且复核人不能与最近操作人相同
export function reviewCheck(slice, reviewerRaw) {
  if (slice.status !== "观察") return { ok: false, code: "not_observed" };
  const reviewer = String(reviewerRaw ?? "").trim();
  if (!reviewer) return { ok: false, code: "reviewer_required" };
  const operator = latestOperator(slice);
  if (operator && reviewer === operator) {
    return { ok: false, code: "reviewer_matches_operator" };
  }
  return { ok: true, reviewer };
}

// 交付判断：未交付、有切片、且所有切片复核通过
export function deliveryCheck(sample) {
  if (sample.delivery === DELIVERED) return { ok: false, code: "already_delivered" };
  if (!sample.slices.length) return { ok: false, code: "no_slice" };
  const blocking = sample.slices.filter(s => !isSliceApproved(s)).map(s => s.id);
  if (blocking.length) return { ok: false, code: "review_incomplete", blocking };
  return { ok: true };
}

// 样本状态机：待切割 / 制片中 / 待复核 / 可交付 / 已交付
export function deriveSampleStatus(sample) {
  if (sample.delivery === DELIVERED) return "已交付";
  if (!sample.slices.length) return "待切割";
  if (sample.slices.some(s => s.status !== "观察")) return "制片中";
  return sample.slices.every(isSliceApproved) ? "可交付" : "待复核";
}

// 给页面用的只读视图：附带派生字段，不落库
export function describeSample(sample) {
  const check = deliveryCheck(sample);
  return {
    ...sample,
    status: deriveSampleStatus(sample),
    deliverable: check.ok,
    pendingSlices: check.ok ? [] : check.blocking || [],
    slices: sample.slices.map(s => ({
      ...s,
      state: sliceState(s),
      latestOperator: latestOperator(s),
    })),
  };
}

// ---------- 实体工厂 ----------

export function createSlice(input, at = ts()) {
  return {
    id: String(input.id ?? "").trim(),
    method: String(input.method ?? "").trim() || "未指定",
    observation: "",
    status: "取样",
    reviews: [], // 当前观察周期的复核记录
    archived: [], // 返工/重新观察归档的旧结论（留档，不计入统计）
    logs: [
      {
        at,
        step: "取样",
        note: input.note || "新增切片任务",
        operator: String(input.operator ?? "").trim(),
      },
    ],
  };
}

export function createSample(input, id, at = ts()) {
  const required = ["project", "borehole", "coreBox", "depth", "owner", "sliceId"];
  for (const field of required) {
    if (!String(input[field] ?? "").trim()) return { ok: false, code: "field_required" };
  }
  const sample = {
    id,
    project: input.project.trim(),
    borehole: input.borehole.trim(),
    coreBox: input.coreBox.trim(),
    depth: input.depth.trim(),
    owner: input.owner.trim(),
    status: "待切割",
    delivery: NOT_DELIVERED,
    deliveredAt: null,
    deliveryHistory: [], // 交付/撤交付流水；撤交付的旧记录留档但不计入统计
    slices: [
      createSlice(
        { id: input.sliceId, method: input.method, operator: input.owner, note: "创建初始切片任务" },
        at
      ),
    ],
  };
  sample.status = deriveSampleStatus(sample);
  return { ok: true, sample };
}

// ---------- 状态变更（只改传入的实体，不做 IO） ----------

// 记录步骤（原有入口）：观察之后想回退必须走返工
export function recordStep(sample, slice, input, at = ts()) {
  if (sample.delivery === DELIVERED) return { ok: false, code: "delivered_use_rework" };
  const step = String(input.step ?? "").trim();
  if (!taskSteps.includes(step)) return { ok: false, code: "bad_step" };
  const operator = String(input.operator ?? "").trim();
  if (!operator) return { ok: false, code: "operator_required" };
  const note = String(input.note ?? "").trim() || "步骤完成";

  if (slice.status === "观察" && step !== "观察" && (slice.observation || slice.reviews.length)) {
    return { ok: false, code: "use_rework" };
  }
  // 已形成观察结论后再次记录“观察”：旧结论先归档，再重新进入待复核
  if (step === "观察" && slice.status === "观察" && (slice.observation || slice.reviews.length)) {
    slice.archived.push({
      type: "重新观察",
      at,
      operator,
      toStep: "观察",
      reason: "观察步骤重新记录",
      observation: slice.observation,
      reviews: slice.reviews,
    });
  }

  slice.logs.push({ at, step, note, operator });
  slice.status = step;
  if (step === "观察") {
    slice.observation = note;
    slice.reviews = [];
  }
  return { ok: true };
}

// 复核：记录复核人、观察结论、通过/驳回
export function reviewSlice(sample, slice, input, at = ts()) {
  if (sample.delivery === DELIVERED) return { ok: false, code: "delivered_use_rework" };
  const check = reviewCheck(slice, input.reviewer);
  if (!check.ok) return { ok: false, code: check.code };
  const conclusion = String(input.conclusion ?? "").trim();
  if (!conclusion) return { ok: false, code: "conclusion_required" };
  const result = String(input.result ?? "").trim();
  if (!reviewResults.includes(result)) return { ok: false, code: "bad_result" };

  slice.reviews.push({ at, reviewer: check.reviewer, conclusion, result });
  return { ok: true };
}

// 返工：已交付先撤交付并留档，再退回指定步骤；旧观察结论/复核记录归档不计入统计
export function reworkSlice(sample, slice, input, at = ts()) {
  const step = String(input.step ?? "").trim();
  if (!taskSteps.includes(step)) return { ok: false, code: "bad_step" };
  const reason = String(input.reason ?? "").trim();
  if (!reason) return { ok: false, code: "reason_required" };
  const operator = String(input.operator ?? "").trim();
  if (!operator) return { ok: false, code: "operator_required" };

  // 1) 已交付：先撤交付，交付记录留档
  let withdrewDelivery = false;
  if (sample.delivery === DELIVERED) {
    sample.deliveryHistory.push({
      type: "撤交付",
      at,
      reason,
      operator,
      deliveredAt: sample.deliveredAt,
    });
    sample.delivery = NOT_DELIVERED;
    sample.deliveredAt = null;
    withdrewDelivery = true;
  }

  // 2) 旧观察结论与复核记录归档（保留内容，不计入当前统计）
  slice.archived.push({
    type: "返工",
    at,
    operator,
    toStep: step,
    reason,
    observation: slice.observation,
    reviews: slice.reviews,
  });

  // 3) 退回指定步骤重做
  slice.observation = "";
  slice.reviews = [];
  slice.status = step;
  slice.logs.push({ at, step, note: `返工退回${step}：${reason}`, operator, kind: "返工" });

  return { ok: true, withdrewDelivery };
}

// 交付：所有切片复核通过才允许
export function deliverSample(sample, at = ts()) {
  const check = deliveryCheck(sample);
  if (!check.ok) return { ok: false, code: check.code };
  sample.delivery = DELIVERED;
  sample.deliveredAt = at;
  sample.deliveryHistory.push({ type: "交付", at });
  return { ok: true };
}

// ---------- 旧数据归一化 ----------

export function normalizeSample(sample) {
  let dirty = false;
  if (!Array.isArray(sample.slices)) {
    sample.slices = [];
    dirty = true;
  }
  if (!Array.isArray(sample.deliveryHistory)) {
    sample.deliveryHistory = [];
    dirty = true;
  }
  if (!sample.delivery) {
    sample.delivery = NOT_DELIVERED;
    dirty = true;
  }
  if (!("deliveredAt" in sample)) {
    sample.deliveredAt = null;
    dirty = true;
  }
  for (const slice of sample.slices) {
    if (!Array.isArray(slice.reviews)) {
      slice.reviews = [];
      dirty = true;
    }
    if (!Array.isArray(slice.archived)) {
      slice.archived = [];
      dirty = true;
    }
    if (!Array.isArray(slice.logs)) {
      slice.logs = [];
      dirty = true;
    }
    if (slice.observation == null) {
      slice.observation = "";
      dirty = true;
    }
  }
  const derived = deriveSampleStatus(sample);
  if (sample.status !== derived) {
    sample.status = derived;
    dirty = true;
  }
  return dirty;
}
