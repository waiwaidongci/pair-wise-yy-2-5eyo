import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fails.push(name); console.log("  ✗", name, extra ?? ""); }
}
async function j(path, opts = {}) {
  const res = await fetch(BASE + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const data = await res.json();
  return { status: res.status, data };
}
const post = (path, body, headers) => j(path, { method: "POST", body: JSON.stringify(body), headers });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), "pigeon-test-"));
// 旧格式库（无复核版本字段），验证启动迁移
const oldDb = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ]
};
const { mkdir, writeFile } = await import("node:fs/promises");
await mkdir(join(dir), { recursive: true });
await writeFile(join(dir, "pigeons.json"), JSON.stringify(oldDb));

const srv = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, DATA_DIR: dir, PORT: String(PORT) },
  cwd: new URL("..", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
srv.stdout.on("data", d => (logs += d));
srv.stderr.on("data", d => (logs += d));

for (let i = 0; i < 50; i++) {
  try { await fetch(BASE + "/api/pigeons"); break; } catch { await sleep(100); }
}

try {
  console.log("1) 旧档案迁移：回填初版，疫苗/转让/成绩照旧");
  let { data: pigeons } = await j("/api/pigeons");
  const p001 = pigeons.find(p => p.ringNo === "CHN-2026-001");
  ok("reviewVersion 回填 v1", p001.reviewVersion === "v1");
  ok("血统完整标记为 true", p001.pedigreeComplete === true);
  ok("疫苗保留", p001.vaccines.length === 1 && p001.vaccines[0].name === "新城疫");
  ok("转让保留", p001.transfers.length === 1);
  ok("成绩保留", p001.races.length === 1 && p001.races[0].rank === 18);
  let rv = (await j("/api/review")).data;
  ok("初版凭据回填（backfill-v1）", rv.credentials.some(c => c.ringNo === "CHN-2026-001" && c.issuedBy === "backfill-v1" && c.status === "valid"));

  console.log("2) 建母鸽 777 与子代 002（父 001 / 母 512）");
  await post("/api/pigeons", { ringNo: "CHN-2024-777", owner: "育种棚", fatherRing: "", motherRing: "", color: "绛", loft: "种鸽棚" });
  await post("/api/pigeons", { ringNo: "CHN-2026-002", owner: "北岸棚", fatherRing: "CHN-2026-001", motherRing: "CHN-2023-512", color: "灰白条", loft: "北岸A棚" });
  rv = (await j("/api/review")).data;
  ok("子代 002 建档即发完整凭据", rv.credentials.some(c => c.ringNo === "CHN-2026-002" && c.status === "valid"));

  console.log("3) 复核批次 F-0001：报告归采集时鸽主（采集 04-10 早于 04-15 转让）");
  let r = await post("/api/review/batches", { batchId: "B1", reports: [{ sampleNo: "F-0001", ringNo: "CHN-2026-001", collectedAt: "2026-04-10T08:00:00Z", fatherRing: "CHN-2022-188", motherRing: "CHN-2024-777" }] });
  ok("批次受理", r.status === 200 && r.data.reports[0].outcome === "new");
  ok("采集时鸽主=育种棚（非现鸽主北岸棚）", r.data.reports[0].ownerAtCollection === "育种棚");
  let rel = (await j("/api/pigeons/CHN-2026-001/relation")).data;
  ok("待确认期间档案锁定", rel.lock.locked === true && rel.lock.reason === "pending_report");

  console.log("4) 锁定期不能改档案，但成绩/疫苗可记");
  r = await j("/api/pigeons/CHN-2026-001", { method: "PATCH", body: JSON.stringify({ color: "白" }), headers: { "Content-Type": "application/json" } });
  ok("PATCH 档案返回 423", r.status === 423);
  r = await post("/api/pigeons/CHN-2026-001/races", { event: "300公里", distance: 300, rank: 5 });
  ok("锁定期成绩可记", r.status === 200 && r.data.races.length === 2);

  console.log("5) 同样本重传：相同沿用首传，变化留冲突且不动血统");
  await post("/api/review/batches", { reports: [{ sampleNo: "F-0001", ringNo: "CHN-2026-001", collectedAt: "2026-04-10T08:00:00Z", fatherRing: "CHN-2022-188", motherRing: "CHN-2024-777" }] });
  await post("/api/review/batches", { reports: [{ sampleNo: "F-0001", ringNo: "CHN-2026-001", collectedAt: "2026-04-10T08:00:00Z", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512" }] });
  rv = (await j("/api/review")).data;
  const rep1 = rv.reports.find(x => x.sampleNo === "F-0001");
  ok("状态 conflict，传输 3 次、冲突 1 条", rep1.status === "conflict" && rep1.transmissions.length === 3 && rep1.conflicts.length === 1);
  ok("首传结果不变（母 777）", rep1.firstResult.motherRing === "CHN-2024-777");
  pigeons = (await j("/api/pigeons")).data;
  ok("现有血统未被覆盖（仍登记 512）", pigeons.find(p => p.ringNo === "CHN-2026-001").motherRing === "CHN-2023-512");

  console.log("6) 两名登记员同时确认 F-0002：先到生效，后到留待复核");
  await post("/api/review/batches", { reports: [{ sampleNo: "F-0002", ringNo: "CHN-2026-001", collectedAt: "2026-04-10T08:00:00Z", fatherRing: "CHN-2022-188", motherRing: "CHN-2024-777" }] });
  const [c1, c2] = await Promise.all([
    post("/api/review/confirmations", { sampleNo: "F-0002", registrar: "登记员甲" }),
    post("/api/review/confirmations", { sampleNo: "F-0002", registrar: "登记员乙" })
  ]);
  ok("两次请求均 200", c1.status === 200 && c2.status === 200);
  rv = (await j("/api/review")).data;
  const f2conf = rv.confirmations.filter(c => c.sampleNo === "F-0002");
  ok("恰好一条 applied / 一条 held", f2conf.filter(c => c.status === "applied").length === 1 && f2conf.filter(c => c.status === "held").length === 1);
  ok("后到原因 later_registrar", f2conf.find(c => c.status === "held").heldReason === "later_registrar");
  ok("先到者登记员甲生效", f2conf.find(c => c.status === "applied").registrar === "登记员甲");
  pigeons = (await j("/api/pigeons")).data;
  const now001 = pigeons.find(p => p.ringNo === "CHN-2026-001");
  ok("母鸽更新为 777，版本升到 v2", now001.motherRing === "CHN-2024-777" && now001.reviewVersion === "v2");

  console.log("7) 父母一变，本鸽与后代旧凭据立即作废、按样本号重发");
  const void001 = rv.credentials.filter(c => c.ringNo === "CHN-2026-001" && c.status === "void" && c.voidReason === "parent_changed:F-0002");
  const void002 = rv.credentials.filter(c => c.ringNo === "CHN-2026-002" && c.status === "void" && c.voidReason === "parent_changed:F-0002");
  ok("本鸽旧凭据作废", void001.length === 1);
  ok("后代 002 旧凭据连带作废", void002.length === 1);
  ok("本鸽新凭据来源=样本号 F-0002", rv.credentials.some(c => c.ringNo === "CHN-2026-001" && c.status === "valid" && c.issuedBy === "F-0002"));
  ok("后代 002 新凭据重发且血统完整", rv.credentials.some(c => c.ringNo === "CHN-2026-002" && c.status === "valid" && c.issuedBy === "F-0002") && pigeons.find(p => p.ringNo === "CHN-2026-002").pedigreeComplete === true);

  console.log("8) 采集后转棚：接手鸽主可见结果，重确认前锁定档案");
  await post("/api/pigeons/CHN-2026-001/transfers", { to: "东港棚", date: "2026-09-01" });
  rel = (await j("/api/pigeons/CHN-2026-001/relation")).data;
  ok("现鸽主=东港棚，仍能看到报告与凭据", rel.pigeon.owner === "东港棚" && rel.reports.length === 2 && rel.credentials.length >= 2);
  ok("锁因=新鸽主需重确认", rel.lock.locked === true && rel.lock.reason === "owner_reconfirm_required");
  await post("/api/pigeons/CHN-2026-001/vaccines", { date: "2026-09-05", name: "巴拉米哥" });
  r = await j("/api/pigeons/CHN-2026-001", { method: "PATCH", body: JSON.stringify({ color: "白" }), headers: { "Content-Type": "application/json" } });
  ok("重确认前 PATCH 仍 423；疫苗可记", r.status === 423 && (await j("/api/pigeons")).data.find(p => p.ringNo === "CHN-2026-001").vaccines.length === 2);
  r = await post("/api/review/confirmations", { sampleNo: "F-0002", registrar: "接手棚登记员" });
  ok("新鸽主重确认 applied（reconfirmation）", r.data.outcome === "applied" && r.data.role === "reconfirmation");
  rel = (await j("/api/pigeons/CHN-2026-001/relation")).data;
  ok("重确认后档案解锁", rel.lock.locked === false);
  r = await j("/api/pigeons/CHN-2026-001", { method: "PATCH", body: JSON.stringify({ color: "雨点" }), headers: { "Content-Type": "application/json" } });
  ok("解锁后可改档案", r.status === 200 && r.data.color === "雨点");
  r = await post("/api/review/confirmations", { sampleNo: "F-0002", registrar: "乱改者", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512" });
  ok("迟到且内容不一致 → 留待复核", r.data.outcome === "held_for_review" && r.data.reason === "later_registrar_content_mismatch");

  console.log("9) 写盘失败：整批落本地，按原样本号恢复，重放不重复发证");
  const before = (await j("/api/review")).data;
  const beforeCreds = before.credentials.length;
  r = await post("/api/review/batches",
    { batchId: "B-FAIL", reports: [{ sampleNo: "F-0003", ringNo: "CHN-2026-001", collectedAt: "2026-04-10T08:00:00Z", fatherRing: "CHN-2022-188", motherRing: "CHN-2024-777" }], confirmations: [{ sampleNo: "F-0003", registrar: "钱七" }] },
    { "x-simulate-write-fail": "1" });
  ok("返回 spooled + 本地文件", r.data.spooled === true);
  const spoolFiles = await readdir(join(dir, "spool"));
  ok("spool 目录有 B-FAIL 文件", spoolFiles.some(f => f.includes("B-FAIL")));
  let mid = (await j("/api/review")).data;
  ok("失败批次未落库（无 F-0003 报告）", !mid.reports.some(x => x.sampleNo === "F-0003") && mid.credentials.length === beforeCreds);
  r = await post("/api/review/recover", {});
  ok("恢复成功并删除 spool", r.data.recovered.length === 1 && r.data.recovered[0].recovered === true);
  rv = (await j("/api/review")).data;
  ok("F-0003 已入库且凭据只发一次", rv.reports.some(x => x.sampleNo === "F-0003") && rv.credentials.filter(c => c.issuedBy === "F-0003").length === 2); // 001 与后代 002
  const credCountAfterRecover = rv.credentials.length;
  r = await post("/api/review/recover", {});
  ok("再次恢复为空操作", r.data.recovered.length === 0);
  rv = (await j("/api/review")).data;
  ok("重放不重复生成凭据/确认", rv.credentials.length === credCountAfterRecover && rv.confirmations.filter(c => c.sampleNo === "F-0003" && c.registrar === "钱七").length === 1);
} catch (e) {
  fails.push("exception: " + e.message);
  console.error(e);
} finally {
  srv.kill();
}

console.log(`\n${pass} 通过，${fails.length} 失败`);
if (fails.length) { console.log(fails.join("\n")); console.log("\n--- server log ---\n" + logs); process.exit(1); }
