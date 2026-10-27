// 16-bit PCM / 32-bit float WAV 읽기 (Node 전용, 검증·기준값 계산용)
const fs = require("fs");
function readWav(path) {
  const b = fs.readFileSync(path);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString("ascii", p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), fs: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === "data") { data = b.subarray(p + 8, p + 8 + Math.min(size, b.length - p - 8)); break; }
    p += 8 + size + (size & 1);
  }
  const n = Math.floor(data.length / (fmt.bits / 8) / fmt.ch);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = (i * fmt.ch + c) * (fmt.bits / 8);
      s += fmt.bits === 16 ? data.readInt16LE(o) / 32768 : fmt.bits === 32 && fmt.format === 3 ? data.readFloatLE(o) : data.readInt32LE(o) / 2147483648;
    }
    out[i] = s / fmt.ch;
  }
  return { samples: out, fs: fmt.fs };
}
module.exports = { readWav };
