const fs = require('fs');
const zlib = require('zlib');

const buf = fs.readFileSync(process.argv[2]);
let w = 0, h = 0, colorType = 0, bitDepth = 8;
const idatChunks = [];
let i = 8;
while (i < buf.length) {
  const len = buf.readUInt32BE(i); i += 4;
  const type = buf.toString('ascii', i, i + 4); i += 4;
  if (type === 'IHDR') { w = buf.readUInt32BE(i); h = buf.readUInt32BE(i+4); bitDepth = buf.readUInt8(i+8); colorType = buf.readUInt8(i+9); }
  if (type === 'IDAT') idatChunks.push(buf.subarray(i, i + len));
  i += len + 4;
}
const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 3;
const bpp = channels;
const raw = zlib.inflateSync(Buffer.concat(idatChunks));
const stride = w * bpp + 1;
function px(x, y) { const off = y * stride + 1 + x * bpp; return raw[off]; } // grayscale value
function lum(x, y) { return px(x, y); }

console.log(`image ${w}x${h} colorType=${colorType} bitDepth=${bitDepth} channels=${channels} stride=${stride}`);

// find aside right edge: scan a horizontal line at y=300 (nav) for transitions on the right side.
function profile(y) {
  return Array.from({length: Math.min(w, 460)}, (_, k) => {
    const x = 380 + k; // device px around aside edge (aside right ~ 416 dev)
    return px(x, y);
  });
}
// print compact profile at header y and nav y
function fmtProfile(y) {
  const arr = [];
  for (let x = 408; x <= 430; x++) arr.push(`${x}:${px(x,y)}`);
  return arr.join('  ');
}
console.log('header y=90 :', fmtProfile(90));
console.log('header y=125:', fmtProfile(125));
console.log('nav    y=200:', fmtProfile(200));
console.log('nav    y=300:', fmtProfile(300));

// count "edge" cols: columns near asideRight that are brighter than the surface bg.
// surface bg luminance ~ 0x1c=28. Border subtle = white at 9% alpha over rgg => ~ 28+ (255-28)*0.09 ≈ 46.
const EDGE = 36; // threshold above surface
function edgeWidth(y) {
  let lo = -1, hi = -1;
  for (let x = 400; x <= 440; x++) {
    if (px(x, y) >= EDGE) { if (lo < 0) lo = x; hi = x; }
  }
  return { lo, hi, width: hi - lo + 1 };
}
for (const y of [60, 90, 110, 125, 140, 200, 280, 340, 400]) {
  console.log(`y=${y}`, edgeWidth(y));
}
