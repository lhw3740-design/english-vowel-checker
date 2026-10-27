// 원어민 기준값 계산 (바탕 논문 compute_distances.py와 같은 방법, 측정은 앱과 같은 JS 코드)
// 실행: node build_reference.js <hillenbrand_dir> <out_json> [--kids-ceiling-scan]
const fs = require("fs");
const P = require(require("path").join(__dirname, "..", "js", "praat-formant.js"));
const { readWav } = require("./wav.js");
const dir = process.argv[2], out = process.argv[3];
const V = ["iy", "ih", "ei", "eh", "ae", "ah", "aw", "oa", "oo", "uw", "uh", "er"];

function table(path, ncol) {
  const r = {};
  for (const line of fs.readFileSync(path, "latin1").split(/\r?\n/)) {
    if (/^[mwbg]\d\d\w\w\s/.test(line)) { const f = line.trim().split(/\s+/); if (f.length === ncol) r[f[0]] = f; }
  }
  return r;
}
const tim = table(`${dir}/timedata.dat`, 5), vow = table(`${dir}/vowdata.dat`, 16);

const VA = require(require("path").join(__dirname, "..", "js", "vowel-analysis.js"));
// 구간: "timedata"(논문 본 분석: 공개 수동 구간) 또는 "auto"(논문 부록 C 조건 A: 유성음 자동 구간, 문턱 0.45, 가장 긴 구간)
const SEG = (process.argv.find(a => a.startsWith("--segments=")) || "--segments=auto").split("=")[1];
const PITCH = { m: [70, 300], w: [120, 500], b: [120, 600], g: [120, 600] };
let autoFallback = 0;
function measure(name, folder, ceiling) {
  const w = readWav(`${dir}/${folder}/${name}.wav`);
  const snd = P.makeSound(w.samples, w.fs);
  const fm = P.toFormantBurg(snd, { timeStep: 0.01, maxFormants: 5, ceiling, windowLength: 0.025, preEmphasis: 50 });
  let s = +tim[name][1] / 1000, e = +tim[name][2] / 1000;
  if (SEG === "auto") {
    const runs = VA.voicedRuns(snd, PITCH[name[0]], 0.45);
    if (runs.length) { const r = runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a)); s = r[0]; e = r[1]; }
    else autoFallback++;
  }
  const r = {};
  for (const p of [20, 50, 80]) for (const k of [1, 2]) r[`F${k}_${p}`] = P.formantAt(fm, k, s + p / 100 * (e - s));
  return r;
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sdPop = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
function percentile(a, q) { // numpy 기본(linear)
  const s = [...a].sort((x, y) => x - y), pos = (s.length - 1) * q, lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}
function pubDiff(rows) { // 공개 수치(vowdata 50%)와의 절대 차이 중앙값
  const d = [];
  for (const [name, m] of Object.entries(rows)) for (const k of [1, 2]) {
    const pub = +vow[name][9 + k]; if (pub > 0 && !isNaN(m[`F${k}_50`])) d.push(Math.abs(m[`F${k}_50`] - pub));
  }
  return percentile(d, 0.5);
}

const GROUPS = {
  men: { folder: "men", prefix: ["m"], ceiling: 5000, label: "성인 남성" },
  women: { folder: "women", prefix: ["w"], ceiling: 5500, label: "성인 여성" },
  kids: { folder: "kids", prefix: ["b", "g"], ceiling: null, label: "아동(10~12세, 남녀 합침)" },
};

if (process.argv.includes("--kids-ceiling-scan")) {
  for (const c of [5000, 5500, 6000, 6500, 7000, 7500, 8000]) {
    const rows = {};
    for (const n of Object.keys(tim)) if ("bg".includes(n[0])) rows[n] = measure(n, "kids", c);
    const und = Object.values(rows).filter(r => Object.values(r).some(isNaN)).length;
    const f = k => { const d = []; for (const [n, m] of Object.entries(rows)) { const pub = +vow[n][9 + k]; if (pub > 0 && !isNaN(m[`F${k}_50`])) d.push(Math.abs(m[`F${k}_50`] - pub)); } return percentile(d, 0.5).toFixed(1); };
    console.log(`ceiling ${c}: |JS-공개| 중앙값 F1 ${f(1)} Hz, F2 ${f(2)} Hz, 값 없는 파일 ${und}`);
  }
  process.exit(0);
}
const kidsCeiling = +(process.argv.find(a => a.startsWith("--kids-ceiling="))?.split("=")[1] || 0);
GROUPS.kids.ceiling = kidsCeiling;

