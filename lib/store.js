// 岩芯切片实验室 —— 数据写入层
// 负责加载/保存 JSON 数据文件；所有流程规则都来自 lib/workflow.js。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSample,
  createSlice,
  deliverSample,
  deriveSampleStatus,
  describeSample,
  normalizeSample,
  recordStep,
  reviewSlice,
  reworkSlice,
  ts,
} from "./workflow.js";

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
      deliveredAt: null,
      deliveryHistory: [],
      slices: [
        {
          id: "SL-001-A",
          method: "茜素红染色",
          observation: "",
          status: "研磨",
          reviews: [],
          archived: [],
          logs: [
            { at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置", operator: "陆川" },
            { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切", operator: "陆川" },
          ],
        },
      ],
    },
  ],
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (!Array.isArray(db.samples)) db.samples = [];
  // 旧数据归一化：补齐新字段、按新状态机重算状态
  let dirty = false;
  for (const sample of db.samples) {
    if (normalizeSample(sample)) dirty = true;
  }
  if (dirty) await saveDb(db);
  return db;
}

async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

// 读取：返回带派生字段的视图
export async function listSamples() {
  const db = await loadDb();
  return db.samples.map(describeSample);
}

// 通用入口：定位样本 → 执行业务函数 → 重算状态 → 落库 → 返回视图
async function mutateSample(sampleId, action) {
  const db = await loadDb();
  const sample = db.samples.find(item => item.id === sampleId);
  if (!sample) return { ok: false, code: "sample_not_found" };
  const result = action(sample);
  if (!result.ok) return result;
  sample.status = deriveSampleStatus(sample);
  await saveDb(db);
  return { ok: true, sample: describeSample(sample), extra: result };
}

function findSlice(sample, sliceId) {
  return sample.slices.find(item => item.id === sliceId);
}

export async function addSample(input) {
  const db = await loadDb();
  const created = createSample(input, `CORE-${Date.now()}`);
  if (!created.ok) return created;
  db.samples.unshift(created.sample);
  await saveDb(db);
  return { ok: true, sample: describeSample(created.sample) };
}

export async function addSlice(sampleId, input) {
  return mutateSample(sampleId, sample => {
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, code: "field_required" };
    if (findSlice(sample, id)) return { ok: false, code: "duplicate_slice" };
    const slice = createSlice({
      id,
      method: input.method,
      operator: String(input.operator ?? "").trim() || sample.owner,
      note: "新增切片任务",
    });
    sample.slices.push(slice);
    return { ok: true };
  });
}

export async function logStep(sampleId, sliceId, input) {
  return mutateSample(sampleId, sample => {
    const slice = findSlice(sample, sliceId);
    if (!slice) return { ok: false, code: "slice_not_found" };
    return recordStep(sample, slice, input, ts());
  });
}

export async function review(sampleId, sliceId, input) {
  return mutateSample(sampleId, sample => {
    const slice = findSlice(sample, sliceId);
    if (!slice) return { ok: false, code: "slice_not_found" };
    return reviewSlice(sample, slice, input, ts());
  });
}

export async function rework(sampleId, sliceId, input) {
  return mutateSample(sampleId, sample => {
    const slice = findSlice(sample, sliceId);
    if (!slice) return { ok: false, code: "slice_not_found" };
    return reworkSlice(sample, slice, input, ts());
  });
}

export async function deliver(sampleId) {
  return mutateSample(sampleId, sample => deliverSample(sample, ts()));
}
