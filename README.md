# 岩芯样本切片实验室

运行：

```bash
npm start
```

访问 `http://localhost:3025`。支持样本创建、切片任务、步骤记录、复核、返工与交付统计。

## 流程规则

- 切片步骤：取样 → 切割 → 研磨 → 染色 → 观察。记录步骤必须填写操作人。
- **复核**：切片进入“观察”后可复核，需记录复核人、观察结论与通过/驳回；复核人不能与该切片最近操作人相同。
- **交付**：所有切片复核通过（样本状态变为“可交付”）后才可交付。
- **返工**：退回指定步骤重做，必须填写返工原因；已交付样本会先撤回交付（交付记录留档），旧观察结论与复核记录归档保留、不计入统计。
- 观察之后不允许直接回退步骤，必须走返工；已形成结论后重新“观察”会自动归档旧结论。

## 分层结构

- `lib/workflow.js` —— 流程判断：状态机、复核/交付/返工校验，纯函数无 IO。
- `lib/store.js` —— 数据写入：JSON 文件加载/保存、旧数据归一化。
- `server.js` —— HTTP 路由与静态文件，只做请求映射。
- `public/` —— 页面交互：`index.html` / `styles.css` / `app.js`。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/samples` | 样本列表（含派生状态） |
| POST | `/api/samples` | 创建样本 |
| POST | `/api/samples/:id/slices` | 新增切片 |
| POST | `/api/samples/:id/slices/:sid/logs` | 记录步骤（step/note/operator） |
| POST | `/api/samples/:id/slices/:sid/reviews` | 复核（reviewer/conclusion/result） |
| POST | `/api/samples/:id/slices/:sid/rework` | 返工（step/reason/operator） |
| POST | `/api/samples/:id/deliver` | 标记交付 |