const ref = { method: {}, groups: {} };
for (const [g, cfg] of Object.entries(GROUPS)) {
  const names = Object.keys(tim).filter(n => cfg.prefix.includes(n[0])).sort();
  const rows = {}; for (const n of names) rows[n] = measure(n, cfg.folder, cfg.ceiling);
  // 화자별 Lobanov z (12모음 50% 지점 평균·모집단 SD)
  const talkers = {};
  for (const n of names) (talkers[n.slice(0, 3)] ||= {})[n.slice(3, 5)] = rows[n];
  const tz = {};
  for (const [t, vs] of Object.entries(talkers)) {
    const ok = V.filter(v => vs[v] && ["F1_20", "F1_50", "F1_80", "F2_20", "F2_50", "F2_80"].every(k => !isNaN(vs[v][k])));
    const m = [1, 2].map(k => mean(ok.map(v => vs[v][`F${k}_50`]))), s = [1, 2].map(k => sdPop(ok.map(v => vs[v][`F${k}_50`])));
    tz[t] = {};
    for (const v of ok) {
      const z = p => [1, 2].map(k => (vs[v][`F${k}_${p}`] - m[k - 1]) / s[k - 1]);
      tz[t][v] = { z50: z(50), z20: z(20), z80: z(80) };
    }
  }
  const meanPt = {}, meanDy = {}, hz = {};
  for (const v of V) {
    const T = Object.values(tz).filter(x => x[v]);
    meanPt[v] = [0, 1].map(i => mean(T.map(x => x[v].z50[i])));
    meanDy[v] = [0, 1].map(i => mean(T.map(x => x[v].z80[i] - x[v].z20[i])));
    const H = names.filter(n => n.slice(3, 5) === v).map(n => rows[n]).filter(r => !isNaN(r.F1_50) && !isNaN(r.F2_50));
    const H3 = H.filter(r => ["F1_20", "F2_20", "F1_80", "F2_80"].every(k => !isNaN(r[k])));
    hz[v] = { F1: Math.round(mean(H.map(r => r.F1_50))), F2: Math.round(mean(H.map(r => r.F2_50))),
      F1_20: Math.round(mean(H3.map(r => r.F1_20))), F2_20: Math.round(mean(H3.map(r => r.F2_20))),
      F1_80: Math.round(mean(H3.map(r => r.F1_80))), F2_80: Math.round(mean(H3.map(r => r.F2_80))) };
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const perTalker = Object.entries(tz).map(([t, x]) => {
    const vs = Object.keys(x);
    const st = vs.map(v => dist(x[v].z50, meanPt[v])), dy = vs.map(v => dist([x[v].z80[0] - x[v].z20[0], x[v].z80[1] - x[v].z20[1]], meanDy[v]));
    return { talker: t, static: mean(st), dynamic: mean(dy), n: vs.length, perVowelStatic: Object.fromEntries(vs.map((v, i) => [v, st[i]])) };
  });
  // 모음별 원어민 90백분위(모음 하나 단위 거리) — 결과 화면의 모음별 '원어민 범위' 표시용
  const vowelP90 = {};
  for (const v of V) vowelP90[v] = +percentile(perTalker.filter(p => p.perVowelStatic[v] != null).map(p => p.perVowelStatic[v]), 0.9).toFixed(4);
  const r4 = x => +x.toFixed(4);
  ref.groups[g] = {
    label: cfg.label, ceiling: cfg.ceiling, talkers: perTalker.length, tokens: names.length,
    p90: { static: r4(percentile(perTalker.map(p => p.static), 0.9)), dynamic: r4(percentile(perTalker.map(p => p.dynamic), 0.9)) },
    median: { static: r4(percentile(perTalker.map(p => p.static), 0.5)), dynamic: r4(percentile(perTalker.map(p => p.dynamic), 0.5)) },
    vowelP90,
    meanZ50: Object.fromEntries(V.map(v => [v, meanPt[v].map(r4)])),
    meanDz: Object.fromEntries(V.map(v => [v, meanDy[v].map(r4)])),
    meanHz50: hz,
    pubMedianAbsDiffHz: r4(pubDiff(rows)),
    talkerDistances: perTalker.map(p => ({ t: p.talker, s: r4(p.static), d: r4(p.dynamic) })),
  };
  console.log(g, cfg.label, "talkers", perTalker.length, "p90", ref.groups[g].p90, "median", ref.groups[g].median, "|JS-공개| 중앙값", ref.groups[g].pubMedianAbsDiffHz);
}
ref.method = {
  source: "Hillenbrand, Getty, Clark & Wheeler (1995) 공개 음성 파일",
  formant: "Burg, 시간 간격 0.01 s, 최대 포먼트 5개, 분석 창 0.025 s, 선강조 50 Hz (Praat 6.1.38 계산을 JS로 옮김)",
  segments: SEG === "auto" ? "유성음 자동 구간(자기상관 피치, 문턱 0.45, 가장 긴 구간) — 논문 부록 C 조건 A, 앱 사용자와 같은 구간 규칙" : "timedata.dat 공개 수동 구간 — 논문 본 분석",
  points: "모음 구간의 20·50·80% 지점 F1·F2",
  normalization: "화자별 Lobanov z (12모음 50% 지점 F1·F2 평균·모집단 표준편차)",
  static: "모음별 (zF1,zF2)50%와 같은 집단 원어민 평균점의 유클리드 거리를 12모음 평균",
  dynamic: "모음별 20%→80% 변화량과 같은 집단 원어민 평균 변화량의 거리를 12모음 평균",
  range: "같은 집단 원어민 화자별 거리의 90백분위 이하이면 '원어민 범위 안'",
};
fs.writeFileSync(out, JSON.stringify(ref));
// file:// 로 열어도 되게 JS 파일로도 저장 (fetch 없이 읽음)
fs.writeFileSync(out.replace(/\.json$/, ".js"), "/* 자동 생성: tools/build_reference.js */\nwindow.VOWEL_REFERENCE = " + JSON.stringify(ref) + ";\n");
console.log("segments", SEG, "자동 구간 없음(공개 구간 사용):", autoFallback);
console.log("wrote", out, fs.statSync(out).size, "bytes");
