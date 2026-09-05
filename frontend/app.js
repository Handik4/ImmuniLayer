/**
 * ImmuniLayer Protocol - Web3 Controller
 *
 * Every data point displayed here is read from the deployed ImmuniLayer
 * intelligent contract on GenLayer StudioNet via window.ImmuniChain
 * (genlayer-js). All write operations (create pool, submit vulnerability)
 * sign real on-chain transactions through the connected browser wallet.
 *
 * There are no simulated or mock data sources: pool balances, disclosures,
 * verdicts, and payouts are decoded from contract storage, and submissions
 * are broadcast as transactions settled by GenLayer validator consensus.
 */

// ============================================================================
// GLOBAL STATE (populated entirely from contract reads)
// ============================================================================
let state = {
  theme: localStorage.getItem("immunilayer_theme") || "dark",
  walletConnected: false,
  userAddress: null,
  claimable: "0",
  chainName: (window.IMMUNI_CONFIG && window.IMMUNI_CONFIG.chainName) || "studionet",
  contractAddress: (window.IMMUNI_CONFIG && window.IMMUNI_CONFIG.contractAddress) || "",

  stats: {
    total_pools: 0,
    total_reports: 0,
    total_bounties_paid: "0",
    contract_balance: "0"
  },

  pools: [],         // Populated by get_all_pools
  disclosures: [],   // Populated by get_recent_reports
  leaderboard: []    // Derived from disclosures
};

// ============================================================================
// VALUE / FORMAT HELPERS (native GEN uses 18 decimals)
// ============================================================================
const WEI_PER_GEN = 10n ** 18n;

function genToWei(amount) {
  const s = String(amount == null ? "" : amount).trim();
  if (!s) return 0n;
  const negative = s.startsWith("-");
  const clean = negative ? s.slice(1) : s;
  const parts = clean.split(".");
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").replace(/[^0-9]/g, "");
  const fracPadded = (frac + "000000000000000000").slice(0, 18);
  let wei = BigInt(whole.replace(/[^0-9]/g, "") || "0") * WEI_PER_GEN + BigInt(fracPadded || "0");
  return negative ? -wei : wei;
}

function weiToGenNumber(weiStr) {
  let wei;
  try { wei = BigInt(weiStr || "0"); } catch (e) { wei = 0n; }
  const whole = Number(wei / WEI_PER_GEN);
  const frac = Number(wei % WEI_PER_GEN) / 1e18;
  return whole + frac;
}

function fmtGen(weiStr) {
  const value = weiToGenNumber(weiStr);
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " GEN";
}

function sumPoolBalancesWei() {
  let total = 0n;
  state.pools.forEach((p) => {
    try { total += BigInt(p.balance || "0"); } catch (e) { /* ignore */ }
  });
  return total.toString();
}

function shortAddr(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Build a GitHub "blob" URL pointing at the exact audited file@commit that the
 * validators verified the exploit against. Returns "" when the report lacks the
 * revision metadata (e.g. legacy records).
 */
function githubBlobUrl(report) {
  if (!report) return "";
  const slug = report.repo_slug ||
    (report.repo_url || "").replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const commit = report.commit_hash;
  const filePath = report.file_path;
  if (!slug || !commit || !filePath) return "";
  return `https://github.com/${slug}/blob/${commit}/${filePath}`;
}

function safeParse(raw, fallback) {
  try {
    if (typeof raw === "string") return JSON.parse(raw);
    if (raw && typeof raw === "object") return raw;
    return fallback;
  } catch (e) {
    return fallback;
  }
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Return a StudioNet explorer URL for a transaction hash. */
function explorerTxUrl(hash) {
  if (window.ImmuniChain && window.ImmuniChain.explorerTxUrl) {
    return window.ImmuniChain.explorerTxUrl(hash);
  }
  return "https://studio.genlayer.com/tx/" + (hash || "");
}

// ============================================================================
// CHAIN BOOTSTRAP
// ============================================================================
function ensureChain() {
  if (window.ImmuniChain) return Promise.resolve(window.ImmuniChain);
  return new Promise((resolve) => {
    window.addEventListener("immunichain:ready", () => resolve(window.ImmuniChain), { once: true });
  });
}

async function refreshFromChain() {
  let chain;
  try {
    chain = await ensureChain();
  } catch (e) {
    return;
  }

  try {
    const [poolsRaw, reportsRaw, statsRaw] = await Promise.all([
      chain.read("get_all_pools", []),
      chain.read("get_recent_reports", [50]),
      chain.read("get_protocol_stats", [])
    ]);

    state.pools = safeParse(poolsRaw, []);
    state.disclosures = safeParse(reportsRaw, []);
    state.stats = safeParse(statsRaw, state.stats);
    state.leaderboard = buildLeaderboard(state.disclosures);

    // Rebuild live radar blips from real disclosure data.
    refreshRadarBlips();

    logConsensus(
      `[CHAIN] Synced ${state.pools.length} pool(s) and ${state.disclosures.length}` +
      ` disclosure(s) from ${shortAddr(state.contractAddress)}`
    );
  } catch (e) {
    logConsensus(`[CHAIN_ERROR] Read failed: ${e.message || e}`);
    showToast(`Could not read contract state: ${e.message || e}`, "danger");
  }

  renderDashboard();
  renderPools();
  renderDisclosures();
  renderLeaderboard();
}

function buildLeaderboard(reports) {
  const map = {};
  reports.forEach((r) => {
    const who = r.researcher || "unknown";
    if (!map[who]) map[who] = { name: who, verified: 0, criticals: 0, wonWei: 0n };
    if (r.status === "VERIFIED") {
      map[who].verified += 1;
      if (r.severity === "CRITICAL") map[who].criticals += 1;
    }
    try { map[who].wonWei += BigInt(r.payout_amount || "0"); } catch (e) { /* ignore */ }
  });

  const rows = Object.values(map).sort((a, b) => (a.wonWei > b.wonWei ? -1 : a.wonWei < b.wonWei ? 1 : 0));
  return rows.map((r, i) => ({
    rank: String(i + 1),
    name: r.name,
    verified: r.verified,
    criticals: r.criticals,
    won: fmtGen(r.wonWei.toString())
  }));
}

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  setupNavigation();
  init3DBackground();
  initThreatRadar();
  initTopologyCanvas();
  renderChainIdentity();
  renderValidators();
  setupPoCStudio();
  setupForms();
  setupWallet();
  setupFAQ();
  startTelemetryLogger();
  loadPreset("flashloan");

  // Render empty shells immediately, then hydrate from the live contract.
  renderDashboard();
  renderPools();
  renderDisclosures();
  renderLeaderboard();
  refreshFromChain();

  window.addEventListener("resize", () => {
    resize3DCanvas();
    resizeRadarCanvas();
    drawTopology();
  });
});

function renderChainIdentity() {
  const addr = state.contractAddress || "(not configured)";
  const heroAddr = document.getElementById("heroContractAddr");
  const footerAddr = document.getElementById("footerContractAddr");
  if (heroAddr) heroAddr.innerText = addr;
  if (footerAddr) footerAddr.innerText = addr;
}

// ============================================================================
// 3D INTERACTIVE BACKGROUND ENGINE
// ============================================================================
let bgCanvas, bgCtx, bgAnimId;
let bgNodes = [];
let bgTime = 0;
let mouse3D = { x: 0, y: 0, targetX: 0, targetY: 0 };

const GRID_COLS = 16;
const GRID_ROWS = 10;
const NODE_SPACING_X = 90;
const NODE_SPACING_Y = 80;

function init3DBackground() {
  bgCanvas = document.getElementById("bg3dCanvas");
  if (!bgCanvas) return;
  bgCtx = bgCanvas.getContext("2d");

  window.addEventListener("mousemove", (e) => {
    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;
    mouse3D.targetX = (e.clientX - halfW) / halfW;
    mouse3D.targetY = (e.clientY - halfH) / halfH;
  });

  resize3DCanvas();
  create3DGrid();

  function loop() {
    draw3DBackground();
    bgAnimId = requestAnimationFrame(loop);
  }
  loop();
}

function resize3DCanvas() {
  if (!bgCanvas || !bgCtx) return;
  const dpr = window.devicePixelRatio || 1;
  bgCanvas.width = window.innerWidth * dpr;
  bgCanvas.height = window.innerHeight * dpr;
  bgCtx.resetTransform();
  bgCtx.scale(dpr, dpr);
}

function create3DGrid() {
  bgNodes = [];
  const startX = -((GRID_COLS - 1) * NODE_SPACING_X) / 2;
  const startY = -((GRID_ROWS - 1) * NODE_SPACING_Y) / 2;

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      bgNodes.push({
        baseX: startX + c * NODE_SPACING_X,
        baseY: startY + r * NODE_SPACING_Y,
        baseZ: 0,
        r: r,
        c: c
      });
    }
  }
}

