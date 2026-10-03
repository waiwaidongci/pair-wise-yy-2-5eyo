import http from "node:http";
import { mkdir, readFile, writeFile, rename, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(__dirname, "data");
const dbPath = join(dataDir, "pigeons.json");
const spoolDir = join(dataDir, "spool");
const port = Number(process.env.PORT || 3024);
const forceFailWrites = process.env.FAIL_WRITES === "1";

const sha1 = text => createHash("sha1").update(text).digest("hex");
const nowIso = () => new Date().toISOString();
const contentHash = r => sha1([r.ringNo, r.collectedAt, r.fatherRing || "", r.motherRing || ""].join("|"));
const parentTuple = p => `${p.fatherRing || ""}|${p.motherRing || ""}`;

const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ]
};

// ---------- 血统工具 ----------
function isComplete(db, p) {
  return Boolean(p.fatherRing && p.motherRing
    && db.pigeons.some(x => x.ringNo === p.fatherRing)
    && db.pigeons.some(x => x.ringNo === p.motherRing));
}
function descendantRings(db, root) {
  const set = new Set([root]);
  let frontier = [root];
  while (frontier.length) {
    const next = [];
    for (const r of frontier) {
      for (const p of db.pigeons) {
        if (!set.has(p.ringNo) && (p.fatherRing === r || p.motherRing === r)) {
          set.add(p.ringNo);
          next.push(p.ringNo);
        }
      }
    }
    frontier = next;
  }
  return set;
}
// 按转让时间链回溯：某一时点这只鸽归谁
function ownerAt(pigeon, when) {
  const tx = [...pigeon.transfers].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!tx.length) return pigeon.owner;
  const t = Date.parse(when);
  let owner = tx[0].from;
  for (const x of tx) {
    const at = Date.parse(x.date);
    const hit = Number.isNaN(t) || Number.isNaN(at) ? String(when) >= String(x.date) : at <= t;
    if (hit) owner = x.to; else break;
  }
  return owner;
}
// 父/母一变：本鸽及全部后代的完整标记与参赛凭据立即失效重算（source 通常为样本号，做凭据幂等键）
function recomputeLineage(db, root, { source, parentChanged, at }) {
  const rings = descendantRings(db, root);
  if (parentChanged) {
    for (const ring of rings) {
      for (const c of db.credentials) {
        if (c.ringNo === ring && c.status === "valid") {
          c.status = "void";
          c.voidedAt = at;
          c.voidReason = `parent_changed:${source}`;
        }
      }
    }
  }
  for (const ring of rings) {
    const p = db.pigeons.find(x => x.ringNo === ring);
    p.pedigreeComplete = isComplete(db, p);
    if (p.pedigreeComplete && !db.credentials.some(c => c.ringNo === ring && c.issuedBy === source)) {
      db.credentials.push({
        code: `CRL-${ring.replace(/[^A-Za-z0-9]/g, "")}-${sha1(source + ring).slice(0, 8)}`,
        ringNo: ring, fatherRing: p.fatherRing, motherRing: p.motherRing,
        reviewVersion: p.reviewVersion, issuedBy: source, issuedAt: at, status: "valid"
      });
    }
  }
}
function nextVersion(db, ring) {
  let max = 1;
  for (const p of db.pigeons) if (p.ringNo === ring) {
    const m = /^v(\d+)/.exec(p.reviewVersion || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `v${max + 1}`;
}
function lockInfo(db, p) {
  const reports = db.reports.filter(r => r.ringNo === p.ringNo);
  // 冲突报告只留复核台、不覆盖血统；档案锁只针对待确认的有效报告
  const pending = reports.find(r => r.status !== "conflict" && !db.confirmations.some(c => c.sampleNo === r.sampleNo && c.status === "applied"));
  if (pending) return { locked: true, reason: "pending_report", sampleNo: pending.sampleNo, message: "羽毛样本报告待确认，档案锁定" };
  const applied = db.confirmations.filter(c => c.ringNo === p.ringNo && c.status === "applied").pop();
  if (applied && applied.ownerContext !== p.owner) {
    return { locked: true, reason: "owner_reconfirm_required", sampleNo: applied.sampleNo, message: `现鸽主（${p.owner}）与确认时鸽主（${applied.ownerContext}）不同，须重确认后才能改档案` };
  }
  return { locked: false };
}

// ---------- 存储与迁移 ----------
let dbCache = null;
async function readDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function loadDb() {
  if (dbCache) return dbCache;
  let db = await readDb();
  if (!db.schemaVersion) {
    // 旧档案迁移：回填复核初版，疫苗/转让/成绩原样保留
    db.reports = [];
    db.confirmations = [];
    db.credentials = [];
    db.batches = [];
    const at = nowIso();
    for (const p of db.pigeons) {
      p.reviewVersion = "v1";
      p.reviewedAt = null;
      p.pedigreeComplete = isComplete(db, p);
      if (p.pedigreeComplete) {
        db.credentials.push({
          code: `CRL-${p.ringNo.replace(/[^A-Za-z0-9]/g, "")}-BACKFILL`,
          ringNo: p.ringNo, fatherRing: p.fatherRing, motherRing: p.motherRing,
          reviewVersion: "v1", issuedBy: "backfill-v1", issuedAt: at, status: "valid"
        });
      }
    }
    db.schemaVersion = 2;
    await persist(db);
  }
  dbCache = db;
  return db;
}
async function persist(db, { simulateFail = false } = {}) {
  if (forceFailWrites || simulateFail) throw new Error("simulated disk write failure");
  const tmp = `${dbPath}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}
async function spoolBatch(batchId, payload) {
  await mkdir(spoolDir, { recursive: true });
  const safe = String(batchId).replace(/[^A-Za-z0-9_-]/g, "_");
  const file = join(spoolDir, `batch-${safe}-${Date.now()}.json`);
  await writeFile(file, JSON.stringify({ batchId, spooledAt: nowIso(), payload }, null, 2));
  return file;
}
async function listSpool() {
  if (!existsSync(spoolDir)) return [];
  const files = (await readdir(spoolDir)).filter(f => f.endsWith(".json")).sort();
  const out = [];
  for (const f of files) {
    try {
      const doc = JSON.parse(await readFile(join(spoolDir, f), "utf8"));
      out.push({ file: f, batchId: doc.batchId, spooledAt: doc.spooledAt });
    } catch { /* 损坏的留待人工，不阻塞恢复列表 */ }
  }
  return out;
}

// ---------- 复核批次核心 ----------
function ingestReport(db, input, at) {
  const required = ["sampleNo", "ringNo", "collectedAt", "fatherRing", "motherRing"];
  for (const k of required) if (!(k in input)) throw new Error(`missing_field:${k}`);
  const pigeon = db.pigeons.find(p => p.ringNo === input.ringNo);
  if (!pigeon) throw new Error(`pigeon_not_found:${input.ringNo}`);
  const result = { fatherRing: input.fatherRing || "", motherRing: input.motherRing || "" };
  const hash = contentHash(input);
  const owner = ownerAt(pigeon, input.collectedAt); // 报告归采集时鸽主
  const existing = db.reports.find(r => r.sampleNo === input.sampleNo);
  if (existing) {
    existing.transmissions.push({ receivedAt: at, contentHash: hash });
    existing.lastReceivedAt = at;
    if (hash === existing.contentHash) {
      return { sampleNo: input.sampleNo, outcome: "duplicate", message: "同样本重传，沿用首次结果" };
    }
    existing.status = "conflict"; // 内容变了留冲突，不覆盖现有血统
    existing.conflicts.push({ receivedAt: at, collectedAt: input.collectedAt, fatherRing: result.fatherRing, motherRing: result.motherRing, contentHash: hash });
    return { sampleNo: input.sampleNo, outcome: "conflict", message: "同样本内容变化，冲突留存，现有血统不变" };
  }
  db.reports.push({
    sampleNo: input.sampleNo, ringNo: input.ringNo, collectedAt: input.collectedAt,
    firstResult: result, contentHash: hash, ownerAtCollection: owner,
    firstReceivedAt: at, lastReceivedAt: at,
    transmissions: [{ receivedAt: at, contentHash: hash }],
    conflicts: [], status: "awaiting_confirmation"
  });
  return { sampleNo: input.sampleNo, outcome: "new", ownerAtCollection: owner };
}
function applyConfirmation(db, input, at) {
  const report = db.reports.find(r => r.sampleNo === input.sampleNo);
  if (!report) throw new Error(`unknown_sample:${input.sampleNo}`);
  const pigeon = db.pigeons.find(p => p.ringNo === report.ringNo);
  const registrarContent = input.fatherRing !== undefined || input.motherRing !== undefined
    ? { fatherRing: input.fatherRing || "", motherRing: input.motherRing || "" }
    : report.firstResult;
  const hash = contentHash({ ringNo: report.ringNo, collectedAt: report.collectedAt, ...registrarContent });
  const prior = db.confirmations.filter(c => c.sampleNo === input.sampleNo);
  const applied = prior.filter(c => c.status === "applied").pop();
  // 首轮：两名登记员同时确认 → 先到生效 / 后到留待；确认后鸽主换人 → 再来的是重确认
  const role = applied ? (pigeon.owner !== applied.ownerContext ? "reconfirmation" : "late_duplicate") : "confirmation";

  // 重放幂等：同登记员、同内容、同角色已存在则跳过
  const replayHit = prior.find(c => c.registrar === input.registrar && c.contentHash === hash && c.role === role);
  if (replayHit) return { sampleNo: report.sampleNo, outcome: "skipped_replayed", status: replayHit.status, role };

  const base = {
    id: `CF-${sha1(report.sampleNo + input.registrar + at + prior.length).slice(0, 10)}`,
    sampleNo: report.sampleNo, ringNo: report.ringNo, registrar: String(input.registrar || "匿名登记员"),
    contentHash: hash, submittedAt: at, result: registrarContent, role
  };
  const hold = reason => {
    db.confirmations.push({ ...base, status: "held", heldReason: reason });
    return { sampleNo: report.sampleNo, outcome: "held_for_review", reason, role, registrar: base.registrar };
  };
  if (report.status === "conflict") return hold("report_conflict");
  if (!applied) {
    if (hash !== report.contentHash) return hold("registrar_content_mismatch");
    const before = parentTuple(pigeon);
    pigeon.fatherRing = registrarContent.fatherRing;
    pigeon.motherRing = registrarContent.motherRing;
    pigeon.reviewVersion = nextVersion(db, pigeon.ringNo);
    pigeon.reviewedAt = at;
    pigeon.confirmedBy = base.registrar;
    const parentChanged = before !== parentTuple(pigeon);
    recomputeLineage(db, pigeon.ringNo, { source: report.sampleNo, parentChanged, at });
    db.confirmations.push({ ...base, status: "applied", ownerContext: pigeon.owner, ownerAtCollection: report.ownerAtCollection, reviewVersion: pigeon.reviewVersion, parentChanged });
    return { sampleNo: report.sampleNo, outcome: "applied", role, reviewVersion: pigeon.reviewVersion, parentChanged, registrar: base.registrar };
  }
  if (role === "late_duplicate") return hold(hash !== applied.contentHash ? "later_registrar_content_mismatch" : "later_registrar"); // 先到者生效，后到内容留待复核
  if (hash !== applied.contentHash) return hold("reconfirm_content_mismatch");
  pigeon.lastReconfirm = { by: base.registrar, owner: pigeon.owner, at };
  db.confirmations.push({ ...base, status: "applied", ownerContext: pigeon.owner, contentHash: applied.contentHash, reviewVersion: pigeon.reviewVersion, parentChanged: false });
  return { sampleNo: report.sampleNo, outcome: "applied", role: "reconfirmation", reviewVersion: pigeon.reviewVersion, registrar: base.registrar };
}
async function ingestBatch(payload, options = {}) {
  const db = await loadDb();
  const at = nowIso();
  const batchId = payload.batchId || `BATCH-${Date.now()}`;
  const reportResults = (payload.reports || []).map(r => ingestReport(db, r, at));
  const confirmResults = (payload.confirmations || []).map(c => applyConfirmation(db, c, at));
  db.batches.push({ batchId, at, reports: reportResults, confirmations: confirmResults });
  try {
    await persist(db, options);
    return { batchId, spooled: false, reports: reportResults, confirmations: confirmResults };
  } catch (error) {
    // 写盘失败：整批留本地，内存回滚，按原样本号恢复
    const file = await spoolBatch(batchId, payload);
    dbCache = await readDb();
    return { batchId, spooled: true, spoolFile: file, error: error.message, reports: reportResults.map(r => ({ ...r, pendingRecovery: true })) };
  }
}
async function recoverBatches() {
  const results = [];
  for (const meta of await listSpool()) {
    const path = join(spoolDir, meta.file);
    try {
      const doc = JSON.parse(await readFile(path, "utf8"));
      const summary = await ingestBatch(doc.payload);
      if (!summary.spooled) {
        await unlink(path);
        results.push({ file: meta.file, batchId: doc.batchId, recovered: true, summary });
      } else {
        results.push({ file: meta.file, batchId: doc.batchId, recovered: false, error: "still_failing" });
      }
    } catch (error) {
      results.push({ file: meta.file, recovered: false, error: error.message });
    }
  }
  return results;
}

// ---------- HTTP ----------
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return {
    pigeon, father, mother, children,
    lock: lockInfo(db, pigeon),
    reports: db.reports.filter(r => r.ringNo === ringNo),
    confirmations: db.confirmations.filter(c => c.ringNo === ringNo),
    credentials: db.credentials.filter(c => c.ringNo === ringNo)
  };
}
// 全局 FIFO 串行：两名登记员同时确认同一只鸽，按到达先后定生效方
let chain = Promise.resolve();
const serialize = task => {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
};

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2e6b4f; --amber:#9a6b1e; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    textarea { min-height:110px; font-family:Menlo,monospace; font-size:12px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.ghost { background:#e7edf2; color:var(--accent); } button.warn { background:var(--red); }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.ok { border-color:var(--green); color:var(--green); } .pill.bad { border-color:var(--red); color:var(--red); } .pill.warn { border-color:var(--amber); color:var(--amber); }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .full { grid-column:1/-1; } .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    pre.out { background:#16222c; color:#cfe3f2; padding:10px; border-radius:6px; max-height:240px; overflow:auto; font-size:12px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案 · 转让 · 血统 · 亲权复核批次</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建鸽只档案</h2>
      <label>足环号</label><input name="ringNo" required>
      <label>鸽主</label><input name="owner" required>
      <label>父鸽足环号</label><input name="fatherRing">
      <label>母鸽足环号</label><input name="motherRing">
      <label>羽色</label><input name="color" required>
      <label>出生棚号</label><input name="loft" required>
      <button>保存档案</button>
    </form>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="section grid" id="cards"></div>
    </section>
    <section class="panel full">
      <h2>亲权复核批次（实验室羽毛样本报告）</h2>
      <textarea id="batchInput"></textarea>
      <div class="row" style="margin-top:10px">
        <button id="ingestBtn">提交批次</button>
        <button class="ghost" id="recoverBtn">恢复本地批次</button>
        <label style="margin:0"><input type="checkbox" id="failWrite" style="width:auto"> 模拟写盘失败（落本地批次）</label>
      </div>
      <pre class="out" id="batchOut" style="margin-top:10px">尚未提交。</pre>
      <div id="queue" class="section"></div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    const batchInput = document.querySelector("#batchInput");
    const batchOut = document.querySelector("#batchOut");
    let pigeons = [];
    batchInput.value = JSON.stringify({ batchId: "B-EXAMPLE-01", reports: [{ sampleNo: "F-0001", ringNo: "CHN-2026-001", collectedAt: "2026-05-10T08:00:00Z", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512" }] }, null, 2);
    async function api(path, options) {
      const opts = options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options;
      const res = await fetch(path, opts);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function pill(text, cls) { return '<span class="pill ' + (cls || "") + '">' + text + "</span>"; }
    function renderCards() {
      cards.innerHTML = pigeons.map(p => {
        const lock = p.pedigreeComplete === false ? pill("血统待复核", "warn") : pill("血统完整 v" + String(p.reviewVersion||"?").replace(/^v/,""), "ok");
        return '<article class="card"><h3>'+p.ringNo+'</h3><div class="row"><span class="pill">'+p.owner+'</span>'+lock+'</div><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button data-transfer="'+p.ringNo+'">保存转让</button><label>归巢成绩</label><input data-race="'+p.ringNo+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+p.ringNo+'">保存成绩</button></article>';
      }).join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); await load();
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、复核状态、参赛凭据、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      const lockHtml = data.lock.locked ? '<div class="section"><b class="pill bad">档案锁定</b> <span class="meta">'+data.lock.message+'</span></div>' : '<div class="section">'+pill("档案可编辑", "ok")+'</div>';
      const reps = data.reports.map(r => '<div class="small"><b>'+r.sampleNo+'</b> '+pill(r.status==="conflict"?"内容冲突":(r.status==="awaiting_confirmation"?"待确认":"已确认"),r.status==="conflict"?"bad":"warn")+'<div class="meta">采集：'+r.collectedAt+' ｜ 采集时鸽主：'+r.ownerAtCollection+'</div><div>父 '+r.firstResult.fatherRing+' ｜ 母 '+r.firstResult.motherRing+'</div><div class="meta">重传 '+r.transmissions.length+' 次；冲突 '+r.conflicts.length+' 条</div><input data-reg="'+r.sampleNo+'" placeholder="登记员姓名" style="margin-top:6px"><button data-confirm="'+r.sampleNo+'">确认 / 重确认</button></div>').join("") || '<div class="meta">无样本报告</div>';
      const held = data.confirmations.filter(c=>c.status==="held").map(c=>'<div class="meta">留待复核：'+c.registrar+'（'+c.heldReason+'）@'+c.submittedAt+'</div>').join("");
      const creds = data.credentials.map(c=>'<div class="meta">'+c.code+' '+pill(c.status==="valid"?"有效":"已作废",c.status==="valid"?"ok":"bad")+' 来源 '+c.issuedBy+(c.voidReason?" · "+c.voidReason:"")+'</div>').join("") || '<div class="meta">无参赛凭据</div>';
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+' · 复核版 '+(p.reviewVersion||"无")+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div>'
        + lockHtml
        + '<div><b>子代</b> '+(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div>'
        + '<div class="section"><b>羽毛样本报告</b><div class="grid" style="margin-top:6px">'+reps+'</div>'+held+'</div>'
        + '<div class="section"><b>参赛凭据</b>'+creds+'</div>'
        + '<div class="meta section">转让：'+(p.transfers.map(t => t.from+"→"+t.to+" ("+t.date+")").join(" / ") || "暂无")+'</div>'
        + '<div class="meta">疫苗：'+(p.vaccines.map(v => v.name+" ("+v.date+")").join(" / ") || "暂无")+'</div>'
        + '<div class="meta">归巢：'+(p.races.map(r => r.event+" 第"+r.rank+"名").join(" / ") || "暂无")+'</div>';
      document.querySelectorAll("[data-confirm]").forEach(btn => btn.onclick = async () => {
        const sampleNo = btn.dataset.confirm;
        const registrar = document.querySelector('[data-reg="'+sampleNo+'"]').value || "登记员";
        await api("/api/review/confirmations", { method: "POST", body: JSON.stringify({ sampleNo, registrar }) });
        await load(); renderRelation(await api('/api/pigeons/'+encodeURIComponent(p.ringNo)+'/relation'));
      });
    }
    async function load(){ pigeons = await api("/api/pigeons"); renderCards(); renderRelation(null); renderQueue(); }
    async function renderQueue(){
      const rv = await api("/api/review");
      document.querySelector("#queue").innerHTML = '<div class="meta">报告 '+rv.reports.length+' 份 ｜ 确认 '+rv.confirmations.length+' 条 ｜ 凭据 '+rv.credentials.length+' 张 ｜ 本地待恢复批次 '+rv.spool.length+' 个</div>';
    }
    document.querySelector("#searchBtn").onclick = async () => renderRelation(await api('/api/pigeons/'+encodeURIComponent(search.value)+'/relation'));
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    document.querySelector("#ingestBtn").onclick = async () => {
      try {
        const fail = document.querySelector("#failWrite").checked;
        const rv = await api("/api/review/batches", { method:"POST", headers:{ "Content-Type":"application/json", "x-simulate-write-fail": fail ? "1" : "0" }, body: batchInput.value });
        batchOut.textContent = JSON.stringify(rv, null, 2);
      } catch (e) { batchOut.textContent = String(e); }
      await load();
    };
    document.querySelector("#recoverBtn").onclick = async () => {
      batchOut.textContent = JSON.stringify(await api("/api/review/recover", { method:"POST" }), null, 2);
      await load();
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const handle = async () => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/pigeons") return sendJson(res, 200, db.pigeons);

    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      if (db.pigeons.some(item => item.ringNo === input.ringNo)) return sendJson(res, 409, { error: "ring_exists" });
      const pigeon = { ringNo: input.ringNo, owner: input.owner, fatherRing: input.fatherRing || "", motherRing: input.motherRing || "", color: input.color, loft: input.loft, reviewVersion: "v1", reviewedAt: null, vaccines: [], transfers: [], races: [] };
      db.pigeons.unshift(pigeon);
      pigeon.pedigreeComplete = isComplete(db, pigeon);
      if (pigeon.pedigreeComplete) recomputeLineage(db, pigeon.ringNo, { source: `archive:${pigeon.ringNo}`, parentChanged: false, at: nowIso() });
      await persist(db);
      return sendJson(res, 201, pigeon);
    }
    const patchMatch = url.pathname.match(/^\/api\/pigeons\/(.+)$/);
    if (patchMatch && req.method === "PATCH") {
      const ringNo = decodeURIComponent(patchMatch[1]);
      const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const lock = lockInfo(db, pigeon);
      if (lock.locked) return sendJson(res, 423, { error: "archive_locked", lock });
      const input = await body(req);
      const before = parentTuple(pigeon);
      for (const k of ["color", "loft", "fatherRing", "motherRing", "owner"]) if (k in input) pigeon[k] = input[k] || "";
      const parentChanged = before !== parentTuple(pigeon);
      recomputeLineage(db, ringNo, { source: `manual:${ringNo}:${nowIso()}`, parentChanged, at: nowIso() });
      await persist(db);
      return sendJson(res, 200, pigeon);
    }
    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }
    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const pigeon = db.pigeons.find(item => item.ringNo === decodeURIComponent(actionMatch[1]));
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      // 转让/成绩/疫苗在档案锁定期间照旧可记（采集后转棚是复核流程的一部分）
      if (actionMatch[2] === "transfers") {
        const transfer = { date: input.date || new Date().toISOString().slice(0, 10), from: pigeon.owner, to: input.to };
        pigeon.owner = input.to;
        pigeon.transfers.push(transfer);
      }
      if (actionMatch[2] === "races") pigeon.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
      if (actionMatch[2] === "vaccines") pigeon.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name });
      await persist(db);
      return sendJson(res, 200, pigeon);
    }
    if (req.method === "GET" && url.pathname === "/api/review") {
      return sendJson(res, 200, { reports: db.reports, confirmations: db.confirmations, credentials: db.credentials, batches: db.batches, spool: await listSpool() });
    }
    if (req.method === "POST" && url.pathname === "/api/review/batches") {
      const payload = await body(req);
      const simulateFail = req.headers["x-simulate-write-fail"] === "1";
      const summary = await ingestBatch(payload, { simulateFail });
      return sendJson(res, summary.spooled ? 202 : 200, summary);
    }
    if (req.method === "POST" && url.pathname === "/api/review/confirmations") {
      const input = await body(req);
      const at = nowIso();
      try {
        const result = applyConfirmation(db, input, at);
        await persist(db);
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/review/recover") {
      return sendJson(res, 200, { recovered: await recoverBatches() });
    }
    sendJson(res, 404, { error: "not_found" });
  };
  const task = req.method === "GET" ? handle() : serialize(handle);
  task.catch(error => sendJson(res, 500, { error: error.message }));
});

await mkdir(dataDir, { recursive: true });
await loadDb();
server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
