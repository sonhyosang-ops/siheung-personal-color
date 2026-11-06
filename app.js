import { SEASONS, TYPES, TYPE_CODES, CODE_TYPES, PALETTE_NAMES } from "./data.js";
import { analyze, sampleRegions, whiteBalanceFrom } from "./analysis.js";

// ─────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────
const MAX_SIDE = 720;            // 분석용 사진 최대 변 길이(px)
const IDLE_WIPE_MS = 5 * 60 * 1000; // 5분 동안 조작이 없으면 사진·결과 삭제

// ─────────────────────────────────────────────
// 상태 (메모리에만 존재)
// ─────────────────────────────────────────────
let state = freshState();
function freshState() {
  return {
    group: "elem",         // elem | teen
    stream: null,          // 카메라 스트림
    imgData: null,         // 분석용 ImageData
    oval: null,            // {cx, cy, rx, ry} (사진 픽셀 좌표)
    wb: null,              // 화이트밸런스 계수
    wbMode: false,
    result: null,
    shared: false,         // QR로 열린 결과 페이지인지
  };
}

const $ = (id) => document.getElementById(id);
const screens = ["start", "capture", "check", "result"];
function show(name) {
  for (const s of screens) $(`screen-${s}`).classList.toggle("active", s === name);
  window.scrollTo(0, 0);
}
function toast(msg, ms = 3400) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

// ─────────────────────────────────────────────
// 시작 화면
// ─────────────────────────────────────────────
for (const btn of document.querySelectorAll(".group-btn")) {
  btn.addEventListener("click", () => {
    state.group = btn.dataset.group;
    openCamera();
  });
}

// ─────────────────────────────────────────────
// 카메라
// ─────────────────────────────────────────────
async function openCamera() {
  show("capture");
  $("cam-error").hidden = true;
  const video = $("cam");
  if (!navigator.mediaDevices?.getUserMedia) { camFailed("이 브라우저는 카메라를 지원하지 않아요. 앨범에서 사진을 골라 주세요."); return; }
  try {
    stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch (e) {
    camFailed("카메라를 켤 수 없어요. 카메라 권한을 허용했는지 확인하거나, 앨범에서 사진을 골라 주세요.");
  }
}
function camFailed(msg) {
  const el = $("cam-error");
  el.textContent = msg;
  el.hidden = false;
  $("btn-shutter").disabled = true;
}
function stopCamera() {
  if (state.stream) { for (const t of state.stream.getTracks()) t.stop(); }
  state.stream = null;
  const v = $("cam");
  v.pause?.();
  v.srcObject = null;
}
$("btn-cap-back").addEventListener("click", () => { stopCamera(); wipeAndRestart(false); });

$("btn-shutter").addEventListener("click", () => {
  const video = $("cam");
  if (!video.videoWidth) { toast("카메라가 아직 준비 중이에요. 잠시만요!"); return; }
  const c = document.createElement("canvas");
  const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  const ctx = c.getContext("2d");
  // 미리보기와 같은 방향(거울)으로 저장
  ctx.translate(c.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, c.width, c.height);
  stopCamera();
  // 촬영 화면의 타원 안내선과 같은 위치로 기본 타원 설정
  const ovalFromGuide = guideOvalFor(c.width, c.height);
  loadPhoto(c, ovalFromGuide);
});

// 촬영 화면 안내 타원(CSS)과 일치하는 타원 좌표 (가로 42%, 세로 62% 기준)
function guideOvalFor(w, h) {
  const ry = h * 0.31;
  const rx = Math.min(w * 0.21, ry * 0.78);
  return { cx: w / 2, cy: h * 0.5, rx, ry };
}

$("in-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const bmp = await fileToCanvas(file);
    stopCamera();
    loadPhoto(bmp, null);
  } catch {
    toast("사진을 불러올 수 없었어요. 다른 사진으로 해 볼까요?");
  }
});

async function fileToCanvas(file) {
  let source;
  if ("createImageBitmap" in window) {
    try { source = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { source = null; }
  }
  if (!source) {
    source = await new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); res(im); };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("decode")); };
      im.src = url;
    });
  }
  const w = source.width || source.naturalWidth, h = source.height || source.naturalHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  source.close?.();
  return c;
}

