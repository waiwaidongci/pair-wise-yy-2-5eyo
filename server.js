import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "pigeons.json");
const localBatchesPath = join(__dirname, "data", "local-batches.json");
const port = Number(process.env.PORT || 3024);

const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ],
  verificationBatches: []
};

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------
async function loadDb() {
  if (!existsSync(dbPath)) {
    try {
      await mkdir(dirname(dbPath), { recursive: true });
      await writeFile(dbPath, JSON.stringify(seed, null, 2));
    } catch { /* 目录不可写时退回内存态 */ }
  }
  try {
    const db = JSON.parse(await readFile(dbPath, "utf8"));
    if (!db.verificationBatches) db.verificationBatches = [];
    return db;
  } catch {
    return JSON.parse(JSON.stringify(seed));
  }
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }

// 本地批次：写盘失败时留在进程内，按样本号恢复
let localBatches = new Map();
async function loadLocalBatches() {
  try {
    if (existsSync(localBatchesPath)) {
      const data = JSON.parse(readFileSync(localBatchesPath, "utf8"));
      localBatches = new Map(Object.entries(data.localBatches || {}));
    }
  } catch { localBatches = new Map(); }
}
async function saveLocalBatches() {
  try {
    await writeFile(localBatchesPath, JSON.stringify({ localBatches: Object.fromEntries(localBatches) }, null, 2));
  } catch { /* 侧车文件也写失败就只留内存态 */ }
}

