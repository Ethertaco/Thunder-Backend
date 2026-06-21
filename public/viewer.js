(async () => {
  const root = document.getElementById("root");
  const id = location.pathname.split("/").pop();

  let snap;
  try {
    const r = await fetch("/api/snapshot/" + id);
    if (!r.ok) throw new Error(r.status + " " + r.statusText);
    snap = await r.json();
  } catch (e) {
    root.innerHTML = '<div class="err">Failed to load snapshot ' + id + ": " + e.message + "</div>";
    return;
  }

  const m = snap.meta || {};
  const f = snap.frame || {};
  const w = snap.world || {};
  const mem = snap.mem || {};
  const sections = snap.sections || [];
  const mods = Array.isArray(snap.mods) ? snap.mods.slice() : [];

  // helpers
  function num(v, d) {
    if (typeof v !== "number" || !isFinite(v)) return "—";
    return v.toFixed(d == null ? 0 : d);
  }
  function txt(v) {
    if (v === undefined || v === null || v === "") return "—";
    return String(v);
  }
  function tsToLocal(unix) {
    if (!unix) return "—";
    const d = new Date(unix * 1000);
    const pad = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
         + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
  }

  function sparkline(history, w = 90, h = 18, color = "#7CFC7C") {
    if (!history || history.length === 0) return "";
    const max = Math.max.apply(null, history.concat([0.001]));
    const n = history.length;
    const pts = history.map((v, i) => {
      const x = (i / Math.max(1, n - 1)) * (w - 2) + 1;
      const y = h - 1 - (v / max) * (h - 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1"
                stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
  }

  function getHistory(s) {
    if (Array.isArray(s.history) && s.history.length > 0) return s.history;
    const v = +s.avgMs || 0;
    return Array(30).fill(v);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const trustedCreated = (typeof m.createdAtUnix === "number"
    && Math.abs(m.createdAtUnix - nowSec) < 86400) ? m.createdAtUnix : null;

  const created   = trustedCreated ? tsToLocal(trustedCreated) : "(unknown)";
  const expiresAt = trustedCreated ? tsToLocal(trustedCreated + 3600) : "—";
  const remainingMin = trustedCreated
    ? Math.round(((trustedCreated + 3600) * 1000 - Date.now()) / 60000)
    : null;
  let expiresLine;
  if (remainingMin === null)      expiresLine = "—";
  else if (remainingMin > 0)      expiresLine = expiresAt + ' <span style="opacity:.6">(in ' + remainingMin + ' min)</span>';
  else                             expiresLine = '<span class="err">expired</span>';

  const fAvg = isFinite(f.avgMs)     ? f.avgMs     : null;
  const fMin = isFinite(f.minMs)     ? f.minMs     : null;
  const fMax = isFinite(f.maxMs)     ? f.maxMs     : null;
  const fLow = isFinite(f.onePctLow) ? f.onePctLow : null;
  const avgFps   = fAvg && fAvg > 0 ? 1000 / fAvg : null;
  const bestFps  = fMin && fMin > 0 ? 1000 / fMin : null;
  const worstFps = fMax && fMax > 0 ? 1000 / fMax : null;
  const heapMb = isFinite(mem.managedBytes) ? mem.managedBytes / 1024 / 1024 : null;
  const frameAvg = fAvg || 0;

  function stat(value, label) {
    return '<div class="stat"><div class="v">' + value + '</div><div class="l">' + label + '</div></div>';
  }

  let html = '';
  html += '<div class="meta-grid">';
  html += '<div>id</div><b>' + escapeHtml(id) + '</b>';
  html += '<div>created</div><b>' + created + '</b>';
  html += '<div>expires</div><b>' + expiresLine + '</b>';
  html += '<div>thunder</div><b>' + txt(m.thunderVersion) + '</b>';
  html += '<div>unity</div><b>' + txt(m.unityVersion) + '</b>';
  html += '<div>platform</div><b>' + escapeHtml(txt(m.platform)) + '</b>';
  html += '<div>cpu</div><b>' + escapeHtml(txt(m.cpu)) + ' (' + txt(m.cpuCores) + ' cores)</b>';
  html += '<div>gpu</div><b>' + escapeHtml(txt(m.gpu)) + ' (' + txt(m.vramMb) + ' MB)</b>';
  html += '<div>ram</div><b>' + txt(m.ramMb) + ' MB</b>';
  html += '<div>uptime</div><b>' + num(m.uptimeSec, 0) + ' s · ' + txt(m.framesSampled) + ' frames</b>';
  if (typeof m.captureSec === "number" && m.captureSec > 0)
    html += '<div>capture</div><b>' + num(m.captureSec, 0) + ' s window</b>';
  html += '</div>';

  html += '<h2>Frame</h2><div class="stats">';
  html += stat(num(avgFps, 0), 'avg FPS (' + num(fAvg, 2) + ' ms)');
  html += stat(num(fLow, 0),   '1% low FPS');
  html += stat(num(fMin, 2) + (fMin === null ? '' : ' ms'),
               'best frame' + (bestFps ? ' (' + num(bestFps, 0) + ' FPS)' : ''));
  html += stat(num(fMax, 2) + (fMax === null ? '' : ' ms'),
               'worst frame' + (worstFps ? ' (' + num(worstFps, 0) + ' FPS)' : ''));
  html += '</div><div class="chart-box wide"><canvas id="frameChart"></canvas></div>';

  function groupKey(name) {
    if (!name) return "Other";
    if (name.startsWith("mod:")) return "Mods";
    const dot = name.indexOf(".");
    return dot > 0 ? name.substring(0, dot) : name;
  }
  const GROUP_LABELS = {
    Cam: "PlayerCamera", World: "WorldGeneration", Fluid: "FluidManager",
    Chunk: "ChunkScript", Body: "Body", Moodle: "MoodleManager",
    Spider: "SpiderHandler", Liquids: "Liquids", CoUtils: "CoUtils",
    Mods: "Other mods", Other: "Other",
  };

  const allSecs = sections.concat(
    mods.map(s => Object.assign({}, s, {
      name: s.name && s.name.startsWith("mod:") ? s.name : ("mod:" + (s.name || s.label || "?")),
      _label: s.label || s.name,
    }))
  );

  const groups = new Map();
  for (const s of allSecs) {
    const k = groupKey(s.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  const groupArr = [];
  for (const [k, list] of groups.entries()) {
    list.sort((a, b) => (b.avgMs || 0) - (a.avgMs || 0));
    const total = list.reduce((acc, s) => acc + (s.avgMs || 0), 0);
    groupArr.push({ key: k, list, total });
  }
  groupArr.sort((a, b) => b.total - a.total);

  function rowHtml(s, idx, gkey) {
    const pct = frameAvg > 0 ? (s.avgMs || 0) / frameAvg * 100 : 0;
    const display = s._label || (s.name && s.name.startsWith("mod:") ? s.name.slice(4) : s.name);
    const spark = sparkline(getHistory(s));
    return `
      <details class="sec-row" data-gkey="${escapeHtml(gkey)}" data-idx="${idx}">
        <summary>
          <span class="tri">▶</span>
          <span class="name" title="${escapeHtml(display)}">${escapeHtml(display)}</span>
          <span class="spark">${spark}</span>
          <span class="avg">${num(s.avgMs, 3)} ms</span>
          <span class="max">${num(s.maxMs, 3)}</span>
          <span class="calls">×${num(s.avgCalls, 1)}</span>
          <span class="pct">${num(pct, 1)}%</span>
        </summary>
        <div class="sec-detail">
          <div class="chart-host"><canvas></canvas></div>
          <div class="kv">
            <span>avg <b>${num(s.avgMs, 3)}</b> ms</span>
            <span>max <b>${num(s.maxMs, 3)}</b> ms</span>
            <span>calls/frame <b>${num(s.avgCalls, 2)}</b></span>
            <span>% of frame <b>${num(pct, 1)}%</b></span>
            <span>section <b>${escapeHtml(s.name || "?")}</b></span>
          </div>
        </div>
      </details>`;
  }

  html += '<h2>Sections</h2>';
  if (allSecs.length === 0) {
    html += '<div style="opacity:.6;padding:.6em">no sections in this snapshot</div>';
  } else {
    for (const g of groupArr) {
      const label = GROUP_LABELS[g.key] || g.key;
      const groupPct = frameAvg > 0 ? g.total / frameAvg * 100 : 0;
      html += `
        <details class="sec-group" ${g.key === "Mods" ? "" : "open"}>
          <summary>
            <span class="tri">▶</span>
            <span class="gname">${escapeHtml(label)} <span class="meta">(${g.list.length})</span></span>
            <span class="meta">avg</span>
            <span class="avg" style="color:#FFD27C;text-align:right">${num(g.total, 2)} ms</span>
            <span class="meta">total</span>
            <span class="pct" style="text-align:right">${num(groupPct, 1)}%</span>
            <span></span>
          </summary>
          <div class="sec-group-body">
            ${g.list.map((s, i) => rowHtml(s, i, g.key)).join("")}
          </div>
        </details>`;
    }
  }

  // world
  html += '<h2>World</h2><div class="stats">';
  html += stat(txt(w.entities), 'entities');
  html += stat(txt(w.chunks),   'visible chunks');
  html += stat(txt(w.spiders),  'spiders');
  html += stat(heapMb !== null ? num(heapMb, 1) + ' MB' : '—', 'managed heap');
  html += '</div>';

  // raw
  html += '<h2>Raw JSON</h2><details><summary>show</summary><pre>'
       + escapeHtml(JSON.stringify(snap, null, 2)) + '</pre></details>';

  root.innerHTML = html;

  // charts
  Chart.defaults.color = "#cbd6e2";
  Chart.defaults.borderColor = "#232830";

  const frameHistory = Array.isArray(f.history) ? f.history : [];
  new Chart(document.getElementById("frameChart"), {
    type: "line",
    data: {
      labels: frameHistory.map((_, i) => i),
      datasets: [{
        label: "frame ms",
        data: frameHistory,
        borderColor: "#7CFC7C",
        backgroundColor: "rgba(124,252,124,.15)",
        pointRadius: 0,
        fill: true,
        tension: 0.25,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { y: { suggestedMin: 0, title: { text: "ms", display: true } } },
      plugins: { legend: { display: false } },
    },
  });

  const groupIndex = new Map();
  for (const g of groupArr) groupIndex.set(g.key, g.list);

  document.querySelectorAll("details.sec-row").forEach(d => {
    d.addEventListener("toggle", () => {
      if (!d.open || d.dataset.charted === "1") return;
      const gkey = d.dataset.gkey;
      const idx  = parseInt(d.dataset.idx, 10);
      const list = groupIndex.get(gkey);
      if (!list) return;
      const s = list[idx];
      if (!s) return;
      const canvas = d.querySelector("canvas");
      const hist = getHistory(s);
      new Chart(canvas, {
        type: "line",
        data: {
          labels: hist.map((_, i) => i),
          datasets: [{
            label: "ms",
            data: hist,
            borderColor: "#FFD27C",
            backgroundColor: "rgba(255,210,124,.15)",
            pointRadius: 0,
            fill: true,
            tension: 0.25,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: { y: { suggestedMin: 0 } },
          plugins: { legend: { display: false } },
        },
      });
      d.dataset.charted = "1";
    });
  });
})();
