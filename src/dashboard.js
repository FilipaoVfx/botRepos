// Observability dashboard — a self-contained HTTP monitor served by the bot.
//
// Philosophy: continuous feedback. It fuses three signals into one live view:
//   1. RAG query analytics (events table) — what users search, what fails
//   2. Process health (PM2)                   — status, restarts, cpu, memory
//   3. Host metrics (os)                      — load, ram, uptime
//
// No server-side dependencies: Node built-in http/os/child_process only. The
// frontend is a single inlined HTML page using Tailwind (Play CDN) that
// auto-refreshes against /api/metrics.

import http from "node:http";
import os from "node:os";
import { exec } from "node:child_process";

import { getQueryAnalytics, getKnowledgeStats } from "./rag-orchestrator.js";

// ─── PM2 metrics (best-effort) ───────────────────────────────────────
// Reads `pm2 jlist` and matches this very process by pid. If PM2 isn't on the
// PATH (e.g. running via `npm start`), we degrade gracefully to null and the
// dashboard falls back to Node's own process metrics.
function getPm2Metrics() {
  return new Promise((resolve) => {
    exec("pm2 jlist", { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const list = JSON.parse(stdout);
        const mine =
          list.find((p) => p.pid === process.pid) ||
          list.find((p) => p.name === process.env.name) ||
          list.find((p) => p.name === "telegram-rag-bot");
        if (!mine) return resolve(null);
        return resolve({
          name: mine.name,
          status: mine.pm2_env?.status ?? "unknown",
          pid: mine.pid,
          restarts: mine.pm2_env?.restart_time ?? 0,
          unstableRestarts: mine.pm2_env?.unstable_restarts ?? 0,
          uptimeMs: mine.pm2_env?.pm_uptime ? Date.now() - mine.pm2_env.pm_uptime : null,
          cpu: mine.monit?.cpu ?? null,
          memBytes: mine.monit?.memory ?? null,
          nodeVersion: mine.pm2_env?.node_version ?? process.version.replace(/^v/, ""),
        });
      } catch {
        return resolve(null);
      }
    });
  });
}

// ─── Host + own-process metrics (always available) ───────────────────
function getHostMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg(); // [1m, 5m, 15m]
  const cpus = os.cpus()?.length || 1;
  return {
    platform: `${os.type()} ${os.release()}`,
    cpus,
    load1: +load[0].toFixed(2),
    load5: +load[1].toFixed(2),
    load15: +load[2].toFixed(2),
    loadPct: Math.min(100, Math.round((load[0] / cpus) * 100)),
    memTotal: totalMem,
    memUsed: totalMem - freeMem,
    memPct: Math.round(((totalMem - freeMem) / totalMem) * 100),
    hostUptimeSec: Math.round(os.uptime()),
    // Own-process metrics (independent of PM2)
    procRssBytes: process.memoryUsage().rss,
    procUptimeSec: Math.round(process.uptime()),
    hostLabel: process.env.HOST_LABEL || os.hostname(),
  };
}

// ─── Metrics aggregator ──────────────────────────────────────────────
async function collectMetrics() {
  const [analytics, pm2, kb] = await Promise.all([
    getQueryAnalytics({ windowDays: 7, topN: 10 }).catch((e) => ({ error: e.message })),
    getPm2Metrics(),
    getKnowledgeStats().catch(() => null),
  ]);
  return {
    ok: true,
    ts: new Date().toISOString(),
    rag: analytics,
    knowledge: kb,
    process: pm2, // may be null → dashboard uses host.proc* fallback
    host: getHostMetrics(),
  };
}