// ─────────────────────────────────────────────
// 확인·보정 화면
// ─────────────────────────────────────────────
const photo = $("photo"), overlay = $("overlay");

function loadPhoto(srcCanvas, oval) {
  photo.width = overlay.width = srcCanvas.width;
  photo.height = overlay.height = srcCanvas.height;
  photo.getContext("2d").drawImage(srcCanvas, 0, 0);
  state.imgData = photo.getContext("2d").getImageData(0, 0, photo.width, photo.height);
  state.oval = oval || { cx: photo.width / 2, cy: photo.height * 0.45, rx: photo.width * 0.22, ry: photo.width * 0.3 };
  state.wb = null; state.wbMode = false;
  $("in-size").value = 100;
  baseOval = { ...state.oval };
  updateWbUI();
  drawOverlay();
  show("check");
  touch();
}

let baseOval = null;
function drawOverlay() {
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const o = state.oval;
  // 바깥 어둡게
  ctx.save();
  ctx.fillStyle = "rgba(20, 16, 40, 0.42)";
  ctx.beginPath();
  ctx.rect(0, 0, overlay.width, overlay.height);
  ctx.ellipse(o.cx, o.cy, o.rx, o.ry, 0, 0, Math.PI * 2);
  ctx.fill("evenodd");
  ctx.restore();
  // 타원 선
  ctx.lineWidth = 3; ctx.strokeStyle = "#fff";
  ctx.beginPath(); ctx.ellipse(o.cx, o.cy, o.rx, o.ry, 0, 0, Math.PI * 2); ctx.stroke();
  // 샘플 점
  const reg = sampleRegions(o);
  const dot = (x, y, r, color) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
  };
  for (const c of reg.skin) dot(c.x, c.y, c.r, "rgba(255, 170, 120, 0.45)");
  for (const c of reg.eyes) dot(c.x, c.y, c.r, "rgba(120, 180, 255, 0.35)");
  ctx.fillStyle = "rgba(170, 120, 255, 0.3)"; ctx.strokeStyle = "#fff";
  ctx.beginPath(); ctx.rect(reg.hair.x0, reg.hair.y0, reg.hair.x1 - reg.hair.x0, reg.hair.y1 - reg.hair.y0); ctx.fill(); ctx.stroke();
  if (state.wbPoint) dot(state.wbPoint.x, state.wbPoint.y, 10, "rgba(255,255,255,0.9)");
}

// 타원 드래그 / 흰색 기준점 찍기
let drag = null;
function canvasPoint(ev) {
  const r = overlay.getBoundingClientRect();
  return { x: (ev.clientX - r.left) * (overlay.width / r.width), y: (ev.clientY - r.top) * (overlay.height / r.height) };
}
overlay.addEventListener("pointerdown", (ev) => {
  touch();
  const p = canvasPoint(ev);
  if (state.wbMode) { setWhitePoint(p); return; }
  drag = { dx: p.x - state.oval.cx, dy: p.y - state.oval.cy };
  overlay.setPointerCapture(ev.pointerId);
});
overlay.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const p = canvasPoint(ev);
  state.oval.cx = clamp(p.x - drag.dx, 0, overlay.width);
  state.oval.cy = clamp(p.y - drag.dy, 0, overlay.height);
  baseOval.cx = state.oval.cx; baseOval.cy = state.oval.cy;
  drawOverlay();
});
const endDrag = () => { drag = null; };
overlay.addEventListener("pointerup", endDrag);
overlay.addEventListener("pointercancel", endDrag);
$("in-size").addEventListener("input", (e) => {
  const k = Number(e.target.value) / 100;
  state.oval.rx = baseOval.rx * k; state.oval.ry = baseOval.ry * k;
  drawOverlay(); touch();
});

