require("dotenv").config()
const db = require("../src/db")
const { listFolderFiles } = require("../src/drive")

function normalize(name) {
  return String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/\s+/g, " ")
    .replace(/[_\- ]?(preview|prévia|previa|thumb|capa)$/i, "")
    .replace(/\((preview|prévia|previa|thumb|capa)\)$/i, "")
    .trim()
    .toLowerCase()
}

function isPreview(name) {
  const s = String(name || "")
  return (
    /[_\- ](preview|prévia|previa|thumb|capa)\./i.test(s) ||
    /\((preview|prévia|previa|thumb|capa)\)/i.test(s) ||
    /(^|[_\- ])(preview|prévia|previa|thumb|capa)($|[_\- ])/i.test(s)
  )
}

async function main() {
  const folderId = process.argv[2]
  const description = process.argv[3] || "Conteúdo exclusivo."
  const price = Number(process.argv[4] || 1990)

  if (!folderId) throw new Error("Informe o folderId")

  const files = await listFolderFiles({ folderId })
  const only = files.filter((f) => !String(f.mimeType || "").includes("folder"))
  const previews = new Map()

  for (const f of only) {
    if (isPreview(f.name)) previews.set(normalize(f.name), f)
  }

  const exists = db.prepare("SELECT id FROM products WHERE drive_file_id=? LIMIT 1")
  const ins = db.prepare("INSERT INTO products (title,tagline,description,price_cents,drive_file_id,preview_drive_file_id,preview_mime,sort_order) VALUES (?,?,?,?,?,?,?,?)")

  let created = 0
  db.transaction(() => {
    for (const f of only) {
      if (isPreview(f.name)) continue
      if (exists.get(String(f.id))) continue
      const preview = previews.get(normalize(f.name)) || null
      const mime = preview && /gif/i.test(preview.mimeType || "") ? "gif" : "video"
      ins.run(String(f.name || "Conteúdo"), "", description, price, String(f.id), preview ? String(preview.id) : null, mime, 0)
      created++
    }
  })()

  console.log(JSON.stringify({ ok: true, created, total: only.length }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
