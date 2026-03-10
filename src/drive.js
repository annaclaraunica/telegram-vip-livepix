const { google } = require("googleapis");


function normalizeDriveId(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("ID do Google Drive vazio");

  const cleaned = raw
    .replace(/^https?:\/\/drive\.google\.com\/drive\/folders\//i, "")
    .replace(/^https?:\/\/drive\.google\.com\/file\/d\//i, "")
    .replace(/^https?:\/\/drive\.google\.com\/open\?id=/i, "")
    .replace(/^folders\//i, "")
    .split(/[?#/]/)[0]
    .trim();

  if (!cleaned) throw new Error("ID do Google Drive inválido");
  return cleaned;
}


function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON não configurado");
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

function driveDirectUrl(fileId) {
  const safeId = normalizeDriveId(fileId);
  return `https://drive.googleusercontent.com/uc?id=${safeId}&export=download`;
}

function driveViewUrl(fileId) {
  const safeId = normalizeDriveId(fileId);
  return `https://drive.google.com/file/d/${safeId}/view`;
}

async function getDriveFileMeta(fileId) {
  const drive = getDriveClient();
  const res = await drive.files.get({
    fileId: normalizeDriveId(fileId),
    fields: "id,name,mimeType,size",
    supportsAllDrives: true,
  });
  return res.data;
}

async function downloadDriveFileBuffer(fileId) {
  const drive = getDriveClient();
  const res = await drive.files.get(
    {
      fileId: normalizeDriveId(fileId),
      alt: "media",
      supportsAllDrives: true,
    },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

async function grantFileToEmail({ driveFileId, email, expirationTime }) {
  const drive = getDriveClient();
  const res = await drive.permissions.create({
    fileId: normalizeDriveId(driveFileId),
    requestBody: {
      type: "user",
      role: "reader",
      emailAddress: email,
      expirationTime: expirationTime || undefined,
    },
    fields: "id",
    supportsAllDrives: true,
  });
  return { permissionId: res.data.id };
}

async function revokePermission({ driveFileId, permissionId }) {
  if (!permissionId) return;
  const drive = getDriveClient();
  await drive.permissions.delete({
    fileId: normalizeDriveId(driveFileId),
    permissionId,
    supportsAllDrives: true,
  });
}

async function listFolderFiles({ folderId }) {
  const drive = getDriveClient();
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      const safeFolderId = normalizeDriveId(folderId);
      q: `'${safeFolderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id,name,mimeType,webViewLink,size)",
      pageToken,
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

module.exports = {
  normalizeDriveId,
  getDriveClient,
  grantFileToEmail,
  revokePermission,
  listFolderFiles,
  driveDirectUrl,
  driveViewUrl,
  getDriveFileMeta,
  downloadDriveFileBuffer,
  grantFileAccess: async (email, fileId, expirationDate) =>
    grantFileToEmail({ driveFileId: fileId, email, expirationTime: expirationDate }),
  revokeFileAccess: async (fileId, permissionId) =>
    revokePermission({ driveFileId: fileId, permissionId }),
  makeDriveViewLink: driveViewUrl,
};