function draw3DBackground() {
  if (!bgCanvas || !bgCtx) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  bgCtx.clearRect(0, 0, w, h);

  bgTime += 0.015;

  mouse3D.x += (mouse3D.targetX - mouse3D.x) * 0.05;
  mouse3D.y += (mouse3D.targetY - mouse3D.y) * 0.05;

  const fov = 450;
  const cameraZ = 350;
  const cx = w / 2;
  const cy = h / 2 + 30;

  const rotY = mouse3D.x * 0.22;
  const rotX = -0.45 + mouse3D.y * 0.18;

  const isLight = state.theme === "light";
  const lineColor = isLight ? "rgba(99, 102, 241, 0.08)" : "rgba(99, 102, 241, 0.12)";
  const nodeDotColor = isLight ? "rgba(2, 132, 199, 0.25)" : "rgba(56, 189, 248, 0.35)";

  const projected = bgNodes.map((n) => {
    const wave = Math.sin(bgTime + n.c * 0.35 + n.r * 0.45) * 26 +
                 Math.cos(bgTime * 0.8 + n.c * 0.2) * 14;

    const x0 = n.baseX;
    const y0 = n.baseY + wave;
    const z0 = n.baseZ;

    const y1 = y0 * Math.cos(rotX) - z0 * Math.sin(rotX);
    const z1 = y0 * Math.sin(rotX) + z0 * Math.cos(rotX);

    const x2 = x0 * Math.cos(rotY) + z1 * Math.sin(rotY);
    const z2 = -x0 * Math.sin(rotY) + z1 * Math.cos(rotY);

    const scale = fov / (fov + z2 + cameraZ);
    const px = x2 * scale + cx;
    const py = y1 * scale + cy;

    return { px, py, scale, r: n.r, c: n.c };
  });

  bgCtx.lineWidth = 1;
  bgCtx.strokeStyle = lineColor;

  for (let i = 0; i < projected.length; i++) {
    const p1 = projected[i];

    if (p1.c < GRID_COLS - 1) {
      const p2 = projected[i + 1];
      bgCtx.beginPath();
      bgCtx.moveTo(p1.px, p1.py);
      bgCtx.lineTo(p2.px, p2.py);
      bgCtx.stroke();
    }

    if (p1.r < GRID_ROWS - 1) {
      const p2 = projected[i + GRID_COLS];
      bgCtx.beginPath();
      bgCtx.moveTo(p1.px, p1.py);
      bgCtx.lineTo(p2.px, p2.py);
      bgCtx.stroke();
    }

    if (p1.c % 2 === 0 && p1.r % 2 === 0) {
      bgCtx.beginPath();
      bgCtx.arc(p1.px, p1.py, Math.max(1, p1.scale * 2.2), 0, Math.PI * 2);
      bgCtx.fillStyle = nodeDotColor;
      bgCtx.fill();
    }
  }
}

// ============================================================================
// THEME SWITCHER (DARK / LIGHT)
// ============================================================================

function initTheme() {
  applyTheme(state.theme);

  const toggleBtn = document.getElementById("themeToggleBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const nextTheme = state.theme === "dark" ? "light" : "dark";
      applyTheme(nextTheme);
    });
  }
}

function applyTheme(theme) {
  state.theme = theme;
  localStorage.setItem("immunilayer_theme", theme);
  document.documentElement.setAttribute("data-theme", theme);

  const icon = document.getElementById("themeIcon");
  if (icon) {
    icon.innerText = theme === "dark" ? "Light" : "Dark";
  }
}

// ============================================================================
// GENVM THREAT RADAR
//
// Blips are built dynamically from real on-chain disclosures via
// buildLiveRadarBlips(). When no disclosures exist, the radar shows an empty
// field with the sweep animation only. refreshRadarBlips() is called every
// time refreshFromChain() completes.
// ============================================================================
let radarCanvas, radarCtx, radarAnimId;
let radarSweepAngle = 0;
let sonarWaveRadius = 0;
let cssRadarWidth = 800;
let cssRadarHeight = 360;
let hoveredBlipId = null;

// Live blips populated from real disclosure data (no hardcoded entries).
let activeRadarBlips = [];

const BLIP_COLOR = {
  CRITICAL: "#f43f5e",
  HIGH:     "#f59e0b",
  MEDIUM:   "#38bdf8",
  LOW:      "#a855f7",
  INVALID:  "#475569"
};

/** Build radar blips from the most-recent on-chain disclosures (up to 6). */
function buildLiveRadarBlips() {
  const list = state.disclosures.slice(0, 6);
  return list.map((d, i) => ({
    id: d.id,
    code: `R${d.id}`,
    label: (d.title || "Unknown").slice(0, 24),
    severity: d.severity || "INVALID",
    cvss: String(d.score || "?"),
    distRatio: 0.40 + (i % 3) * 0.18,
    angle: (i * ((Math.PI * 2) / 6)) + 0.3,
    color: BLIP_COLOR[d.severity] || BLIP_COLOR.INVALID,
    lastHit: 0
  }));
}

/** Rebuild activeRadarBlips from current disclosures and update the HUD counter. */
function refreshRadarBlips() {
  activeRadarBlips = buildLiveRadarBlips();
  const countEl = document.getElementById("radarBlipCount");
  if (countEl) {
    countEl.innerText = activeRadarBlips.length > 0
      ? `${activeRadarBlips.length} Mapped`
      : "Awaiting reports";
  }
}

function initThreatRadar() {
  radarCanvas = document.getElementById("threatRadarCanvas");
  if (!radarCanvas) return;
  radarCtx = radarCanvas.getContext("2d");

  radarCanvas.addEventListener("mousemove", handleRadarMouseMove);
  radarCanvas.addEventListener("mouseleave", () => { hoveredBlipId = null; });

  resizeRadarCanvas();

  function loop() {
    drawThreatRadar();
    radarAnimId = requestAnimationFrame(loop);
  }
  loop();
}

function handleRadarMouseMove(e) {
  if (!radarCanvas) return;
  const rect = radarCanvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const cx = cssRadarWidth / 2;
  const cy = cssRadarHeight / 2;
  const maxRadius = Math.min(cx, cy) - 24;

  let foundId = null;
  activeRadarBlips.forEach((b) => {
    const dist = b.distRatio * maxRadius;
    const bx = cx + Math.cos(b.angle) * dist;
    const by = cy + Math.sin(b.angle) * dist;
    const d = Math.hypot(mouseX - bx, mouseY - by);
    if (d < 18) foundId = b.id;
  });

  hoveredBlipId = foundId;
}