// ─── HTML page (Tailwind Play CDN, self-contained) ───────────────────
function renderHtml() {
  return `<!doctype html>
<html lang="es" class="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>botRepos · Monitor de Observabilidad</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    darkMode: 'class',
    theme: { extend: {
      colors: {
        ink: '#0b0f17', panel: '#131a26', panel2: '#0f1520', line: '#1e2a3a',
        accent: '#4ea1ff', good: '#3fb950', warn: '#d29922', bad: '#f85149',
      },
      fontFamily: { mono: ['ui-monospace','SFMono-Regular','Menlo','Consolas','monospace'] },
    }},
  };
</script>
<style>
  @keyframes pulse2{50%{opacity:.35}}
  .livedot{animation:pulse2 2s infinite}
  .bar-tip:hover::after{content:attr(data-t);position:absolute;bottom:100%;left:50%;transform:translateX(-50%);
    background:#000;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;white-space:nowrap;margin-bottom:4px;z-index:10}
  ::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#1e2a3a;border-radius:8px}
</style>
</head>
<body class="bg-ink text-slate-100 font-mono antialiased min-h-screen">
<header class="sticky top-0 z-20 flex flex-wrap items-center gap-3 px-6 py-4 border-b border-line bg-ink/90 backdrop-blur">
  <span id="dot" class="livedot w-2.5 h-2.5 rounded-full bg-good shadow-[0_0_10px] shadow-good"></span>
  <h1 class="text-[15px] font-semibold tracking-wide">botRepos · <span class="text-accent">MONITOR DE OBSERVABILIDAD</span></h1>
  <div class="ml-auto flex flex-wrap gap-4 text-xs text-slate-400">
    <span>🖥️ <b id="host" class="text-slate-200">—</b></span>
    <span>refresh <b id="rf" class="text-slate-200">5s</b></span>
    <span>últ. <b id="upd" class="text-slate-200">—</b></span>
  </div>
</header>

<main class="max-w-6xl mx-auto p-5 grid gap-4">
  <section id="kpis" class="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5"></section>

  <section class="grid gap-4 lg:grid-cols-3">
    <div class="lg:col-span-2 rounded-xl border border-line bg-panel p-4">
      <h2 class="text-[11px] uppercase tracking-widest text-slate-400 mb-3">Volumen de consultas · 24h <span class="text-bad">(rojo = 0 resultados)</span></h2>
      <div id="spark" class="flex items-end gap-[3px] h-24"></div>
      <div class="flex justify-between text-[10px] text-slate-500 mt-1.5"><span>-24h</span><span>-12h</span><span>ahora</span></div>
    </div>
    <div class="rounded-xl border border-line bg-panel p-4">
      <h2 class="text-[11px] uppercase tracking-widest text-slate-400 mb-3">Salud proceso &amp; host</h2>
      <div id="health" class="grid grid-cols-2 gap-2"></div>
    </div>
  </section>

  <section class="grid gap-4 lg:grid-cols-3">
    <div class="lg:col-span-2 rounded-xl border border-bad/40 bg-panel p-4">
      <h2 class="text-[11px] uppercase tracking-widest text-slate-400 mb-3">⚠️ Consultas sin resultados · brechas de contenido</h2>
      <ul id="zero" class="divide-y divide-line/60"></ul>
    </div>
    <div class="rounded-xl border border-line bg-panel p-4">
      <h2 class="text-[11px] uppercase tracking-widest text-slate-400 mb-3">Por interfaz</h2>
      <div id="iface" class="grid gap-2.5"></div>
    </div>
  </section>

  <section class="grid gap-4 lg:grid-cols-2">
    <div class="rounded-xl border border-line bg-panel p-4">
      <h2 class="text-[11px] uppercase tracking-widest text-slate-400 mb-3">Consultas más frecuentes</h2>
      <ul id="top" class="divide-y divide-line/60"></ul>
    </div>
    <div class="rounded-xl border border-line bg-panel p-4">
      <h2 class="text-[11px] uppercase tracking-widest text-slate-400 mb-3">👤 Usuarios más activos</h2>
      <ul id="users" class="divide-y divide-line/60"></ul>
    </div>
  </section>
</main>
<footer class="text-center text-[11px] text-slate-500 py-6">botRepos observability · feedback continuo · auto-refresh</footer>

<script>
const REFRESH=5000;
const fmtN=n=>n==null?'—':n.toLocaleString('es-ES');
const fmtMB=b=>b==null?'—':(b/1048576).toFixed(0)+' MB';
const fmtDur=s=>{if(s==null)return'—';const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return (d?d+'d ':'')+(h?h+'h ':'')+m+'m';};
const ago=iso=>{const s=(Date.now()-new Date(iso))/1000;if(s<60)return Math.floor(s)+'s';
  if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';return Math.floor(s/86400)+'d';};
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const tone=(v,g,w)=>v>=g?'text-good':v>=w?'text-warn':'text-bad';        // higher = better
const toneInv=(v,g,w)=>v<=g?'text-good':v<=w?'text-warn':'text-bad';      // lower = better
const badge='inline-block text-[11px] px-2 py-0.5 rounded-full bg-panel2 text-slate-400 border border-line whitespace-nowrap';

function kpi(v,l,s,c){return \`<div class="rounded-xl border border-line bg-panel p-4">
  <div class="text-3xl font-semibold tracking-tight \${c||''}">\${v}</div>
  <div class="text-[11px] uppercase tracking-wide text-slate-400 mt-0.5">\${l}</div>
  <div class="text-[11px] text-slate-500 mt-1.5">\${s||''}</div></div>\`;}

async function tick(){
  try{
    const r=await fetch('/api/metrics',{cache:'no-store'});
    render(await r.json());
    document.getElementById('dot').className='livedot w-2.5 h-2.5 rounded-full bg-good shadow-[0_0_10px] shadow-good';
    document.getElementById('upd').textContent=new Date().toLocaleTimeString('es-ES');
  }catch(e){
    document.getElementById('dot').className='w-2.5 h-2.5 rounded-full bg-bad shadow-[0_0_10px] shadow-bad';
  }
}

function render(d){
  const rag=d.rag||{}, host=d.host||{}, proc=d.process, kb=d.knowledge||{};
  document.getElementById('host').textContent=host.hostLabel||'—';

  if(rag.error){
    document.getElementById('kpis').innerHTML='<div class="col-span-full rounded-xl border border-bad/50 bg-panel p-4 text-bad text-sm">Error analítica: '+esc(rag.error)+'</div>';
  }else{
    const lat=rag.latency||{}, z=rag.zeroResults||{}, tot=rag.totals||{}, sr=rag.successRate??100;
    const ph=rag.phases||{}, us=rag.usage||{};
    const fmtUsd=n=>n==null?'—':'$'+Number(n).toFixed(n<1?4:2);
    document.getElementById('kpis').innerHTML=[
      kpi(fmtN(tot.last24h),'consultas 24h','1h: '+fmtN(tot.lastHour)+' · total: '+fmtN(tot.all),'text-accent'),
      kpi(sr+'%','tasa de éxito','resultados > 0',tone(sr,90,70)),
      kpi(fmtN(lat.avg)+'ms','latencia media','p95: '+fmtN(lat.p95)+'ms',toneInv(lat.p95||0,3000,6000)),
      kpi(fmtN(rag.uniqueUsers),'usuarios únicos','ventana '+fmtN(rag.windowDays)+'d','text-slate-300'),
      kpi(fmtUsd(us.costAll),'coste embeddings','24h: '+fmtUsd(us.cost24h)+' · '+fmtN(us.tokens24h)+' tok/24h','text-slate-300'),
      kpi(fmtN(z.last24h),'sin resultados 24h','total ventana: '+fmtN(z.total),z.last24h>0?'text-warn':'text-good'),
      kpi(fmtN(ph.embeddingAvg)+' / '+fmtN(ph.retrievalAvg)+'ms','embed / retrieval','desglose de fases · llm: n/a','text-slate-300'),
      kpi(fmtN(kb.bookmarks)+' / '+fmtN(kb.readmes),'bookmarks / repos','base de conocimiento','text-slate-300'),
    ].join('');

    const tu=rag.topUsers||[];
    const tuEl=document.getElementById('users');
    if(tuEl) tuEl.innerHTML=tu.length?tu.map((x,i)=>
      \`<li class="flex justify-between gap-3 py-1.5 text-sm"><span class="truncate">\${i+1}. \${x.username?'@'+esc(x.username):'id '+esc(x.user_id)}</span><span class="\${badge}">×\${x.count} · \${ago(x.lastAt)}</span></li>\`
    ).join(''):'<li class="py-2 text-slate-500 italic text-sm">Sin usuarios de Telegram aún</li>';

    const h=rag.hourly||[], hz=rag.hourlyZero||[], max=Math.max(1,...h);
    document.getElementById('spark').innerHTML=h.map((v,i)=>{
      const isZero=hz[i]>0, hh=23-i;
      const cls=isZero?'bg-gradient-to-t from-[#7a2620] to-bad':'bg-gradient-to-t from-[#2b5c8f] to-accent';
      return \`<div class="bar-tip relative flex-1 rounded-t \${cls}" style="height:\${Math.max(2,Math.round(v/max*100))}%"
        data-t="\${v} consultas · hace \${hh}h\${hz[i]?' · '+hz[i]+' sin result.':''}"></div>\`;
    }).join('');

    const zl=document.getElementById('zero');
    zl.innerHTML=(z.recent&&z.recent.length)?z.recent.map(x=>
      \`<li class="flex justify-between gap-3 py-1.5 text-sm"><span class="truncate text-red-200">\${esc(x.query)}</span><span class="\${badge}">\${esc(x.interface)} · \${ago(x.created_at)}</span></li>\`
    ).join(''):'<li class="py-2 text-slate-500 italic text-sm">Sin brechas — toda consulta devolvió resultados 👌</li>';

    const bi=rag.byInterface||[], bmax=Math.max(1,...bi.map(x=>x.count));
    document.getElementById('iface').innerHTML=bi.map(x=>
      \`<div class="grid grid-cols-[80px_1fr_38px] items-center gap-2.5 text-xs">
        <span class="text-slate-300">\${esc(x.interface)}</span>
        <span class="h-2.5 rounded bg-panel2 overflow-hidden"><span class="block h-full rounded bg-gradient-to-r from-accent to-[#7ec8ff]" style="width:\${Math.round(x.count/bmax*100)}%"></span></span>
        <span class="text-right text-slate-400">\${x.count}</span></div>\`
    ).join('')||'<div class="text-slate-500 italic text-sm">Sin datos</div>';

    document.getElementById('top').innerHTML=(rag.topQueries||[]).map((x,i)=>
      \`<li class="flex justify-between gap-3 py-1.5 text-sm"><span class="truncate">\${i+1}. \${esc(x.query)}</span><span class="\${badge}">×\${x.count} · \${ago(x.lastAt)}</span></li>\`
    ).join('')||'<li class="py-2 text-slate-500 italic text-sm">Sin consultas registradas</li>';
  }

  const upS=proc?Math.round(proc.uptimeMs/1000):host.procUptimeSec;
  const cpu=proc&&proc.cpu!=null?proc.cpu:null;
  const mem=proc&&proc.memBytes!=null?proc.memBytes:host.procRssBytes;
  const st=proc?proc.status:'online', stc=st==='online'?'text-good':'text-bad';
  const stat=(l,v)=>\`<div class="rounded-lg bg-panel2 px-3 py-2"><div class="text-[10px] uppercase tracking-wide text-slate-500">\${l}</div><div class="text-lg font-semibold mt-0.5">\${v}</div></div>\`;
  document.getElementById('health').innerHTML=[
    stat('estado','<span class="'+stc+'">'+esc(st).toUpperCase()+'</span>'),
    stat('uptime bot',fmtDur(upS)),
    stat('reinicios',(proc?proc.restarts:'—')+(proc&&proc.unstableRestarts?' <span class="text-warn">('+proc.unstableRestarts+'⚠)</span>':'')),
    stat('cpu proceso',cpu==null?'—':cpu+'%'),
    stat('ram proceso',fmtMB(mem)),
    stat('node',proc?proc.nodeVersion:'—'),
    stat('carga host',host.load1+' <span class="'+toneInv(host.loadPct,70,90)+'">('+host.loadPct+'%)</span>'),
    stat('ram host',host.memPct+'% <span class="'+toneInv(host.memPct,80,92)+'">('+fmtMB(host.memUsed)+')</span>'),
  ].join('');
}

document.getElementById('rf').textContent=(REFRESH/1000)+'s';
tick();setInterval(tick,REFRESH);
</script>
</body>
</html>`;
}

