const { google } = require("googleapis")

function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON não configurado")
  return typeof raw === "string" ? JSON.parse(raw) : raw
}

function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive"],
  })
  return google.drive({ version: "v3", auth })
}

function driveDirectUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`
}

function driveViewUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`
}

async function grantFileToEmail({ driveFileId, email, expirationTime }) {
  const drive = getDriveClient()
  const res = await drive.permissions.create({
    fileId: driveFileId,
    requestBody: {
      type: "user",
      role: "reader",
      emailAddress: email,
      expirationTime: expirationTime || undefined,
    },
    fields: "id",
  })
  return { permissionId: res.data.id }
}

async function revokePermission({ driveFileId, permissionId }) {
  if (!permissionId) return
  const drive = getDriveClient()
  await drive.permissions.delete({ fileId: driveFileId, permissionId })
}

async function listFolderFiles({ folderId }) {
  const drive = getDriveClient()
  const files = []
  let pageToken
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id,name,mimeType,webViewLink,size)",
      pageToken,
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    files.push(...(res.data.files || []))
    pageToken = res.data.nextPageToken
  } while (pageToken)
  return files
}

module.exports = {
  getDriveClient,
  grantFileToEmail,
  revokePermission,
  listFolderFiles,
  driveDirectUrl,
  driveViewUrl,
  grantFileAccess: async (email, fileId, expirationDate) => grantFileToEmail({ driveFileId: fileId, email, expirationTime: expirationDate }),
  revokeFileAccess: async (fileId, permissionId) => revokePermission({ driveFileId: fileId, permissionId }),
  makeDriveViewLink: driveViewUrl,
}