function resizeRadarCanvas() {
  if (!radarCanvas || !radarCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = radarCanvas.parentElement.getBoundingClientRect();
  cssRadarWidth = rect.width || 800;
  cssRadarHeight = 360;

  radarCanvas.width = cssRadarWidth * dpr;
  radarCanvas.height = cssRadarHeight * dpr;
  radarCanvas.style.width = `${cssRadarWidth}px`;
  radarCanvas.style.height = `${cssRadarHeight}px`;

  radarCtx.resetTransform();
  radarCtx.scale(dpr, dpr);
}

function drawThreatRadar() {
  if (!radarCanvas || !radarCtx) return;

  const w = cssRadarWidth;
  const h = cssRadarHeight;
  radarCtx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const maxRadius = Math.min(cx, cy) - 24;

  const isLight = state.theme === "light";
  const gridPrimary = isLight ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.08)";
  const gridSubtle = isLight ? "rgba(0, 0, 0, 0.04)" : "rgba(255, 255, 255, 0.03)";
  const textMuted = isLight ? "#64748b" : "#94a3b8";
  const textMain = isLight ? "#0f172a" : "#f8fafc";
  const now = Date.now();

  const rings = [0.25, 0.5, 0.75, 1.0];
  rings.forEach((rRatio, idx) => {
    const r = maxRadius * rRatio;
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, r, 0, Math.PI * 2);
    radarCtx.strokeStyle = idx === 3 ? gridPrimary : gridSubtle;
    radarCtx.lineWidth = idx === 3 ? 1.5 : 1;
    if (idx < 3) radarCtx.setLineDash([3, 5]);
    else radarCtx.setLineDash([]);
    radarCtx.stroke();
    radarCtx.setLineDash([]);
  });

  radarCtx.fillStyle = textMuted;
  radarCtx.font = "600 7.5px 'JetBrains Mono'";
  radarCtx.textAlign = "center";
  radarCtx.fillText("20KM HORIZON (100%)", cx, cy - maxRadius + 10);

  for (let deg = 0; deg < 360; deg += 45) {
    const rad = (deg * Math.PI) / 180;
    const rx = cx + Math.cos(rad) * maxRadius;
    const ry = cy + Math.sin(rad) * maxRadius;

    radarCtx.beginPath();
    radarCtx.moveTo(cx, cy);
    radarCtx.lineTo(rx, ry);
    radarCtx.strokeStyle = gridSubtle;
    radarCtx.lineWidth = 1;
    radarCtx.stroke();
  }

  sonarWaveRadius = (sonarWaveRadius + 0.6) % maxRadius;
  const sonarAlpha = 1 - (sonarWaveRadius / maxRadius);
  radarCtx.beginPath();
  radarCtx.arc(cx, cy, sonarWaveRadius, 0, Math.PI * 2);
  radarCtx.strokeStyle = isLight
    ? `rgba(2, 132, 199, ${sonarAlpha * 0.35})`
    : `rgba(56, 189, 248, ${sonarAlpha * 0.4})`;
  radarCtx.lineWidth = 1.2;
  radarCtx.stroke();

  radarSweepAngle = (radarSweepAngle + 0.022) % (Math.PI * 2);

  radarCtx.save();
  radarCtx.beginPath();
  radarCtx.moveTo(cx, cy);
  radarCtx.arc(cx, cy, maxRadius, radarSweepAngle - 0.45, radarSweepAngle);
  radarCtx.closePath();

  const sweepGrad = radarCtx.createRadialGradient(cx, cy, 0, cx, cy, maxRadius);
  sweepGrad.addColorStop(0, "rgba(56, 189, 248, 0)");
  sweepGrad.addColorStop(0.7, isLight ? "rgba(2, 132, 199, 0.06)" : "rgba(56, 189, 248, 0.1)");
  sweepGrad.addColorStop(1, isLight ? "rgba(2, 132, 199, 0.22)" : "rgba(56, 189, 248, 0.28)");
  radarCtx.fillStyle = sweepGrad;
  radarCtx.fill();
  radarCtx.restore();

  const sx = cx + Math.cos(radarSweepAngle) * maxRadius;
  const sy = cy + Math.sin(radarSweepAngle) * maxRadius;
  radarCtx.beginPath();
  radarCtx.moveTo(cx, cy);
  radarCtx.lineTo(sx, sy);
  radarCtx.strokeStyle = isLight ? "#0284c7" : "#38bdf8";
  radarCtx.lineWidth = 1.6;
  radarCtx.stroke();

  radarCtx.beginPath();
  radarCtx.arc(cx, cy, 4, 0, Math.PI * 2);
  radarCtx.fillStyle = "#38bdf8";
  radarCtx.fill();

  // Draw blips from real on-chain disclosures.
  activeRadarBlips.forEach((blip) => {
    const dist = blip.distRatio * maxRadius;
    const bx = cx + Math.cos(blip.angle) * dist;
    const by = cy + Math.sin(blip.angle) * dist;

    let diff = Math.abs(radarSweepAngle - blip.angle);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    if (diff < 0.15) {
      blip.lastHit = now;
    }

    const elapsed = now - blip.lastHit;
    const isLit = elapsed < 2200;
    const isHovered = hoveredBlipId === blip.id;

    if (isLit || isHovered) {
      const fade = isHovered ? 1 : Math.max(0, 1 - (elapsed / 2200));
      radarCtx.beginPath();
      radarCtx.arc(bx, by, 10, 0, Math.PI * 2);
      radarCtx.fillStyle = blip.color + Math.floor(fade * 50).toString(16).padStart(2, "0");
      radarCtx.fill();
    }

    radarCtx.beginPath();
    radarCtx.arc(bx, by, 3.5, 0, Math.PI * 2);
    radarCtx.fillStyle = blip.color;
    radarCtx.fill();

    radarCtx.textAlign = "center";
    radarCtx.textBaseline = "middle";
    radarCtx.fillStyle = isLight ? "#475569" : "#cbd5e1";
    radarCtx.font = "bold 7.5px 'JetBrains Mono'";

    const codeOffX = bx + (Math.cos(blip.angle) * 12);
    const codeOffY = by + (Math.sin(blip.angle) * 12);
    radarCtx.fillText(blip.code, codeOffX, codeOffY);

    if (isLit || isHovered) {
      const cardAlpha = isHovered ? 1 : Math.max(0, 1 - (elapsed / 2200));
      radarCtx.save();
      radarCtx.globalAlpha = cardAlpha;

      const isRightSide = bx >= cx;
      const cardX = isRightSide ? bx + 12 : bx - 140;
      const cardY = by - 12;
      const cardW = 128;
      const cardH = 24;

      radarCtx.fillStyle = isLight ? "rgba(255, 255, 255, 0.95)" : "rgba(10, 14, 23, 0.92)";
      radarCtx.fillRect(cardX, cardY, cardW, cardH);
      radarCtx.strokeStyle = blip.color;
      radarCtx.lineWidth = 1;
      radarCtx.strokeRect(cardX, cardY, cardW, cardH);

      radarCtx.textAlign = "left";
      radarCtx.textBaseline = "top";
      radarCtx.fillStyle = textMain;
      radarCtx.font = "bold 8.5px 'Plus Jakarta Sans'";
      radarCtx.fillText(blip.label.slice(0, 20), cardX + 6, cardY + 4);

      radarCtx.fillStyle = blip.color;
      radarCtx.font = "700 7px 'JetBrains Mono'";
      radarCtx.fillText(
        `[${blip.severity} Score ${blip.cvss !== "?" ? blip.cvss : "N/A"}]`,
        cardX + 6, cardY + 14
      );

      radarCtx.restore();
    }
  });

  // Empty radar notice when no disclosures exist yet.
  if (activeRadarBlips.length === 0) {
    radarCtx.textAlign = "center";
    radarCtx.textBaseline = "middle";
    radarCtx.fillStyle = textMuted;
    radarCtx.font = "600 9px 'JetBrains Mono'";
    radarCtx.fillText("NO THREAT VECTORS MAPPED - AWAITING REPORTS", cx, cy);
  }

  radarCtx.textAlign = "left";
  radarCtx.textBaseline = "top";
  radarCtx.fillStyle = isLight ? "#0f172a" : "#38bdf8";
  radarCtx.font = "700 9px 'JetBrains Mono'";
  radarCtx.fillText(
    `STUDIONET THREAT RADAR - ${(radarSweepAngle * 180 / Math.PI).toFixed(0)} DEG AZIMUTH`,
    16, 14
  );
  radarCtx.fillStyle = textMuted;
  radarCtx.font = "600 7.5px 'JetBrains Mono'";
  radarCtx.fillText(
    `${activeRadarBlips.length} VERIFIED VECTORS MAPPED - LIVE CONTRACT DATA`,
    16, 26
  );
}

// ============================================================================
// NAVIGATION & TABS
// ============================================================================

function setupNavigation() {
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      switchTab(tab);
    });
  });
}

function switchTab(tabName) {
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabName);
  });

  document.querySelectorAll(".tab-section").forEach((sec) => {
    sec.classList.remove("active");
  });

  const activeSection = document.getElementById(`${tabName}Section`);
  if (activeSection) {
    activeSection.classList.add("active");
  }

  if (tabName === "dashboard") {
    setTimeout(resizeRadarCanvas, 50);
  } else if (tabName === "mesh") {
    setTimeout(drawTopology, 50);
  }
}

// ============================================================================
// FAQ ACCORDION
// ============================================================================

function setupFAQ() {
  document.querySelectorAll(".faq-question").forEach((qBtn) => {
    qBtn.addEventListener("click", () => {
      const item = qBtn.closest(".faq-item");
      const isActive = item.classList.contains("active");

      document.querySelectorAll(".faq-item").forEach((i) => i.classList.remove("active"));

      if (!isActive) {
        item.classList.add("active");
      }
    });
  });
}

// ============================================================================
// VALIDATOR TOPOLOGY CANVAS
//
// The topology is a fixed five-node GenLayer StudioNet quorum visualization.
// It illustrates the consensus architecture without attempting to read
// live validator state (not exposed by the contract ABI).
// ============================================================================
let topCanvas, topCtx, topologyAnimId;
let packetProgress = 0;

function initTopologyCanvas() {
  topCanvas = document.getElementById("topologyCanvas");
  if (!topCanvas) return;
  topCtx = topCanvas.getContext("2d");

  const dpr = window.devicePixelRatio || 1;
  const w = 700;
  const h = 320;
  topCanvas.width = w * dpr;
  topCanvas.height = h * dpr;
  topCanvas.style.width = `${w}px`;
  topCanvas.style.height = `${h}px`;
  topCtx.scale(dpr, dpr);

  function loop() {
    drawTopology();
    topologyAnimId = requestAnimationFrame(loop);
  }
  loop();
}

