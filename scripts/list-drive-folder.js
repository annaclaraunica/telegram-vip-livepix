require("dotenv").config()
const { listFolderFiles } = require("../src/drive")

async function main() {
  const folderId = process.argv[2]
  if (!folderId) throw new Error("Informe o folderId")
  const files = await listFolderFiles({ folderId })
  console.log(JSON.stringify(files, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
