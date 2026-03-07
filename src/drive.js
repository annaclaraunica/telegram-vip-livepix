
const { google } = require("googleapis");
function getDriveClient(){
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const creds = JSON.parse(raw);
  const auth = new google.auth.JWT({email:creds.client_email,key:creds.private_key,scopes:["https://www.googleapis.com/auth/drive"]});
  return google.drive({version:"v3",auth});
}
async function grantFileToEmail({driveFileId,email,role="reader"}){
  const drive = getDriveClient();
  const res = await drive.permissions.create({fileId:driveFileId,requestBody:{type:"user",role,emailAddress:email},sendNotificationEmail:false,fields:"id"});
  return { permissionId: res.data.id };
}
async function revokePermission({driveFileId,permissionId}){
  const drive = getDriveClient();
  await drive.permissions.delete({fileId:driveFileId,permissionId});
}
module.exports = { grantFileToEmail, revokePermission };