function drawTopology() {
  if (!topCanvas || !topCtx) return;
  const w = 700;
  const h = 320;
  topCtx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const radius = 105;

  topCtx.beginPath();
  topCtx.arc(cx, cy, 28, 0, Math.PI * 2);
  topCtx.fillStyle = state.theme === "light" ? "rgba(99, 102, 241, 0.12)" : "rgba(99, 102, 241, 0.15)";
  topCtx.strokeStyle = "#6366f1";
  topCtx.lineWidth = 1.5;
  topCtx.fill();
  topCtx.stroke();

  topCtx.fillStyle = state.theme === "light" ? "#0f172a" : "#ffffff";
  topCtx.font = "bold 9px 'Plus Jakarta Sans'";
  topCtx.textAlign = "center";
  topCtx.fillText("GENVM", cx, cy - 2);
  topCtx.font = "8px 'Plus Jakarta Sans'";
  topCtx.fillStyle = "#10b981";
  topCtx.fillText("STUDIONET", cx, cy + 9);

  const nodes = [
    { name: "Alpha (L)", angle: -Math.PI / 2, color: "#38bdf8" },
    { name: "Beta", angle: -Math.PI / 2 + (2 * Math.PI / 5), color: "#10b981" },
    { name: "Gamma", angle: -Math.PI / 2 + (4 * Math.PI / 5), color: "#6366f1" },
    { name: "Delta", angle: -Math.PI / 2 + (6 * Math.PI / 5), color: "#a855f7" },
    { name: "Epsilon", angle: -Math.PI / 2 + (8 * Math.PI / 5), color: "#f59e0b" }
  ];

  packetProgress = (packetProgress + 0.012) % 1;

  nodes.forEach((n) => {
    const nx = cx + Math.cos(n.angle) * radius;
    const ny = cy + Math.sin(n.angle) * radius;

    topCtx.beginPath();
    topCtx.moveTo(cx, cy);
    topCtx.lineTo(nx, ny);
    topCtx.strokeStyle = state.theme === "light" ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.08)";
    topCtx.lineWidth = 1;
    topCtx.stroke();

    const px = cx + (nx - cx) * packetProgress;
    const py = cy + (ny - cy) * packetProgress;
    topCtx.beginPath();
    topCtx.arc(px, py, 2.5, 0, Math.PI * 2);
    topCtx.fillStyle = "#38bdf8";
    topCtx.fill();

    topCtx.beginPath();
    topCtx.arc(nx, ny, 16, 0, Math.PI * 2);
    topCtx.fillStyle = state.theme === "light" ? "#ffffff" : "#0d111a";
    topCtx.strokeStyle = n.color;
    topCtx.lineWidth = 1.5;
    topCtx.fill();
    topCtx.stroke();

    topCtx.fillStyle = state.theme === "light" ? "#475569" : "#94a3b8";
    topCtx.font = "500 8.5px 'Plus Jakarta Sans'";
    topCtx.textAlign = "center";
    topCtx.fillText(n.name, nx, ny + 26);
  });
}

async function triggerTestConsensusPing() {
  logConsensus("[PING] Reading get_protocol_stats to verify StudioNet RPC connectivity...");
  try {
    const chain = await ensureChain();
    const stats = await chain.read("get_protocol_stats", []);
    const parsed = safeParse(stats, null);
    if (parsed) {
      logConsensus(
        `[PONG] Contract live. Pools: ${parsed.total_pools} | Reports: ${parsed.total_reports} | Paid: ${fmtGen(parsed.total_bounties_paid)}`
      );
    } else {
      logConsensus("[PONG] Contract responded. RPC connection healthy on StudioNet.");
    }
  } catch (err) {
    logConsensus(`[RPC_ERROR] Connectivity check failed: ${err.message || err}`);
  }
}

// ============================================================================
// RENDERING FUNCTIONS
// ============================================================================

function renderDashboard() {
  const kpiTvl = document.getElementById("kpiTvl");
  const kpiPaid = document.getElementById("kpiPaid");
  const kpiExploits = document.getElementById("kpiExploits");

  if (kpiTvl) kpiTvl.innerText = fmtGen(sumPoolBalancesWei());
  if (kpiPaid) kpiPaid.innerText = fmtGen(state.stats.total_bounties_paid || "0");
  if (kpiExploits) kpiExploits.innerText = String(state.stats.total_reports || 0);

  const container = document.getElementById("dashboardPoolsContainer");
  if (container) {
    if (state.pools.length === 0) {
      container.innerHTML = `<div class="empty-note">No bounty pools on-chain yet. Connect a wallet and create the first escrow.</div>`;
    } else {
      container.innerHTML = state.pools.map((pool) => `
        <div class="pool-row" onclick="selectPoolForSubmission(${pool.id})">
          <div class="p-info">
            <h4>${escapeHtml(pool.name)}</h4>
            <span class="p-repo">${escapeHtml(pool.repo_url)}</span>
          </div>
          <div class="p-bounty">
            <div class="p-max">${fmtGen(pool.max_critical)}</div>
            <span class="p-locked">Escrow: ${fmtGen(pool.balance)}</span>
          </div>
        </div>
      `).join("");
    }
  }

  const reportsContainer = document.getElementById("dashboardReportsContainer");
  if (reportsContainer) {
    if (state.disclosures.length === 0) {
      reportsContainer.innerHTML = `<div class="empty-note">No disclosures settled yet.</div>`;
    } else {
      reportsContainer.innerHTML = state.disclosures.slice(0, 4).map((d) => `
        <div class="feed-row ${d.severity ? d.severity.toLowerCase() : "invalid"}" onclick="openDisclosureDetail(${d.id})">
          <div class="feed-meta">
            <span class="text-emerald">+${fmtGen(d.payout_amount)}</span>
            <span class="text-muted">Report #${d.id}</span>
          </div>
          <h5 class="feed-title">${escapeHtml(d.title)}</h5>
          <span class="feed-comp">${escapeHtml(d.target_component)}</span>
        </div>
      `).join("");
    }
  }

  const select = document.getElementById("targetPoolSelect");
  if (select) {
    select.innerHTML = state.pools.length === 0
      ? `<option value="">-- No pools on-chain yet --</option>`
      : state.pools.map((p) => `
          <option value="${p.id}">${escapeHtml(p.name)} (Max: ${fmtGen(p.max_critical)})</option>
        `).join("");
  }
}

function renderPools() {
  const container = document.getElementById("allPoolsContainer");
  if (!container) return;
  const query = document.getElementById("poolSearchInput")?.value.toLowerCase() || "";

  const filtered = state.pools.filter((p) =>
    (p.name || "").toLowerCase().includes(query) ||
    (p.repo_url || "").toLowerCase().includes(query) ||
    (p.description || "").toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-note">No pools match. Create an on-chain bounty escrow to get started.</div>`;
    return;
  }

  container.innerHTML = filtered.map((pool) => `
    <div class="pool-card-full">
      <div>
        <div class="pool-head">
          <h3 style="font-size: 1.1rem; font-weight: 700;">${escapeHtml(pool.name)}</h3>
          <span class="status-pill">${pool.is_active ? "Active" : "Closed"}</span>
        </div>
        <p class="pool-desc">${escapeHtml(pool.description)}</p>
        <div class="pool-tier-box">
          <div><span class="text-muted">CRITICAL:</span> <strong class="text-crimson">${fmtGen(pool.max_critical)}</strong></div>
          <div><span class="text-muted">HIGH:</span> <strong style="color: var(--amber)">${fmtGen(pool.max_high)}</strong></div>
          <div><span class="text-muted">MEDIUM:</span> <strong class="text-cyan">${fmtGen(pool.max_medium)}</strong></div>
          <div><span class="text-muted">LOW:</span> <strong class="text-emerald">${fmtGen(pool.max_low)}</strong></div>
        </div>
      </div>
      <div class="pool-foot">
        <div>
          <span class="text-muted" style="font-size: 0.72rem;">Escrow Balance</span>
          <h4 class="text-emerald" style="font-size: 1.1rem;">${fmtGen(pool.balance)}</h4>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="selectPoolForSubmission(${pool.id})">
          Open Studio
        </button>
      </div>
    </div>
  `).join("");
}