$("btn-wb").addEventListener("click", () => {
  if (state.wb) { state.wb = null; state.wbPoint = null; state.wbMode = false; }
  else state.wbMode = !state.wbMode;
  updateWbUI(); drawOverlay();
});
function setWhitePoint(p) {
  const d = state.imgData;
  // 주변 7×7 평균
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
    const px = Math.round(p.x + x), py = Math.round(p.y + y);
    if (px < 0 || py < 0 || px >= d.width || py >= d.height) continue;
    const i = (py * d.width + px) * 4; r += d.data[i]; g += d.data[i + 1]; b += d.data[i + 2]; n++;
  }
  const wb = whiteBalanceFrom({ r: r / n, g: g / n, b: b / n });
  if (!wb) { toast("그곳은 너무 어두워요. 밝은 흰색 부분을 눌러 주세요."); return; }
  state.wb = wb; state.wbPoint = p; state.wbMode = false;
  updateWbUI(); drawOverlay();
  toast("색 보정을 적용했어요 ✨");
}
function updateWbUI() {
  const b = $("btn-wb"), s = $("wb-status");
  if (state.wb) { b.textContent = "✖ 색 보정 지우기"; s.textContent = "보정 적용됨"; s.className = "wb-status on"; }
  else if (state.wbMode) { b.textContent = "취소"; s.textContent = "사진에서 흰 부분을 눌러 주세요"; s.className = "wb-status wait"; }
  else { b.textContent = "⚪ 흰 종이·흰 벽 눌러서 색 보정"; s.textContent = "보정 안 함"; s.className = "wb-status"; }
  overlay.classList.toggle("picking", state.wbMode);
}

$("btn-retake").addEventListener("click", () => { clearPhoto(); openCamera(); });

$("btn-analyze").addEventListener("click", () => {
  touch();
  const res = analyze(state.imgData, state.oval, state.wb);
  if (!res.ok) { toast(res.error); return; }
  state.result = res;
  renderResult(res.type, state.group, res.bars, res);
  show("result");
});

// ─────────────────────────────────────────────
// 결과
// ─────────────────────────────────────────────
function swatches(list, withNames = true) {
  return `<div class="swatches">${list.map((hex) => `
    <div class="sw"><span class="sw-dot" style="background:${hex}${isLight(hex) ? ";border-color:#d8d8e0" : ""}"></span>${withNames ? `<small>${PALETTE_NAMES[hex] || ""}</small>` : ""}</div>`).join("")}</div>`;
}
function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 225;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function bar(label0, label1, v, color) {
  return `<div class="bar"><span class="bar-l">${label0}</span>
    <div class="bar-track"><div class="bar-knob" style="left:${v}%;background:${color}"></div></div>
    <span class="bar-r">${label1}</span></div>`;
}

