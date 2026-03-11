require('dotenv').config();
const db = require('../src/lib/db');
const { listFolderFiles } = require('../src/drive');

function normalize(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/[_\- ]?(preview|previa|thumb|capa)$/i, '')
    .replace(/\((preview|previa|thumb|capa)\)$/i, '')
    .trim()
    .toLowerCase();
}

function isPreview(name) {
  const value = String(name || '');
  return (
    /[_\- ](preview|previa|thumb|capa)\./i.test(value) ||
    /\((preview|previa|thumb|capa)\)/i.test(value) ||
    /(^|[_\- ])(preview|previa|thumb|capa)($|[_\- ])/i.test(value)
  );
}

async function main() {
  await db.migrate();

  const folderId = process.argv[2];
  const description = process.argv[3] || 'Conteudo exclusivo.';
  const price = Number(process.argv[4] || 1990);

  if (!folderId) {
    throw new Error('Informe o folderId');
  }

  const files = await listFolderFiles({ folderId });
  const only = files.filter((file) => !String(file.mimeType || '').includes('folder'));
  const previews = new Map();

  for (const file of only) {
    if (isPreview(file.name)) {
      previews.set(normalize(file.name), file);
    }
  }

  let created = 0;
  await db.withTransaction(async (client) => {
    for (const file of only) {
      if (isPreview(file.name)) {
        continue;
      }

      const exists = await client.query('SELECT id FROM products WHERE drive_file_id = $1 LIMIT 1', [String(file.id)]);
      if (exists.rowCount > 0) {
        continue;
      }

      const preview = previews.get(normalize(file.name)) || null;
      const driveFileId = String(file.id);
      await client.query(
        `INSERT INTO products (title, description, price_cents, drive_file_id, active)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [String(preview ? file.name : file.name), description, price, driveFileId]
      );
      created += 1;
    }
  });

  console.log(JSON.stringify({ ok: true, created, total: only.length }, null, 2));
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
