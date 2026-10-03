# 赛鸽血统环号登记站

运行：

```bash
npm start
```

访问 `http://localhost:3024`。支持档案、血统查询、转让、疫苗和归巢成绩记录，以及亲权复核批次。

## 亲权复核批次规则

- 实验室报告走 `POST /api/review/batches`，每条报告带 `sampleNo`（样本号）、`ringNo`、`collectedAt`（采集时点）、`fatherRing`、`motherRing`。
- **鸽主归属**：报告按转让时间链回溯，归"采集时鸽主"（`ownerAtCollection`）；采集后转棚，接手鸽主能看到报告与凭据。
- **同样本重传**：内容（环号+采集时点+父母环号）哈希一致 → 沿用首次结果（只追加传输记录）；内容变了 → 报告置 `conflict` 留冲突明细，绝不覆盖现有血统。
- **档案锁**：有有效待确认报告（`pending_report`），或确认后鸽主已换人（`owner_reconfirm_required`）时，`PATCH /api/pigeons/:ringNo` 返回 423；转让、疫苗、成绩在锁定期照常可记。新鸽主用同一样本号"重确认"后解锁；重确认内容与已生效结果不一致则 `held_for_review`。
- **并发确认**：非 GET 请求全局 FIFO 串行。同一样本首轮两名登记员确认，先到者 `applied`（父母变更、版本递增），后到者记 `held`（`later_registrar` / `later_registrar_content_mismatch`）留待复核。
- **父母变更级联**：父或母一变，本鸽及全部子代的 `pedigreeComplete` 立即重算，有效参赛凭据批量作废（`void` + `parent_changed:<样本号>`），再按复核版本重发；凭据以样本号为幂等键。
- **写盘失败**：整批写入 `data/spool/` 本地批次文件并回滚内存；`POST /api/review/recover` 按原样本号恢复，报告、确认、凭据三层幂等，重放不重复发证。
- **旧档案迁移**：启动时无 `reviewVersion` 的档案回填 `v1`（初版），血统完整的补发 `backfill-v1` 初版凭据；疫苗、转让、成绩原样保留。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/pigeons` / `POST` | 档案列表 / 建档（自动 v1） |
| GET | `/api/pigeons/:ringNo/relation` | 血统（父母/子代/报告/确认/凭据/锁状态） |
| PATCH | `/api/pigeons/:ringNo` | 改档案（锁定时 423；改父母触发级联重算） |
| POST | `/api/pigeons/:ringNo/{transfers,races,vaccines}` | 转让/成绩/疫苗（锁定期可用） |
| POST | `/api/review/batches` | 提交报告批次（头 `x-simulate-write-fail: 1` 可演练落本地） |
| POST | `/api/review/confirmations` | 登记员确认/重确认（`sampleNo`、`registrar`，可带父母环号） |
| POST | `/api/review/recover` | 恢复本地批次 |
| GET | `/api/review` | 报告、确认、凭据、批次与 spool 总览 |

## 测试

```bash
node test/review.test.mjs
```

端到端覆盖：旧档案迁移、采集时鸽主回溯、重传沿用/冲突留存、档案锁与转棚重确认、并发首到生效、父母变更级联凭据作废重发、写盘失败 spool 恢复与重放幂等。
