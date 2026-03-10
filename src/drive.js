const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.resolve(process.cwd(), "drive-cache");
const DOWNLOAD_CACHE_TTL_MS = Number(process.env.DOWNLOAD_CACHE_TTL_MS || 1000 * 60 * 30);
const FILE_META_TTL_MS = Number(process.env.FILE_META_TTL_MS || 1000 * 60 * 10);

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const memoryMetaCache = new Map();

function readServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON não configurado");
  return JSON.parse(raw);
}

let driveSingleton = null;

function getDriveClient() {
  if (driveSingleton) return driveSingleton;

  const credentials = readServiceAccount();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });

  driveSingleton = google.drive({ version: "v3", auth });
  return driveSingleton;
}

function driveDirectUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

async function getFileMeta(fileId) {
  const key = String(fileId);
  const cached = memoryMetaCache.get(key);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const drive = getDriveClient();
  const { data } = await drive.files.get({
    fileId: key,
    fields: "id,name,mimeType,size,webViewLink"
  });

  memoryMetaCache.set(key, {
    data,
    expiresAt: now + FILE_META_TTL_MS
  });

  return data;
}

function getCachedFilePath(fileId, filename = "") {
  const safe = String(fileId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const ext = path.extname(filename || "");
  return path.join(CACHE_DIR, `${safe}${ext || ".bin"}`);
}

function isFresh(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (Date.now() - stat.mtimeMs) < DOWNLOAD_CACHE_TTL_MS;
  } catch {
    return false;
  }
}

async function downloadDriveFileBuffer(fileId) {
  const meta = await getFileMeta(fileId);
  const filePath = getCachedFilePath(fileId, meta?.name || "");

  if (isFresh(filePath)) {
    return fs.readFileSync(filePath);
  }

  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId: String(fileId), alt: "media" },
    { responseType: "arraybuffer" }
  );

  const buffer = Buffer.from(res.data);
  fs.writeFileSync(filePath, buffer);
  return buffer;
}

async function grantFileToEmail({ driveFileId, email, expiresAtMs = null }) {
  const drive = getDriveClient();
  const requestBody = {
    type: "user",
    role: "reader",
    emailAddress: String(email).trim()
  };

  if (expiresAtMs) {
    requestBody.expirationTime = new Date(Number(expiresAtMs)).toISOString();
  }

  const { data } = await drive.permissions.create({
    fileId: String(driveFileId),
    requestBody,
    fields: "id"
  });

  return { permissionId: data.id };
}

async function revokePermission({ driveFileId, permissionId }) {
  if (!permissionId) return;
  const drive = getDriveClient();
  await drive.permissions.delete({
    fileId: String(driveFileId),
    permissionId: String(permissionId)
  });
}

async function listFolderFiles({ folderId }) {
  const drive = getDriveClient();
  let pageToken = undefined;
  const all = [];

  do {
    const { data } = await drive.files.list({
      q: `'${String(folderId)}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,webViewLink,size)",
      pageSize: 1000,
      pageToken
    });

    all.push(...(data.files || []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);

  return all;
}

module.exports = {
  getDriveClient,
  getFileMeta,
  downloadDriveFileBuffer,
  grantFileToEmail,
  revokePermission,
  listFolderFiles,
  driveDirectUrl
};