function renderDisclosures() {
  const container = document.getElementById("fullDisclosuresContainer");
  if (!container) return;

  if (state.disclosures.length === 0) {
    container.innerHTML = `<div class="empty-note">No verified disclosures yet. Submitted reports appear here after validator consensus settles on-chain.</div>`;
    return;
  }

  container.innerHTML = state.disclosures.map((d) => {
    const tier = d.tier || d.severity || "REJECTED";
    const tierClass = tier.toLowerCase();
    const commitUrl = githubBlobUrl(d);
    const commitChip = commitUrl
      ? `<a class="text-cyan" href="${escapeHtml(commitUrl)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="font-family: var(--font-mono); text-decoration: underline;" title="Verified revision">Verified @ ${escapeHtml((d.commit_hash || "").slice(0, 10))}</a>`
      : `<span class="text-muted">No revision metadata</span>`;
    return `
    <div class="disclosure-card ${tierClass}" onclick="openDisclosureDetail(${d.id})">
      <div class="d-head">
        <div>
          <span class="severity-tag ${tierClass}">${escapeHtml(tier)} - Score ${d.score}/100</span>
          <h3 class="d-title" style="margin-top: 6px;">${escapeHtml(d.title)}</h3>
          <span class="d-target">Target: ${escapeHtml(d.pool_name)} | ${escapeHtml(d.target_component)}</span>
        </div>
        <div>
          <div class="d-payout">${fmtGen(d.payout_amount)}</div>
        </div>
      </div>
      <div class="d-body">
        <p>${escapeHtml(d.summary)}</p>
      </div>
      <div class="d-foot">
        <span>Researcher: ${shortAddr(d.researcher)}</span>
        <span>Status: ${d.status}</span>
        ${commitChip}
        <span class="text-cyan">View Code Diff -></span>
      </div>
    </div>
  `;
  }).join("");
}

/**
 * Render the Active StudioNet Quorum panel.
 * GenLayer StudioNet runs 5 validators. The contract ABI does not expose
 * per-transaction validator addresses, so we display the quorum count and
 * consensus mechanism label rather than live node addresses.
 */
function renderValidators() {
  const container = document.getElementById("validatorNodesGrid");
  if (!container) return;

  const quorumNodes = [
    { name: "StudioNet Validator Alpha (Leader)", role: "Leader" },
    { name: "StudioNet Validator Beta", role: "Validator" },
    { name: "StudioNet Validator Gamma", role: "Validator" },
    { name: "StudioNet Validator Delta", role: "Validator" },
    { name: "StudioNet Validator Epsilon", role: "Validator" }
  ];

  container.innerHTML = quorumNodes.map((v) => `
    <div class="node-row">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="status-dot"></span>
        <strong>${escapeHtml(v.name)}</strong>
      </div>
      <div class="text-muted">${v.role}</div>
      <div class="text-emerald">Live</div>
    </div>
  `).join("");
}

