// 사진에서 피부·머리카락·눈 색을 뽑아 퍼스널 컬러를 판정합니다.
// 모든 계산은 브라우저 안에서만 이루어지고, 사진은 어디로도 전송되지 않습니다.

// ───────── 색 공간 변환 ─────────
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  // sRGB → XYZ (D65)
  let x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let y = (R * 0.2126729 + G * 0.7151522 + B * 0.072175) / 1.0;
  let z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

export function labInfo(lab) {
  const C = Math.hypot(lab.a, lab.b);
  let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { ...lab, C, h };
}

export function toHex(rgb) {
  return "#" + [rgb.r, rgb.g, rgb.b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp01 = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// 피부색 판별(YCbCr 범위) — 안경, 눈썹, 배경 등을 걸러내는 용도
function isSkin(r, g, b) {
  const y = lum(r, g, b);
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 40 && y < 245 && cb > 77 && cb < 130 && cr > 133 && cr < 178;
}

// ───────── 픽셀 수집 ─────────
function collect(img, wb, test, predicate) {
  // img: ImageData, test(x,y) → 이 픽셀을 볼지, predicate(r,g,b) → 유효 픽셀인지
  const { width: W, height: H, data } = img;
  const out = [];
  const step = W * H > 400 * 400 ? 2 : 1; // 큰 사진은 2픽셀 간격으로 샘플
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (!test(x, y)) continue;
      const i = (y * W + x) * 4;
      let r = data[i], g = data[i + 1], b = data[i + 2];
      if (wb) { r = clamp(r * wb.r, 0, 255); g = clamp(g * wb.g, 0, 255); b = clamp(b * wb.b, 0, 255); }
      if (predicate && !predicate(r, g, b)) continue;
      out.push([r, g, b]);
    }
  }
  return out;
}

const inCircle = (cx, cy, rad) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
const inRect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;

// 밝기 기준으로 양끝을 잘라낸 평균(조명 반사·그림자 영향을 줄임)
function trimmedMean(pixels, lo = 0.2, hi = 0.8) {
  if (!pixels.length) return null;
  const sorted = pixels.slice().sort((p, q) => lum(...p) - lum(...q));
  const a = Math.floor(sorted.length * lo), b = Math.max(a + 1, Math.ceil(sorted.length * hi));
  let r = 0, g = 0, bl = 0, n = 0;
  for (let i = a; i < b; i++) { r += sorted[i][0]; g += sorted[i][1]; bl += sorted[i][2]; n++; }
  return { r: r / n, g: g / n, b: bl / n };
}

function percentileSlice(pixels, lo, hi) {
  const sorted = pixels.slice().sort((p, q) => lum(...p) - lum(...q));
  return sorted.slice(Math.floor(sorted.length * lo), Math.ceil(sorted.length * hi));
}

// 흰색 기준점으로 화이트밸런스 계수 계산 (밝기는 유지하고 색만 중립으로)
export function whiteBalanceFrom(rgb) {
  const avg = (rgb.r + rgb.g + rgb.b) / 3;
  if (avg < 60) return null; // 너무 어두우면 기준으로 쓰기 어려움
  const f = (c) => clamp(avg / Math.max(c, 1), 0.6, 1.6);
  return { r: f(rgb.r), g: f(rgb.g), b: f(rgb.b) };
}

// ───────── 샘플 영역 (타원 기준 상대 좌표) ─────────
export function sampleRegions(oval) {
  const { cx, cy, rx, ry } = oval;
  const r = rx * 0.13;
  return {
    skin: [
      { x: cx, y: cy - ry * 0.55, r },               // 이마
      { x: cx - rx * 0.48, y: cy + ry * 0.18, r },   // 왼쪽 볼
      { x: cx + rx * 0.48, y: cy + ry * 0.18, r },   // 오른쪽 볼
      { x: cx, y: cy + ry * 0.62, r: r * 0.9 },      // 턱
    ],
    eyes: [
      { x: cx - rx * 0.40, y: cy - ry * 0.14, r: rx * 0.15 },
      { x: cx + rx * 0.40, y: cy - ry * 0.14, r: rx * 0.15 },
    ],
    hair: { x0: cx - rx * 0.65, y0: cy - ry * 1.32, x1: cx + rx * 0.65, y1: cy - ry * 1.0 },
  };
}