// ─── HTTP server ─────────────────────────────────────────────────────
export function startDashboard({ port } = {}) {
  const listenPort = port || process.env.PORT || process.env.DASHBOARD_PORT;
  if (!listenPort) {
    console.log("[Dashboard] No PORT configured — dashboard disabled");
    return null;
  }
  const token = process.env.DASHBOARD_TOKEN || null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const send = (code, type, body) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    if (url.pathname === "/healthz") return send(200, "text/plain", "ok");

    // Optional shared-secret gate (via ?token= or x-dashboard-token header).
    if (token) {
      const provided = url.searchParams.get("token") || req.headers["x-dashboard-token"];
      if (provided !== token) return send(401, "text/plain", "unauthorized");
    }

    try {
      if (url.pathname === "/api/metrics") {
        const data = await collectMetrics();
        return send(200, "application/json", JSON.stringify(data));
      }
      if (url.pathname === "/" || url.pathname === "/dashboard") {
        return send(200, "text/html; charset=utf-8", renderHtml());
      }
      return send(404, "text/plain", "not found");
    } catch (err) {
      return send(500, "application/json", JSON.stringify({ ok: false, error: err.message }));
    }
  });

  server.on("error", (err) => console.error("[Dashboard] server error:", err.message));
  server.listen(listenPort, () => {
    console.log(`[Dashboard] Observability monitor on :${listenPort}${token ? " (token-protected)" : ""}`);
  });
  return server;
}

// Expose the collector so the Telegram /insights command can reuse it.
export { collectMetrics };
