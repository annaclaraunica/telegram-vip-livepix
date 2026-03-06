\
const { execSync } = require("child_process");
const fs = require("fs");

const input = process.argv[2];
if (!input) {
  console.log('Uso: node scripts/make-preview.js "D:\\videos\\video.mp4"');
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.log("Arquivo não encontrado:", input);
  process.exit(1);
}

const out = input.replace(/\.[^.]+$/, "") + "_preview7s.mp4";
const cmd = `ffmpeg -y -ss 2 -t 7 -i "${input}" -vf "scale=720:-2:flags=lanczos,fps=24" -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -movflags +faststart -an "${out}"`;
execSync(cmd, { stdio: "inherit" });
console.log("✅ Preview criado:", out);