// ───────── 메인 분석 ─────────
export function analyze(img, oval, wb = null) {
  const reg = sampleRegions(oval);
  const warnings = [];

  // 피부
  let skinPx = [];
  for (const c of reg.skin) skinPx = skinPx.concat(collect(img, wb, inCircle(c.x, c.y, c.r), isSkin));
  const skinCount = skinPx.length;
  if (skinCount < 120) {
    // 피부 필터가 너무 엄격했을 수 있음(조명·화장) → 필터 없이 다시
    skinPx = [];
    for (const c of reg.skin) skinPx = skinPx.concat(collect(img, wb, inCircle(c.x, c.y, c.r)));
    warnings.push("얼굴이 타원 안에 잘 맞지 않거나 조명이 어두워 보여요. 결과가 덜 정확할 수 있어요.");
  }
  const skinRGB = trimmedMean(skinPx, 0.25, 0.8);
  if (!skinRGB) return { ok: false, error: "얼굴 색을 찾을 수 없었어요. 타원 안에 얼굴을 맞추고 다시 찍어 주세요." };

  const skinLab0 = rgbToLab(skinRGB.r, skinRGB.g, skinRGB.b);
  const farFromSkin = (r, g, b) => {
    const l = rgbToLab(r, g, b);
    return Math.hypot(l.L - skinLab0.L, l.a - skinLab0.a, l.b - skinLab0.b) > 14 && l.L < skinLab0.L - 6;
  };

  // 머리카락: 타원 위쪽 띠에서 피부색과 다르고 피부보다 어두운 픽셀(갈색 머리도 포함) 중 어두운 쪽
  const hairAll = collect(img, wb, inRect(reg.hair.x0, reg.hair.y0, reg.hair.x1, reg.hair.y1), farFromSkin);
  let hairRGB = null;
  if (hairAll.length > 40) hairRGB = trimmedMean(percentileSlice(hairAll, 0.05, 0.6), 0.1, 0.9);
  if (!hairRGB) {
    warnings.push("머리카락을 찾지 못해 피부색만으로 판정했어요. 이마가 보이도록 머리를 넘기면 더 정확해요.");
    hairRGB = { r: skinRGB.r * 0.35, g: skinRGB.g * 0.3, b: skinRGB.b * 0.3 }; // 어두운 갈색으로 가정
  }

  // 눈: 눈 영역에서 피부색과 다른 픽셀 중 어두운 쪽(홍채·눈동자)
  let eyePx = [];
  for (const c of reg.eyes) eyePx = eyePx.concat(collect(img, wb, inCircle(c.x, c.y, c.r), (r, g, b) => farFromSkin(r, g, b) && lum(r, g, b) > 8));
  let eyeRGB = eyePx.length > 20 ? trimmedMean(percentileSlice(eyePx, 0.05, 0.45), 0.1, 0.9) : null;
  if (!eyeRGB) eyeRGB = { r: hairRGB.r * 0.9, g: hairRGB.g * 0.9, b: hairRGB.b * 0.9 };

  const skin = labInfo(rgbToLab(skinRGB.r, skinRGB.g, skinRGB.b));
  const hair = labInfo(rgbToLab(hairRGB.r, hairRGB.g, hairRGB.b));
  const eye = labInfo(rgbToLab(eyeRGB.r, eyeRGB.g, eyeRGB.b));

  if (skin.L < 28) warnings.push("사진이 많이 어두워요. 밝은 곳에서 다시 찍으면 더 정확해요.");
  if (skin.L > 90) warnings.push("사진이 너무 밝아요(역광·플래시). 그늘지지 않은 밝은 곳에서 찍어 주세요.");
  if (skin.C < 6) warnings.push("색이 거의 없는(흑백에 가까운) 사진이에요. 필터 없이 찍어 주세요.");

  // ───── 점수 (0~100) ─────
  // 웜↔쿨: 피부 색상각(a*,b*). 노란빛(각도 큼)=웜, 붉은·푸른빛(각도 작음)=쿨
  const skinWarm = lerp01(skin.h, 42, 68) * 100;
  // 머리카락 노란 기운(b*)도 조금 반영
  const hairWarm = lerp01(hair.b, 4, 20) * 100;
  const warm = Math.round(skinWarm * 0.8 + hairWarm * 0.2);

  // 라이트↔딥: 피부 밝기 + 머리카락 밝기
  const light = Math.round(lerp01(skin.L, 50, 82) * 100 * 0.7 + lerp01(hair.L, 8, 62) * 100 * 0.3);

  // 뮤트↔브라이트: 피부-머리 명도 대비 + 피부 채도 + 눈 어두움
  const contrast = skin.L - hair.L;
  const clear = Math.round(
    lerp01(contrast, 12, 58) * 100 * 0.5 +
    lerp01(skin.C, 12, 32) * 100 * 0.3 +
    lerp01(skin.L - eye.L, 20, 60) * 100 * 0.2
  );

  const type = classify({ warm, light, clear });

  return {
    ok: true,
    type,
    season: type.split("-")[0],
    bars: { warm, light, clear },
    samples: { skin: toHex(skinRGB), hair: toHex(hairRGB), eye: toHex(eyeRGB) },
    lab: { skin, hair, eye },
    quality: { skinPixels: skinCount, hairPixels: hairAll.length, eyePixels: eyePx.length, warnings },
  };
}

export function classify({ warm, light, clear }) {
  if (warm >= 50) {
    if (light >= 72) return "spring-light";
    if (light <= 35) return "autumn-deep";
    if (clear >= 68) return "spring-bright";
    if (clear <= 38) return "autumn-mute";
    return light >= 55 ? "spring-true" : "autumn-true";
  }
  if (light >= 72) return "summer-light";
  if (light <= 35) return "winter-deep";
  if (clear <= 38) return "summer-mute";
  if (clear >= 68) return "winter-bright";
  return light >= 55 ? "summer-true" : "winter-true";
}