function renderResult(typeId, group, bars, res) {
  const type = TYPES[typeId];
  const season = SEASONS[type.season];
  const root = $("result-root");
  const isKid = group === "elem";
  const samples = res?.samples;
  const warn = res?.quality?.warnings || [];

  const sampleRow = samples ? `
    <div class="samples no-print">
      <span>사진에서 읽은 색</span>
      <i style="background:${samples.skin}" title="피부"></i><i style="background:${samples.hair}" title="머리"></i><i style="background:${samples.eye}" title="눈"></i>
    </div>` : "";
  const warnHtml = warn.length ? `<div class="warn no-print">${warn.map((w) => `<div>⚠️ ${esc(w)}</div>`).join("")}</div>` : "";
  const barsHtml = `<div class="bars">
      ${bar("쿨 ❄️", "🔥 웜", bars.warm, season.color)}
      ${bar("딥 🌑", "☀️ 라이트", bars.light, season.color)}
      ${bar("뮤트 🌫️", "✨ 브라이트", bars.clear, season.color)}
    </div>`;
  const head = (title, sub, nick) => `
      <div class="result-head">
        <div class="result-emoji">${season.emoji}</div>
        <div>
          <div class="result-kicker">나의 퍼스널 컬러는</div>
          <h2 class="result-title">${title} <small>${sub}</small></h2>
          <div class="result-nick">${esc(nick)}</div>
        </div>
      </div>`;
  const mini = (title) => `<div class="page-mini">${season.emoji} ${title}</div>`;

  // 장면별 페이지 (스크롤 대신 넘겨 보기)
  let pages;
  if (isKid) {
    const k = season.kid;
    const t = `${season.name}`;
    pages = [
      { label: "내 컬러", html: `${head(t, season.tone + "톤", season.nickname)}<p class="result-summary">${esc(k.summary)}</p>${sampleRow}${warnHtml}` },
      { label: "어울리는 색", html: `${mini(t)}<h3>🎨 나에게 어울리는 색</h3>${swatches(season.palette)}<p class="good-text">${esc(k.good)}</p>` },
      { label: "피할 색", html: `${mini(t)}<h3>🙅 조금 피하면 좋은 색</h3>${swatches(season.avoid, false)}<p class="good-text">${esc(k.avoid)}</p>` },
      { label: "꿀팁", html: `${mini(t)}<h3>💡 꿀팁</h3><ul class="tips">${k.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><div class="cheer">${esc(k.cheer)}</div>` },
    ];
  } else {
    const t = esc(type.name);
    pages = [
      { label: "내 컬러", html: `${head(t, esc(type.en), type.nickname)}<p class="result-summary">${esc(type.summary)}</p>${barsHtml}${sampleRow}${warnHtml}` },
      { label: "베스트", html: `${mini(t)}<h3>🎨 베스트 컬러</h3>${swatches(type.palette)}<p class="good-text">${esc(type.good)}</p>` },
      { label: "워스트", html: `${mini(t)}<h3>🙅 워스트 컬러</h3>${swatches(type.avoidPalette, false)}<p class="good-text">${esc(type.avoid)}</p>` },
      { label: "스타일 팁", html: `${mini(t)}<h3>💡 스타일 팁</h3><div class="tip-grid">${type.tips.map((x) => `<div class="tip"><b>${esc(x.h)}</b><span>${esc(x.t)}</span></div>`).join("")}</div>` },
    ];
  }
  if (!state.shared) pages.push({ label: "QR", html: `${mini(isKid ? season.name : esc(type.name))}<div class="qr-slot"></div>` });

  root.innerHTML = `
    <div class="card result-card season-${season.id}" style="--season:${season.color};--season-soft:${season.soft}">
      ${pages.map((p, i) => `<section class="rpage${i === 0 ? " active" : ""}" data-i="${i}">${p.html}</section>`).join("")}
      <div class="print-foot">시흥교육지원청 교육페스티벌 · 재미로 알아보는 퍼스널 컬러 · 사진·결과는 저장되지 않아요</div>
    </div>`;

  // QR 카드를 마지막 페이지로 옮김
  const qrCard = $("qr-card");
  const slot = root.querySelector(".qr-slot");
  if (slot) { slot.appendChild(qrCard); qrCard.hidden = false; } else { $("qr-holder").appendChild(qrCard); qrCard.hidden = true; }
  const url = shareUrl(typeId, group, bars);
  renderQR(url);
  $("qr-url").textContent = url.replace(/^https?:\/\//, "");

  $("btn-try").hidden = !state.shared;
  $("btn-restart").hidden = state.shared;
  setupPager(pages.map((p) => p.label));
  touch();
}

// ───── 결과 페이지 넘기기 ─────
let pageIdx = 0, pageCount = 0;
function setupPager(labels) {
  pageIdx = 0; pageCount = labels.length;
  $("dots").innerHTML = labels.map((l, i) => `<button class="dot${i === 0 ? " on" : ""}" type="button" data-i="${i}" aria-label="${esc(l)}"><span>${esc(l)}</span></button>`).join("");
  for (const d of $("dots").querySelectorAll(".dot")) d.addEventListener("click", () => goPage(+d.dataset.i));
  updatePager();
}
function goPage(i) {
  if (i < 0 || i >= pageCount) return;
  const prev = pageIdx; pageIdx = i;
  for (const sec of document.querySelectorAll(".rpage")) {
    const on = +sec.dataset.i === i;
    sec.classList.toggle("active", on);
    sec.classList.toggle("from-right", on && i > prev);
    sec.classList.toggle("from-left", on && i < prev);
  }
  updatePager();
  touch();
}
function updatePager() {
  $("btn-prev").disabled = pageIdx === 0;
  const last = pageIdx === pageCount - 1;
  $("btn-next").disabled = last;
  $("btn-next").textContent = last ? "끝 🎉" : "다음 →";
  for (const d of $("dots").querySelectorAll(".dot")) d.classList.toggle("on", +d.dataset.i === pageIdx);
  $("result-root").querySelector(".result-card")?.scrollTo?.(0, 0);
}
$("btn-prev").addEventListener("click", () => goPage(pageIdx - 1));
$("btn-next").addEventListener("click", () => goPage(pageIdx + 1));
document.addEventListener("keydown", (e) => {
  if (!$("screen-result").classList.contains("active")) return;
  if (e.key === "ArrowRight") goPage(pageIdx + 1);
  if (e.key === "ArrowLeft") goPage(pageIdx - 1);
});
// 스와이프
let swipe = null;
$("result-root").addEventListener("pointerdown", (e) => { swipe = { x: e.clientX, y: e.clientY }; });
$("result-root").addEventListener("pointerup", (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y; swipe = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) goPage(pageIdx + (dx < 0 ? 1 : -1));
});