// 进程内唯一内存库，避免每次请求重读文件导致先到者状态丢失
let db = null;
async function getDb() {
  if (!db) {
    db = await loadDb();
    await loadLocalBatches();
    mergeLocalBatches(db);
    backfill(db);
    try { await saveDb(db); } catch { /* 回填写失败不影响内存态 */ }
  }
  return db;
}
// 把侧车文件里未持久化的批次并入内存库
function mergeLocalBatches(target) {
  for (const [sampleNo, batch] of localBatches) {
    if (!target.verificationBatches.some(b => b.sampleNo === sampleNo)) {
      target.verificationBatches.push(JSON.parse(JSON.stringify(batch)));
    }
  }
}
// 提交写盘；失败则把批次留本地
async function commit(db, batch) {
  try {
    await saveDb(db);
    for (const b of db.verificationBatches) {
      b.localOnly = false;
      localBatches.delete(b.sampleNo);
    }
    await saveLocalBatches();
    return { ok: true };
  } catch {
    if (batch) {
      batch.localOnly = true;
      localBatches.set(batch.sampleNo, batch);
      await saveLocalBatches();
    }
    return { ok: false, localOnly: true };
  }
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

// ---------------------------------------------------------------------------
// 血统与凭据
// ---------------------------------------------------------------------------
function hashId(...parts) {
  const str = parts.join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "cred-" + h.toString(16).padStart(8, "0");
}
function isVerified(p) { return !!p && (p.verificationVersion || 0) >= 1; }

// 血统完整标记：父母均已复核且父母血统完整；创始鸽（无父母）视为完整
// 用每分支独立路径检测真实循环，避免近交共同祖先被误判
function recomputePedigree(db, ringNo, path = new Set()) {
  if (path.has(ringNo)) return false;
  const p = db.pigeons.find(item => item.ringNo === ringNo);
  if (!p) return false;
  const hasFather = !!p.fatherRing;
  const hasMother = !!p.motherRing;
  if (!hasFather && !hasMother) return true;
  if (!hasFather || !hasMother) return false;
  const father = db.pigeons.find(item => item.ringNo === p.fatherRing);
  const mother = db.pigeons.find(item => item.ringNo === p.motherRing);
  if (!father || !mother) return false;
  const nextPath = new Set(path);
  nextPath.add(ringNo);
  return isVerified(father) && isVerified(mother)
    && recomputePedigree(db, father.ringNo, nextPath)
    && recomputePedigree(db, mother.ringNo, nextPath);
}

// 参赛凭据：确定性 id，已有效则不重复生成
function recomputeCredential(p) {
  if (p.racingCredential && p.racingCredential.status === "valid") return p.racingCredential;
  const id = hashId(p.ringNo, p.fatherRing || "", p.motherRing || "", p.verificationVersion || 1);
  const cred = { id, status: "valid", issuedAt: new Date().toISOString() };
  p.racingCredential = cred;
  return cred;
}
function invalidateCredential(p) {
  p.racingCredential = { id: p.racingCredential?.id || null, status: "invalid", invalidatedAt: new Date().toISOString() };
}
function collectDescendants(db, ringNo) {
  const result = [];
  const seen = new Set();
  const walk = (rn) => {
    if (seen.has(rn)) return;
    seen.add(rn);
    const children = db.pigeons.filter(item => item.fatherRing === rn || item.motherRing === rn);
    for (const child of children) { result.push(child); walk(child.ringNo); }
  };
  walk(ringNo);
  return result;
}

// 复核确认生效：应用亲鸽环号，重算本鸽及后代血统标记与凭据
function applyConfirmation(db, batch, confirmation) {
  const p = db.pigeons.find(item => item.ringNo === batch.pigeonRingNo);
  if (!p) return;
  const newFather = confirmation.fatherRing || batch.report.fatherRing || "";
  const newMother = confirmation.motherRing || batch.report.motherRing || "";
  const parentChanged = p.fatherRing !== newFather || p.motherRing !== newMother;
  if (parentChanged) {
    p.pedigreeComplete = false;
    invalidateCredential(p);
    p.fatherRing = newFather;
    p.motherRing = newMother;
  }
  p.verificationVersion = (p.verificationVersion || 1) + 1;
  p.pedigreeComplete = recomputePedigree(db, p.ringNo);
  recomputeCredential(p);
  // 父/母一变，后代血统完整标记与参赛凭据立即失效重算
  const descendants = collectDescendants(db, p.ringNo);
  for (const d of descendants) {
    if (parentChanged) {
      d.pedigreeComplete = false;
      invalidateCredential(d);
    }
    d.pedigreeComplete = recomputePedigree(db, d.ringNo);
    recomputeCredential(d);
  }
}

// 旧档案回填初版复核版本，疫苗、转让、成绩照旧不动
function backfill(db) {
  for (const p of db.pigeons) {
    if (p.verificationVersion === undefined) p.verificationVersion = 1;
  }
  for (const p of db.pigeons) {
    if (p.pedigreeComplete === undefined) p.pedigreeComplete = recomputePedigree(db, p.ringNo);
    if (p.racingCredential === undefined) recomputeCredential(p);
  }
}

// 采集时点鸽主：按转让记录回推
function ownerAt(db, pigeon, atDate) {
  const transfers = [...pigeon.transfers].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (transfers.length === 0) return pigeon.owner;
  const before = transfers.filter(t => t.date <= atDate);
  if (before.length > 0) return before[before.length - 1].to;
  return transfers[0].from;
}

// 是否存在待复核批次（重确认前锁定档案）
function hasPendingBatch(db, ringNo) {
  return db.verificationBatches.some(b => b.pigeonRingNo === ringNo && b.status === "pending")
    || [...localBatches.values()].some(b => b.pigeonRingNo === ringNo && b.status === "pending");
}

function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2e7d4f; --amber:#8a6d1a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.danger { background:var(--red); } button.ghost { background:#eef2f5; color:var(--ink); }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.ok { color:var(--green); border-color:var(--green); } .pill.no { color:var(--red); border-color:var(--red); } .pill.warn { color:var(--amber); border-color:var(--amber); }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .batch { border:1px solid var(--line); border-radius:8px; padding:12px; display:grid; gap:6px; } .batch.conflict { border-color:var(--red); } .batch.local { border-color:var(--amber); }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; } .msg { margin-top:10px; font-size:13px; } .msg.err { color:var(--red); } .msg.ok { color:var(--green); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、转让、归巢成绩与亲权复核</div></div><button id="reload">刷新</button></header>
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
      <div class="section">
        <h2>亲权复核批次</h2>
        <form id="reportForm" class="panel" style="margin-bottom:12px;">
          <h2 style="font-size:16px;">提交羽毛样本报告</h2>
          <label>样本号</label><input name="sampleNo" required>
          <label>本鸽足环号</label><input name="pigeonRingNo" required>
          <label>采集时点</label><input name="collectedAt" type="date" required>
          <label>父鸽环号</label><input name="fatherRing">
          <label>母鸽环号</label><input name="motherRing">
          <button>提交报告</button>
        </form>
        <div class="row" style="margin-bottom:10px;"><button id="replayBtn" class="ghost">重放本地批次</button><span class="meta" id="localCount"></span></div>
        <div class="grid" id="batches"></div>
      </div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    const batchesEl = document.querySelector("#batches");
    const reportForm = document.querySelector("#reportForm");
    const localCount = document.querySelector("#localCount");
    let pigeons = [];
    let batches = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function credPill(p){
      if (!p.racingCredential) return '<span class="pill warn">凭据未发</span>';
      return p.racingCredential.status === "valid" ? '<span class="pill ok">参赛凭据有效</span>' : '<span class="pill no">参赛凭据失效</span>';
    }
    function pedigreePill(p){
      return p.pedigreeComplete ? '<span class="pill ok">血统完整</span>' : '<span class="pill no">血统待核</span>';
    }
    function renderCards() {
      cards.innerHTML = pigeons.map(p => '<article class="card"><h3>'+p.ringNo+'</h3><div class="row">'+pedigreePill(p)+credPill(p)+'</div><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+' · 复核v'+(p.verificationVersion||1)+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button data-transfer="'+p.ringNo+'">保存转让</button><label>归巢成绩</label><input data-race="'+p.ringNo+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+p.ringNo+'">保存成绩</button></article>').join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load(); }
        catch(e){ alert(e.message); }
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); await load(); }
        catch(e){ alert(e.message); }
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="row" style="margin-bottom:10px;">'+pedigreePill(p)+credPill(p)+'</div><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div><div class="meta">归巢：'+(p.races.map(r => r.event+" 第"+r.rank+"名").join(" / ") || "暂无")+'</div>';
    }
    function renderBatches() {
      localCount.textContent = batches.filter(b => b.localOnly).length ? ('本地待重放：'+batches.filter(b => b.localOnly).length) : '';
      batchesEl.innerHTML = batches.map(b => {
        const statusPill = b.status === "confirmed" ? '<span class="pill ok">已确认</span>' : '<span class="pill warn">待确认</span>';
        const conflicts = (b.conflicts||[]).map(c => '<div class="meta" style="color:var(--red);">冲突：'+(c.fatherRing||"")+'/'+(c.motherRing||"")+' @ '+c.receivedAt+'</div>').join("");
        const confs = (b.confirmations||[]).map(c => '<div class="meta">'+c.registrar+'：'+(c.fatherRing||"")+'/'+(c.motherRing||"")+' · '+(c.result==="first"?"<span style='color:var(--green)'>先到生效</span>":"<span style='color:var(--amber)'>留待复核</span>")+'</div>').join("");
        const cls = (b.conflicts&&b.conflicts.length)?'batch conflict':(b.localOnly?'batch local':'batch');
        return '<div class="'+cls+'"><div class="row"><b>'+b.sampleNo+'</b>'+statusPill+(b.localOnly?'<span class="pill warn">本地待重放</span>':'')+'</div><div class="meta">本鸽：'+b.pigeonRingNo+' · 采集：'+b.collectedAt+'</div><div class="meta">采集时鸽主：'+(b.ownerAtCollection||"未知")+'</div><div class="meta">报告亲鸽：'+(b.report.fatherRing||"未登记")+' / '+(b.report.motherRing||"未登记")+'</div>'+conflicts+confs+'<div class="row"><input data-reg="'+b.id+'" placeholder="登记员" style="max-width:120px;"><button data-confirm="'+b.id+'">确认</button></div></div>';
      }).join("");
      document.querySelectorAll("[data-confirm]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.confirm; const reg = document.querySelector('[data-reg="'+id+'"]').value || "登记员";
        try { await api('/api/verification-batches/'+encodeURIComponent(id)+'/confirm', { method:'POST', body: JSON.stringify({ registrar: reg }) }); await load(); }
        catch(e){ alert(e.message); }
      });
    }
    async function load(){
      pigeons = await api("/api/pigeons");
      try { batches = await api("/api/verification-batches"); } catch { batches = []; }
      renderCards(); renderRelation(null); renderBatches();
    }
    document.querySelector("#searchBtn").onclick = async () => renderRelation(await api('/api/pigeons/'+encodeURIComponent(search.value)+'/relation'));
    document.querySelector("#reload").onclick = load;
    document.querySelector("#replayBtn").onclick = async () => {
      try { const r = await api("/api/verification-batches/replay", { method:"POST", body: JSON.stringify({}) }); alert("已重放 "+(r.replayed?.length||0)+" 个批次"); await load(); }
      catch(e){ alert(e.message); }
    };
    reportForm.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(reportForm);
      try { await api("/api/verification-batches", { method:"POST", body: JSON.stringify(Object.fromEntries(fd.entries())) }); reportForm.reset(); await load(); }
      catch(e){ alert(e.message); }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      try { await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) }); form.reset(); await load(); }
      catch(e){ alert(e.message); }
    };
    load();
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await getDb();

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }

    if (req.method === "GET" && url.pathname === "/api/pigeons") {
      return sendJson(res, 200, db.pigeons);
    }

    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      if (db.pigeons.some(item => item.ringNo === input.ringNo)) return sendJson(res, 409, { error: "ring_exists" });
      const pigeon = { ...input, verificationVersion: 1, pedigreeComplete: true, racingCredential: null, vaccines: [], transfers: [], races: [] };
      db.pigeons.unshift(pigeon);
      pigeon.pedigreeComplete = recomputePedigree(db, pigeon.ringNo);
      recomputeCredential(pigeon);
      const result = await commit(db);
      return sendJson(res, result.ok ? 201 : 202, { pigeon, localOnly: !result.ok });
    }

    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }

    // 提交羽毛样本报告（复核批次）
    if (req.method === "POST" && url.pathname === "/api/verification-batches") {
      const input = await body(req);
      if (!input.sampleNo || !input.pigeonRingNo || !input.collectedAt) return sendJson(res, 400, { error: "missing_fields" });
      const pigeon = db.pigeons.find(item => item.ringNo === input.pigeonRingNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });

      // 同样本重传：沿用首次结果，内容变了留冲突，不覆盖现有血统
      const existing = db.verificationBatches.find(b => b.sampleNo === input.sampleNo) || localBatches.get(input.sampleNo);
      if (existing) {
        const sameContent = existing.report.fatherRing === (input.fatherRing || "")
          && existing.report.motherRing === (input.motherRing || "")
          && existing.pigeonRingNo === input.pigeonRingNo
          && existing.collectedAt === input.collectedAt;
        if (sameContent) return sendJson(res, 200, { batch: existing, idempotent: true });
        existing.conflicts.push({ receivedAt: new Date().toISOString(), fatherRing: input.fatherRing || "", motherRing: input.motherRing || "", pigeonRingNo: input.pigeonRingNo, collectedAt: input.collectedAt, reason: "content_changed" });
        const result = await commit(db, existing);
        return sendJson(res, 200, { batch: existing, conflict: true, localOnly: !result.ok });
      }

      const batch = {
        id: "batch-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        sampleNo: input.sampleNo,
        pigeonRingNo: input.pigeonRingNo,
        collectedAt: input.collectedAt,
        ownerAtCollection: ownerAt(db, pigeon, input.collectedAt),
        report: { fatherRing: input.fatherRing || "", motherRing: input.motherRing || "", receivedAt: new Date().toISOString() },
        status: "pending",
        confirmations: [],
        conflicts: [],
        localOnly: false
      };
      db.verificationBatches.push(batch);
      const result = await commit(db, batch);
      return sendJson(res, 201, { batch, localOnly: !result.ok });
    }

    if (req.method === "GET" && url.pathname === "/api/verification-batches") {
      const all = [...db.verificationBatches];
      for (const b of localBatches.values()) {
        if (!all.some(x => x.sampleNo === b.sampleNo)) all.push(b);
      }
      return sendJson(res, 200, all);
    }

    // 重放本地批次（按原样本号恢复，不重复生成凭据）
    if (req.method === "POST" && url.pathname === "/api/verification-batches/replay") {
      const input = await body(req).catch(() => ({}));
      const replayed = [];
      const targets = input.sampleNo ? [localBatches.get(input.sampleNo)].filter(Boolean) : [...localBatches.values()];
      for (const batch of targets) {
        let existing = db.verificationBatches.find(b => b.sampleNo === batch.sampleNo);
        if (!existing) {
          existing = JSON.parse(JSON.stringify(batch));
          db.verificationBatches.push(existing);
        }
        // 重算但不重复生成凭据（已有效则保留）
        const p = db.pigeons.find(item => item.ringNo === batch.pigeonRingNo);
        if (p) {
          p.pedigreeComplete = recomputePedigree(db, p.ringNo);
          recomputeCredential(p);
        }
        replayed.push(batch.sampleNo);
      }
      const result = await commit(db);
      return sendJson(res, result.ok ? 200 : 202, { replayed, localOnly: !result.ok });
    }

    const batchMatch = url.pathname.match(/^\/api\/verification-batches\/(.+)$/);
    if (batchMatch && req.method === "GET") {
      const id = decodeURIComponent(batchMatch[1]);
      const batch = db.verificationBatches.find(b => b.id === id) || [...localBatches.values()].find(b => b.id === id);
      return batch ? sendJson(res, 200, batch) : sendJson(res, 404, { error: "batch_not_found" });
    }

    const confirmMatch = url.pathname.match(/^\/api\/verification-batches\/(.+)\/confirm$/);
    if (confirmMatch && req.method === "POST") {
      const id = decodeURIComponent(confirmMatch[1]);
      const batch = db.verificationBatches.find(b => b.id === id) || [...localBatches.values()].find(b => b.id === id);
      if (!batch) return sendJson(res, 404, { error: "batch_not_found" });
      const pigeon = db.pigeons.find(item => item.ringNo === batch.pigeonRingNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      const now = new Date().toISOString();

      // 两名登记员同时确认同一只鸽：先到者生效，后到内容留待复核
      if (batch.status === "confirmed") {
        batch.confirmations.push({ registrar: input.registrar || "登记员", fatherRing: input.fatherRing || batch.report.fatherRing || "", motherRing: input.motherRing || batch.report.motherRing || "", confirmedAt: now, result: "left_for_review" });
        const result = await commit(db, batch);
        return sendJson(res, 200, { batch, leftForReview: true, localOnly: !result.ok });
      }

      const confirmation = { registrar: input.registrar || "登记员", fatherRing: input.fatherRing || batch.report.fatherRing || "", motherRing: input.motherRing || batch.report.motherRing || "", confirmedAt: now, result: "first" };
      batch.confirmations.push(confirmation);
      batch.status = "confirmed";
      applyConfirmation(db, batch, confirmation);
      const result = await commit(db, batch);
      return sendJson(res, 200, { batch, confirmed: true, localOnly: !result.ok });
    }

    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const ringNo = decodeURIComponent(actionMatch[1]);
      if (hasPendingBatch(db, ringNo)) return sendJson(res, 409, { error: "archive_locked_pending_confirmation" });
      const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      if (actionMatch[2] === "transfers") {
        const transfer = { date: input.date || new Date().toISOString().slice(0, 10), from: pigeon.owner, to: input.to };
        pigeon.owner = input.to;
        pigeon.transfers.push(transfer);
      }
      if (actionMatch[2] === "races") pigeon.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
      if (actionMatch[2] === "vaccines") pigeon.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name });
      const result = await commit(db);
      return sendJson(res, result.ok ? 200 : 202, { pigeon, localOnly: !result.ok });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
