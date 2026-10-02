// Ilova ikonkalarini yaratadi (ko'k fon, oq kalit). Ishga tushirish: node icons/make-icons.js
const fs = require('fs'), path = require('path'), zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y), o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Kalit shakli (0..1 koordinatalarda): halqa + sterjen + 2 ta tish
function isKey(u, v) {
  const cx = 0.36, cy = 0.5, d = Math.hypot(u - cx, v - cy);
  if (d <= 0.16 && d >= 0.075) return true;
  if (u >= 0.5 && u <= 0.8 && Math.abs(v - 0.5) <= 0.035) return true;
  if (u >= 0.66 && u <= 0.71 && v >= 0.5 && v <= 0.62) return true;
  if (u >= 0.75 && u <= 0.8 && v >= 0.5 && v <= 0.66) return true;
  return false;
}
function render(size) {
  const ss = 4; // silliq chekka uchun
  return png(size, (x, y) => {
    let k = 0;
    for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) if (isKey((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size)) k++;
    const a = k / (ss * ss), t = (x + y) / (2 * size);
    const bg = [Math.round(37 + 22 * t), Math.round(99 + 31 * t), Math.round(235 + 11 * t)];
    return bg.map(c => Math.round(c * (1 - a) + 255 * a));
  });
}
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]])
  fs.writeFileSync(path.join(__dirname, '..', 'public', name), render(size));
console.log('Ikonkalar yaratildi');
