// 流程判断层：纯函数，不读写文件、不修改数据
// 制片步骤：取样 -> 切割 -> 研磨 -> 染色 -> 观察，观察后进入复核，复核通过才可交付

export const STATUSES = ["待切割", "制片中", "待复核", "可交付", "已交付"];
export const STEPS = ["取样", "切割", "研磨", "染色", "观察"];
export const PRODUCTION_STEPS = ["取样", "切割", "研磨", "染色"];
export const APPROVED = "通过";
export const REJECTED = "退回";

// 最近一次步骤记录的操作人（复核人不得与之相同）
export function lastOperator(slice) {
  const last = slice.logs && slice.logs[slice.logs.length - 1];
  return (last && last.operator) || "";
}

// 切片当前是否持有有效的复核通过结论（被返工归档后视为未通过）
export function isApproved(slice) {
  return Boolean(slice.review && slice.review.conclusion === APPROVED);
}

// 已完成观察、等待复核
export function isPendingReview(slice) {
  return slice.status === "观察" && !isApproved(slice);
}

// 供卡片展示的切片状态
export function reviewState(slice) {
  if (isApproved(slice)) return "复核通过";
  if (isPendingReview(slice)) return "待复核";
  return slice.status;
}

// 复核前置校验，返回错误码，null 表示可以复核
export function reviewIssue(slice, reviewer) {
  const name = (reviewer || "").trim();
  if (!name) return "reviewer_required";
  if (!isPendingReview(slice)) return "review_not_pending";
  const operator = lastOperator(slice);
  if (operator && name === operator) return "reviewer_matches_operator";
  return null;
}

// 最近一次返工；切片重新复核通过后返工即不再是活动状态
export function activeRework(slice) {
  if (!slice.reworks || !slice.reworks.length) return null;
  if (isApproved(slice)) return null;
  return slice.reworks[slice.reworks.length - 1];
}

// 所有切片复核通过、且尚未交付，样本才可交付
export function canDeliver(sample) {
  return (
    sample.delivery !== "已交付" &&
    sample.slices.length > 0 &&
    sample.slices.every(isApproved)
  );
}

// 样本整体状态推导
export function computeSampleStatus(sample) {
  if (sample.delivery === "已交付") return "已交付";
  if (sample.slices.length === 0) return "待切割";
  if (sample.slices.some(slice => PRODUCTION_STEPS.includes(slice.status))) return "制片中";
  // 其余切片均已走到“观察”
  if (sample.slices.every(isApproved)) return "可交付";
  return "待复核";
}

// 给持久化数据附加展示用派生字段（不改变原数据）
export function decorateSample(sample) {
  const slices = sample.slices.map(slice => ({
    ...slice,
    reviewState: reviewState(slice),
    lastOperator: lastOperator(slice),
    reworkReason: activeRework(slice)
  }));
  return {
    ...sample,
    status: computeSampleStatus(sample),
    slices,
    pendingReview: slices.some(isPendingReview),
    reworking: slices.some(slice => activeRework(slice)),
    deliverable: canDeliver({ ...sample, slices })
  };
}