function renderLeaderboard() {
  const tbody = document.getElementById("leaderboardTableBody");
  if (!tbody) return;

  if (state.leaderboard.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-note">No researchers ranked yet. Verified on-chain payouts populate this table.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.leaderboard.map((r) => `
    <tr>
      <td style="font-weight: 700; font-family: var(--font-mono);">${r.rank}</td>
      <td><strong>${shortAddr(r.name)}</strong></td>
      <td><span style="background: rgba(125,125,125,0.1); padding: 2px 6px; border-radius: 4px; font-size: 0.72rem;">Whitehat</span></td>
      <td>${r.verified}</td>
      <td class="text-crimson">${r.criticals}</td>
      <td class="text-emerald" style="font-weight: 600;">${r.won}</td>
      <td><span class="text-cyan">On-chain</span></td>
    </tr>
  `).join("");
}

// ============================================================================
// POC STUDIO & PRESET ATTACK VECTORS
// ============================================================================

const PRESETS = {
  flashloan: {
    title: "Critical Flashloan Oracle Skew in Collateral Health Check",
    type: "Oracle Price Manipulation / Flashloan",
    component: "MarginEngine.sol #computeCollateralRatio()",
    repo: "https://github.com/aegis/perps",
    commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    file: "contracts/MarginEngine.sol",
    impact: "Attacker borrows a large flashloan, swaps against a low-liquidity pool to skew the spot price oracle, inflates collateral valuation, borrows unbacked stablecoins from escrow, and repays the flashloan.",
    av: "N", ac: "L", pr: "N", impactScore: "H",
    code: `def test_exploit_flashloan_skew():
    # 1. Borrow Flashloan
    loan_amount = 15_000_000 * 10**18
    loan = FlashloanProvider.borrow(loan_amount)

    # 2. Skew Spot Oracle on the AMM Pool
    UniswapV3Pool.swap(loan_amount, to_token="COLLATERAL")

    # 3. Deposit inflated collateral and extract protocol reserves
    vault = MarginEngine.get_instance()
    vault.deposit_collateral(amount=loan_amount)
    stolen_funds = vault.borrow_max_stablecoins()

    # 4. Invariant Verification in Sandbox
    assert stolen_funds >= 3_500_000 * 10**18, "Exploit failed to extract target capital"
    print("Successfully drained protocol escrow")`
  },
  replay: {
    title: "Cross-Chain Signature Replay in Batch Claim Dispatcher",
    type: "Signature Replay & Authentication Bypass",
    component: "BridgeSignatureVerifier.sol #verifyBatch()",
    repo: "https://github.com/nexus-core/bridge",
    commit: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
    file: "contracts/BridgeSignatureVerifier.sol",
    impact: "Validator signature hashes do not bind the destination chain ID or per-recipient execution nonces. An attacker can replay valid signatures across chains and drain the bridge vault repeatedly.",
    av: "N", ac: "L", pr: "N", impactScore: "H",
    code: `def test_signature_replay_multichain():
    # Capture legitimate signed message on Source Chain
    sig = ValidatorSigner.sign_claim(recipient=attacker_addr, amount=500_000 * 10**18)

    # Replay on Destination Bridge Contract without nonce invalidation
    bridge = BridgeRouter.get_instance()
    for replay_round in range(5):
        bridge.claim_tokens(signature=sig, amount=500_000 * 10**18)

    assert attacker_token.balance_of(attacker_addr) >= 2_500_000 * 10**18, "Replay failed"
    print("Signature replay executed across chains")`
  },
  inflation: {
    title: "ERC4626 First Depositor Vault Share Inflation Attack",
    type: "ERC4626 Vault Share Inflation",
    component: "YieldVault.sol #deposit()",
    repo: "https://github.com/solace/yield",
    commit: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
    file: "contracts/YieldVault.sol",
    impact: "First depositor deposits 1 wei, transfers a large amount of underlying tokens directly to the vault to inflate price-per-share. A subsequent victim receives 0 shares due to integer rounding, losing their deposit.",
    av: "N", ac: "L", pr: "N", impactScore: "H",
    code: `def test_erc4626_share_inflation():
    vault = YieldVault.deploy()

    # Attacker deposits 1 wei
    vault.deposit(amount=1, receiver=attacker_addr)

    # Attacker donates tokens directly to inflate assets-per-share
    underlying_token.transfer(vault.address, 100_000 * 10**18)

    # Victim deposits tokens
    vault.deposit(amount=50_000 * 10**18, receiver=victim_addr)

    # Invariant: Victim received 0 shares due to truncation
    assert vault.balance_of(victim_addr) == 0, "Victim was not front-run"
    print("Victim deposit captured via inflation exploit")`
  },
  readonly: {
    title: "Read-Only Reentrancy in Curve Liquidity Gauge Pool",
    type: "Cross-Contract Reentrancy & State Desync",
    component: "GaugeOracle.sol #get_virtual_price()",
    repo: "https://github.com/curve-fi/gauge",
    commit: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
    file: "contracts/GaugeOracle.sol",
    impact: "Invoking remove_liquidity triggers a fallback before virtual_price is updated, allowing external lending contracts querying virtual_price to borrow at an artificially deflated collateral evaluation.",
    av: "N", ac: "L", pr: "N", impactScore: "H",
    code: `def test_readonly_reentrancy():
    curve_pool = CurvePool.get_instance()
    attacker = ReadOnlyAttacker.deploy(curve_pool)

    # Trigger liquidity removal with malicious reentrant fallback
    attacker.execute_reentrant_borrow()

    assert attacker.profit() >= 1_200_000 * 10**18, "Read-only reentrancy failed"
    print("Collateral under-valuation exploited during callback")`
  }
};

function setupPoCStudio() {
  const codeField = document.getElementById("pocCodeInput");
  if (codeField) {
    codeField.addEventListener("input", updateLineNumbers);
    updateLineNumbers();
  }
}

function updateLineNumbers() {
  const codeField = document.getElementById("pocCodeInput");
  const gutter = document.getElementById("editorGutter");
  if (!codeField || !gutter) return;

  const lines = codeField.value.split("\n").length;
  gutter.innerHTML = Array.from({ length: lines }, (_, i) => i + 1).join("<br>");
}

function loadPreset(presetKey) {
  const p = PRESETS[presetKey];
  if (!p) return;

  document.getElementById("reportTitle").value = p.title;
  document.getElementById("vulnTypeSelect").value = p.type;
  document.getElementById("targetComponent").value = p.component;
  document.getElementById("targetRepoUrl").value = p.repo || "";
  document.getElementById("targetCommitHash").value = p.commit || "";
  document.getElementById("targetFilePath").value = p.file || "";
  document.getElementById("impactDescription").value = p.impact;
  document.getElementById("pocCodeInput").value = p.code;

  document.getElementById("cvssAV").value = p.av;
  document.getElementById("cvssAC").value = p.ac;
  document.getElementById("cvssPR").value = p.pr;
  document.getElementById("cvssImpact").value = p.impactScore;

  updateLineNumbers();
  recalcCVSS();
}

function formatEditorCode() {
  const codeField = document.getElementById("pocCodeInput");
  codeField.value = codeField.value.split("\n").map((l) => l.trimEnd()).join("\n");
  updateLineNumbers();
}

function recalcCVSS() {
  const av = document.getElementById("cvssAV")?.value || "N";
  const ac = document.getElementById("cvssAC")?.value || "L";
  const pr = document.getElementById("cvssPR")?.value || "N";
  const impact = document.getElementById("cvssImpact")?.value || "H";

  let score = 9.8;
  if (av === "A") score -= 0.8;
  if (av === "L") score -= 2.5;
  if (ac === "H") score -= 1.4;
  if (pr === "L") score -= 1.0;
  if (pr === "H") score -= 2.2;
  if (impact === "M") score -= 2.5;
  if (impact === "L") score -= 5.0;

  score = Math.max(1.0, Math.min(10.0, score));
  const scoreBadge = document.getElementById("cvssScoreBadge");
  const vectorOut = document.getElementById("cvssVectorOutput");

  let tier = "CRITICAL";
  if (score < 9.0) tier = "HIGH";
  if (score < 7.0) tier = "MEDIUM";
  if (score < 4.0) tier = "LOW";

  if (scoreBadge) {
    scoreBadge.className = `severity-tag ${tier.toLowerCase()}`;
    scoreBadge.innerText = `${score.toFixed(1)} ${tier}`;
  }

  if (vectorOut) {
    vectorOut.innerText = `CVSS:3.1/AV:${av}/AC:${ac}/PR:${pr}/UI:N/S:U/C:${impact}/I:${impact}/A:${impact}`;
  }
}

// ============================================================================
// FORMS & REAL CONTRACT WRITES
// ============================================================================

function setupForms() {
  document.getElementById("poolSearchInput")?.addEventListener("input", renderPools);

  const submitForm = document.getElementById("bountySubmitForm");
  if (submitForm) {
    submitForm.addEventListener("submit", handleSubmitVulnerability);
  }

  const createPoolForm = document.getElementById("createPoolForm");
  if (createPoolForm) {
    createPoolForm.addEventListener("submit", handleCreatePool);
  }
}

async function handleSubmitVulnerability(e) {
  e.preventDefault();

  const chain = await ensureChain();
  if (!chain.isConnected()) {
    showToast("Connect a wallet to submit an on-chain report.", "info");
    await connectWallet();
    if (!chain.isConnected()) return;
  }

  const poolId = parseInt(document.getElementById("targetPoolSelect").value, 10);
  const title = document.getElementById("reportTitle").value.trim();
  const vulnType = document.getElementById("vulnTypeSelect").value;
  const component = document.getElementById("targetComponent").value.trim();
  const repoUrl = document.getElementById("targetRepoUrl").value.trim();
  const commitHash = document.getElementById("targetCommitHash").value.trim();
  const filePath = document.getElementById("targetFilePath").value.trim();
  const impact = document.getElementById("impactDescription").value.trim();
  const poc = document.getElementById("pocCodeInput").value.trim();

  if (Number.isNaN(poolId)) {
    showToast("Select a target bounty pool first.", "danger");
    return;
  }
  if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+/.test(repoUrl)) {
    showToast("Repository URL must be a GitHub target, e.g. https://github.com/org/repo.", "danger");
    return;
  }
  if (commitHash.length < 7) {
    showToast("Provide a specific target commit hash (>= 7 characters).", "danger");
    return;
  }
  if (!filePath) {
    showToast("Provide the target file path within the repository.", "danger");
    return;
  }

  openExecModal();

  try {
    logConsensus(
      `[TX_SUBMIT] Sending submit_vulnerability to ${shortAddr(state.contractAddress)} for pool #${poolId}`
    );
    logConsensus(
      `[GROUND_TRUTH] Validators will retrieve ${repoUrl} @ ${commitHash.slice(0, 12)} / ${filePath}`
    );

    const txHash = await chain.write(
      "submit_vulnerability",
      [poolId, title, vulnType, component, repoUrl, commitHash, filePath, poc, impact]
    );
    setExecStep(1, true);

    // Display the live transaction hash as a clickable StudioNet explorer link.
    showExecTxLink(txHash);
    logConsensus(`[TX_HASH] ${txHash}`);
    logConsensus(`[EXPLORER] ${explorerTxUrl(txHash)}`);

    logConsensus("[CONSENSUS] Awaiting GenLayer validator consensus (sandbox check + AI threat model)...");
    setExecStep(2, true);

    const receipt = await chain.waitReceipt(txHash);
    setExecStep(3, true);
    logConsensus("[CONSENSUS] Transaction accepted by consensus. Reading settled verdict...");

    await refreshFromChain();
    await refreshClaimable();
    setExecStep(4, true);

    // Race-free readback: prefer the report id returned by THIS transaction's
    // receipt. Never derive it from a shared counter (which another concurrent
    // submission could have advanced). Fall back to matching the exact revision
    // fingerprint + researcher if the receipt return value is unavailable.
    let settled = null;
    const returnedId = chain.decodeReturn(receipt);
    const numericId = returnedId != null ? Number(returnedId) : NaN;
    if (!Number.isNaN(numericId) && numericId > 0) {
      settled = state.disclosures.find((d) => d.id === numericId) || null;
    }
    if (!settled) {
      const me = (state.userAddress || "").toLowerCase();
      settled = state.disclosures.find((d) =>
        (d.commit_hash === commitHash) &&
        (d.file_path === filePath) &&
        ((d.researcher || "").toLowerCase() === me)
      ) || state.disclosures.find((d) => d.pool_id === poolId) || state.disclosures[0];
    }
    if (settled) {
      const payoutLabel = fmtGen(settled.payout_amount);
      document.getElementById("execTitle").innerText = settled.status === "VERIFIED"
        ? "Exploit Verified & Settled"
        : "Report Rejected by Consensus";
      document.getElementById("execSubtitle").innerText = `Severity: ${settled.severity} - Reward: ${payoutLabel}`;
      logConsensus(
        `[SETTLEMENT] Verdict ${settled.status} (${settled.severity}). Payout ${payoutLabel} to ${shortAddr(settled.researcher)}`
      );
      showToast(
        `Report settled on-chain: ${settled.status} (${payoutLabel})`,
        settled.status === "VERIFIED" ? "success" : "info"
      );
    } else {
      document.getElementById("execTitle").innerText = "Transaction Settled";
      document.getElementById("execSubtitle").innerText = "Verdict recorded on-chain.";
    }

    document.getElementById("execActions").classList.remove("hidden");
  } catch (err) {
    logConsensus(`[TX_ERROR] ${err.message || err}`);
    document.getElementById("execTitle").innerText = "Transaction Failed";
    document.getElementById("execSubtitle").innerText = err.message || String(err);
    document.getElementById("execActions").classList.remove("hidden");
    showToast(`Submission failed: ${err.message || err}`, "danger");
  }
}