function shareUrl(typeId, group, bars) {
  const code = TYPE_CODES[typeId];
  const g = group === "elem" ? "e" : "t";
  const b = [bars.warm, bars.light, bars.clear].map((v) => Math.round(clamp(v, 0, 100))).join(".");
  return `${location.origin}${location.pathname}#r=${code}.${g}.${b}`;
}
function parseShare(hash) {
  const m = /^#r=([A-Z]{2})\.([et])\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hash || "");
  if (!m) return null;
  const typeId = CODE_TYPES[m[1]];
  if (!typeId) return null;
  return { typeId, group: m[2] === "e" ? "elem" : "teen", bars: { warm: +m[3], light: +m[4], clear: +m[5] } };
}
function renderQR(url) {
  const box = $("qr-box");
  box.innerHTML = "";
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch { box.textContent = "QR을 만들 수 없어요"; }
}

$("btn-print").addEventListener("click", () => window.print());
$("btn-restart").addEventListener("click", () => wipeAndRestart(true));
$("btn-try").addEventListener("click", () => {
  history.replaceState(null, "", location.pathname);
  $("qr-holder").appendChild($("qr-card"));
  $("result-root").innerHTML = "";
  state = freshState();
  show("start");
});

// ─────────────────────────────────────────────
// 삭제 / 초기화
// ─────────────────────────────────────────────
function clearPhoto() {
  for (const c of [photo, overlay]) { c.getContext("2d").clearRect(0, 0, c.width, c.height); c.width = c.height = 1; }
  state.imgData = null; state.oval = null; state.wb = null; state.wbPoint = null; state.result = null;
}
function wipeAndRestart(announce) {
  stopCamera();
  clearPhoto();
  $("qr-holder").appendChild($("qr-card"));
  $("result-root").innerHTML = "";
  $("qr-box").innerHTML = "";
  $("qr-url").textContent = "";
  $("btn-shutter").disabled = false;
  state = freshState();
  show("start");
  if (announce) toast("사진과 결과를 모두 지웠어요 🧹");
}

// 5분 무조작 자동 삭제
let idleTimer = null;
function touch() {
  clearTimeout(idleTimer);
  if (state.shared) return;
  idleTimer = setTimeout(() => {
    if (!$("screen-start").classList.contains("active")) wipeAndRestart(true);
  }, IDLE_WIPE_MS);
}
for (const ev of ["pointerdown", "keydown", "touchstart"]) document.addEventListener(ev, touch, { passive: true });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ─────────────────────────────────────────────
// 시작: QR로 열린 결과인지 확인
// ─────────────────────────────────────────────
(function boot() {
  const shared = parseShare(location.hash);
  if (shared) {
    state.shared = true;
    state.group = shared.group;
    renderResult(shared.typeId, shared.group, shared.bars, null);
    show("result");
  }
})();