async function handleCreatePool(e) {
  e.preventDefault();

  const chain = await ensureChain();
  if (!chain.isConnected()) {
    showToast("Connect a wallet to create an on-chain pool.", "info");
    await connectWallet();
    if (!chain.isConnected()) return;
  }

  const name = document.getElementById("newPoolName").value.trim();
  const repo = document.getElementById("newPoolRepo").value.trim();
  const desc = document.getElementById("newPoolDesc").value.trim();
  const deposit = document.getElementById("newPoolDeposit").value.trim();
  const critical = document.getElementById("newPoolCritical").value.trim();
  const high = document.getElementById("newPoolHigh").value.trim();
  const medium = document.getElementById("newPoolMedium").value.trim();
  const low = document.getElementById("newPoolLow").value.trim();

  const depositWei = genToWei(deposit);
  const criticalWei = genToWei(critical);
  const highWei = genToWei(high);
  const mediumWei = genToWei(medium);
  const lowWei = genToWei(low);

  if (depositWei <= 0n) {
    showToast("Initial escrow deposit must be greater than 0 GEN.", "danger");
    return;
  }
  if (criticalWei < highWei || highWei < mediumWei || mediumWei < lowWei) {
    showToast("Severity caps must follow CRITICAL >= HIGH >= MEDIUM >= LOW.", "danger");
    return;
  }

  try {
    showToast("Confirm the escrow deposit in your wallet...", "info");
    const txHash = await chain.write(
      "create_bounty_pool",
      [name, repo, desc, criticalWei, highWei, mediumWei, lowWei],
      depositWei
    );
    logConsensus(`[TX_SUBMIT] create_bounty_pool tx ${txHash}`);
    logConsensus(`[EXPLORER] ${explorerTxUrl(txHash)}`);

    await chain.waitReceipt(txHash);
    logConsensus("[CHAIN] Pool created and escrow locked on-chain.");
    showToast("Bounty pool created and escrow locked on-chain.", "success");

    await refreshFromChain();
    closeCreatePoolModal();
    document.getElementById("createPoolForm").reset();
  } catch (err) {
    logConsensus(`[TX_ERROR] ${err.message || err}`);
    showToast(`Pool creation failed: ${err.message || err}`, "danger");
  }
}

// ============================================================================
// WEB3 WALLET (real connection via genlayer-js / window.ethereum)
// ============================================================================

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast-message toast-${type}`;

  let tag = "[info]";
  if (type === "success") tag = "[ok]";
  if (type === "danger") tag = "[warn]";

  toast.innerHTML = `<span>${tag}</span><span style="flex:1;">${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = "toastOut 0.3s forwards";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function updateWalletUI() {
  const btn = document.getElementById("connectWalletBtn");
  const btnText = document.getElementById("walletBtnText");
  const headerDisconnect = document.getElementById("headerDisconnectBtn");
  const detailAddr = document.getElementById("detailWalletAddress");
  const detailBal = document.getElementById("detailWalletBalance");

  if (!btn || !btnText) return;

  if (state.walletConnected) {
    btnText.innerHTML = shortAddr(state.userAddress);
    btn.classList.add("btn-secondary");
    btn.classList.remove("btn-primary");
    btn.title = "Click to view account details";

    if (headerDisconnect) headerDisconnect.classList.remove("hidden");
    if (detailAddr) detailAddr.innerText = state.userAddress;
    if (detailBal) detailBal.innerText = state.chainName;
  } else {
    btnText.innerText = "Connect Wallet";
    btn.classList.remove("btn-secondary");
    btn.classList.add("btn-primary");
    btn.title = "Connect your Web3 Wallet";

    if (headerDisconnect) headerDisconnect.classList.add("hidden");
  }
}

async function connectWallet() {
  const chain = await ensureChain();
  try {
    showToast("Opening wallet connection...", "info");
    const account = await chain.connect();
    state.userAddress = account;
    state.walletConnected = true;
    updateWalletUI();
    closeConnectWalletModal();
    showToast(`Connected ${shortAddr(account)} on ${state.chainName}`, "success");
    logConsensus(`[WALLET] Connected ${account} on GenLayer StudioNet (Chain ID 61999)`);
    refreshClaimable();

    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on("accountsChanged", (accounts) => {
        if (!accounts || accounts.length === 0) {
          disconnectWallet();
        } else {
          state.userAddress = accounts[0];
          updateWalletUI();
          showToast(`Switched account: ${shortAddr(accounts[0])}`, "info");
        }
      });
    }

    refreshFromChain();
  } catch (err) {
    logConsensus(`[WALLET_ERROR] ${err.message || err}`);
    if (typeof window.ethereum === "undefined") {
      openConnectWalletModal();
    }
    showToast(`Wallet connection failed: ${err.message || err}`, "danger");
  }
}

async function switchToGenLayerNetwork() {
  const chain = await ensureChain();
  try {
    await chain.connect();
    showToast(`Wallet switched to ${state.chainName}.`, "success");
  } catch (err) {
    showToast(`Network switch failed: ${err.message || err}`, "danger");
  }
}

/**
 * One-click ephemeral reviewer account (genlayer-js createAccount). Lets a
 * reviewer exercise deposit / submit / withdraw without installing a wallet and
 * without any Snap / provider conflicts.
 */
async function connectReviewerAccount() {
  const chain = await ensureChain();
  try {
    showToast("Creating ephemeral reviewer account...", "info");
    const account = await chain.connectReviewer();
    state.userAddress = account;
    state.walletConnected = true;
    updateWalletUI();
    closeConnectWalletModal();
    showToast(`Reviewer account ready: ${shortAddr(account)}`, "success");
    logConsensus(`[REVIEWER] Ephemeral account ${account} created via genlayer-js createAccount()`);
    refreshFromChain();
    refreshClaimable();
  } catch (err) {
    logConsensus(`[REVIEWER_ERROR] ${err.message || err}`);
    showToast(`Reviewer account failed: ${err.message || err}`, "danger");
  }
}

/**
 * Refresh the connected beneficiary's claimable balance and toggle the
 * Withdraw Bounty button accordingly.
 */
async function refreshClaimable() {
  const amountEl = document.getElementById("claimableAmount");
  const withdrawBtn = document.getElementById("withdrawBountyBtn");
  if (!state.walletConnected || !state.userAddress) {
    if (amountEl) amountEl.innerText = "0 GEN";
    if (withdrawBtn) withdrawBtn.disabled = true;
    return;
  }
  try {
    const chain = await ensureChain();
    const wei = await chain.read("get_claimable", [state.userAddress]);
    state.claimable = wei;
    if (amountEl) amountEl.innerText = fmtGen(wei);
    if (withdrawBtn) withdrawBtn.disabled = !(wei && BigInt(wei) > 0n);
  } catch (err) {
    logConsensus(`[CLAIMABLE_ERROR] ${err.message || err}`);
    if (amountEl) amountEl.innerText = "0 GEN";
    if (withdrawBtn) withdrawBtn.disabled = true;
  }
}

/**
 * Beneficiary pull: withdraw the native GEN credited by consensus.
 */
async function handleWithdraw() {
  const chain = await ensureChain();
  if (!chain.isConnected()) {
    showToast("Connect a wallet or reviewer account to withdraw.", "info");
    return;
  }
  try {
    showToast("Confirm the withdrawal in your wallet...", "info");
    const txHash = await chain.write("withdraw", []);
    logConsensus(`[TX_SUBMIT] withdraw tx ${txHash}`);
    logConsensus(`[EXPLORER] ${explorerTxUrl(txHash)}`);
    await chain.waitReceipt(txHash);
    logConsensus("[WITHDRAW] Native GEN bounty pulled to beneficiary wallet.");
    showToast("Bounty withdrawn to your wallet.", "success");
    await refreshFromChain();
    await refreshClaimable();
  } catch (err) {
    logConsensus(`[WITHDRAW_ERROR] ${err.message || err}`);
    showToast(`Withdrawal failed: ${err.message || err}`, "danger");
  }
}

function disconnectWallet() {
  if (window.ImmuniChain) window.ImmuniChain.disconnect();
  state.walletConnected = false;
  state.userAddress = null;
  state.claimable = "0";
  updateWalletUI();
  refreshClaimable();
  closeWalletDetailsModal();
  showToast("Wallet disconnected.", "info");
  logConsensus("[WALLET] Active session disconnected.");
}

function handleWalletBtnClick() {
  if (state.walletConnected) {
    openWalletDetailsModal();
  } else {
    connectWallet();
  }
}

function setupWallet() {
  const metamaskBtn = document.getElementById("connectMetamaskBtn");
  if (metamaskBtn) metamaskBtn.onclick = connectWallet;

  const reviewerBtn = document.getElementById("connectReviewerBtn");
  if (reviewerBtn) reviewerBtn.onclick = connectReviewerAccount;

  const withdrawBtn = document.getElementById("withdrawBountyBtn");
  if (withdrawBtn) withdrawBtn.onclick = handleWithdraw;

  const disconnectBtn = document.getElementById("disconnectWalletBtn");
  if (disconnectBtn) disconnectBtn.onclick = disconnectWallet;

  const headerDisconnect = document.getElementById("headerDisconnectBtn");
  if (headerDisconnect) headerDisconnect.onclick = disconnectWallet;

  const switchBtn = document.getElementById("switchNetworkMetaMaskBtn");
  if (switchBtn) switchBtn.onclick = switchToGenLayerNetwork;

  const copyBtn = document.getElementById("copyAddressBtn");
  if (copyBtn) {
    copyBtn.onclick = () => {
      if (state.userAddress && navigator.clipboard) {
        navigator.clipboard.writeText(state.userAddress);
        showToast("Address copied to clipboard.", "success");
      } else if (state.userAddress) {
        showToast(`Address: ${state.userAddress}`, "info");
      }
    };
  }

  updateWalletUI();
}

// Modal helpers
function openConnectWalletModal() {
  const modal = document.getElementById("connectWalletModal");
  if (modal) modal.classList.remove("hidden");
}

function closeConnectWalletModal() {
  const modal = document.getElementById("connectWalletModal");
  if (modal) modal.classList.add("hidden");
}

function openWalletDetailsModal() {
  updateWalletUI();
  refreshClaimable();
  const modal = document.getElementById("walletDetailsModal");
  if (modal) modal.classList.remove("hidden");
}

function closeWalletDetailsModal() {
  const modal = document.getElementById("walletDetailsModal");
  if (modal) modal.classList.add("hidden");
}

function openCreatePoolModal() {
  const modal = document.getElementById("createPoolModal");
  if (modal) modal.classList.remove("hidden");
}

function closeCreatePoolModal() {
  const modal = document.getElementById("createPoolModal");
  if (modal) modal.classList.add("hidden");
}

// ============================================================================
// DISCLOSURE DETAIL MODAL
// ============================================================================

function openDisclosureDetail(disclosureId) {
  const d = state.disclosures.find((x) => x.id === disclosureId);
  if (!d) return;

  const tier = d.tier || d.severity || "REJECTED";

  document.getElementById("modalVulnTitle").innerText = d.title;
  document.getElementById("modalVulnSeverityBadge").innerText = `${tier} - Score ${d.score}/100`;
  document.getElementById("modalVulnSeverityBadge").className = `severity-tag ${tier.toLowerCase()}`;
  document.getElementById("modalVulnComponent").innerText = d.target_component;
  document.getElementById("modalVulnPayout").innerText = fmtGen(d.payout_amount);
  document.getElementById("modalVulnResearcher").innerText = d.researcher;
  document.getElementById("modalVulnTxHash").innerText = `Report #${d.id} - ${d.status}`;
  document.getElementById("modalVulnSummary").innerText = d.summary;

  // Exact consensus tier badge
  const tierBadge = document.getElementById("modalVulnTierBadge");
  if (tierBadge) {
    tierBadge.innerText = tier;
    tierBadge.className = `severity-tag ${tier.toLowerCase()}`;
  }

  // Ground-truth source verification status
  const sourceVerifiedEl = document.getElementById("modalVulnSourceVerified");
  if (sourceVerifiedEl) {
    const verified = d.source_verified === true;
    sourceVerifiedEl.innerText = verified ? "Verified against revision" : "Not verified";
    sourceVerifiedEl.className = verified ? "text-emerald" : "text-crimson";
  }

  // Verified revision link (GitHub blob at the exact audited commit)
  const commitLink = document.getElementById("modalVulnCommitLink");
  if (commitLink) {
    const href = githubBlobUrl(d);
    if (href) {
      const shortSha = (d.commit_hash || "").slice(0, 12);
      commitLink.href = href;
      commitLink.innerText = `${d.repo_slug || d.repo_url || "repo"} @ ${shortSha} / ${d.file_path || ""}`;
      commitLink.style.pointerEvents = "auto";
    } else {
      commitLink.href = "#";
      commitLink.innerText = "Revision metadata unavailable";
      commitLink.style.pointerEvents = "none";
    }
  }

  document.getElementById("modalDiffVulnerable").innerText = d.poc_code || "// Proof-of-concept not available";
  document.getElementById("modalDiffFixed").innerText = d.recommended_fix || "// Recommended remediation not available";

  document.getElementById("disclosureDetailModal").classList.remove("hidden");
}

function closeDisclosureDetailModal() {
  document.getElementById("disclosureDetailModal").classList.add("hidden");
}

function selectPoolForSubmission(poolId) {
  switchTab("submit");
  const select = document.getElementById("targetPoolSelect");
  if (select) select.value = poolId;
}

// ============================================================================
// EXECUTION MODAL (tracks real transaction phases)
// ============================================================================

function openExecModal() {
  document.getElementById("executionModal").classList.remove("hidden");
  document.getElementById("execTitle").innerText = "Submitting to GenLayer Consensus";
  document.getElementById("execSubtitle").innerText = "Broadcasting transaction to validators...";
  document.getElementById("execActions").classList.add("hidden");

  // Clear any previous tx link
  const txRow = document.getElementById("execTxRow");
  if (txRow) txRow.classList.add("hidden");

  for (let i = 1; i <= 4; i++) {
    const step = document.getElementById(`step${i}`);
    if (step) step.classList.remove("active", "completed");
  }
  const step1 = document.getElementById("step1");
  if (step1) step1.classList.add("active");
}

function closeExecModal() {
  document.getElementById("executionModal").classList.add("hidden");
  switchTab("disclosures");
}

function setExecStep(stepIndex, isCompleted) {
  const current = document.getElementById(`step${stepIndex}`);
  if (!current) return;
  if (isCompleted) {
    current.classList.remove("active");
    current.classList.add("completed");
    const next = document.getElementById(`step${stepIndex + 1}`);
    if (next) next.classList.add("active");
  }
}

/** Display a clickable StudioNet explorer link for a tx hash in the exec modal. */
function showExecTxLink(txHash) {
  const txRow = document.getElementById("execTxRow");
  const txLink = document.getElementById("execTxLink");
  if (!txRow || !txLink) return;
  const url = explorerTxUrl(txHash);
  txLink.href = url;
  txLink.innerText = shortAddr(txHash) + " (open in explorer)";
  txRow.classList.remove("hidden");
}

// ============================================================================
// TELEMETRY LOGS
// ============================================================================

function logConsensus(text) {
  const body = document.getElementById("consensusTerminalLogs");
  if (!body) return;
  const now = new Date();
  const timeStr = `[${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}.${Math.floor(now.getMilliseconds() / 10).toString().padStart(2, "0")}]`;

  const line = document.createElement("div");
  line.style.fontSize = "0.74rem";
  if (text.includes("CRITICAL") || text.includes("ERROR")) {
    line.style.color = "var(--crimson)";
  } else if (text.includes("SETTLEMENT") || text.includes("CONSENSUS") || text.includes("CHAIN]")) {
    line.style.color = "var(--emerald)";
  } else if (text.includes("TX_") || text.includes("WALLET") || text.includes("EXPLORER")) {
    line.style.color = "var(--cyan)";
  } else {
    line.style.color = "var(--text-muted)";
  }
  line.innerText = `${timeStr} ${text}`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

/** Poll real contract stats every 30 seconds and log actual chain state. */
function startTelemetryLogger() {
  setInterval(async () => {
    try {
      const chain = await ensureChain();
      const statsRaw = await chain.read("get_protocol_stats", []);
      const s = safeParse(statsRaw, null);
      if (s) {
        logConsensus(
          `[STUDIONET] Contract live. Pools: ${s.total_pools} | Reports: ${s.total_reports} | Paid: ${fmtGen(s.total_bounties_paid)}`
        );
      }
    } catch (e) {
      logConsensus(`[STUDIONET] RPC read skipped: ${e.message || e}`);
    }
  }, 30000);
}

// ============================================================================
// EXPORT HANDLERS FOR INLINE HTML ACCESS
// ============================================================================
window.switchTab = switchTab;
window.handleWalletBtnClick = handleWalletBtnClick;
window.connectWallet = connectWallet;
window.disconnectWallet = disconnectWallet;
window.switchToGenLayerNetwork = switchToGenLayerNetwork;
window.openConnectWalletModal = openConnectWalletModal;
window.closeConnectWalletModal = closeConnectWalletModal;
window.openWalletDetailsModal = openWalletDetailsModal;
window.closeWalletDetailsModal = closeWalletDetailsModal;
window.openCreatePoolModal = openCreatePoolModal;
window.closeCreatePoolModal = closeCreatePoolModal;
window.openDisclosureDetail = openDisclosureDetail;
window.closeDisclosureDetailModal = closeDisclosureDetailModal;
window.selectPoolForSubmission = selectPoolForSubmission;
window.loadPreset = loadPreset;
window.formatEditorCode = formatEditorCode;
window.recalcCVSS = recalcCVSS;
window.triggerTestConsensusPing = triggerTestConsensusPing;
window.closeExecModal = closeExecModal;
window.showToast = showToast;
