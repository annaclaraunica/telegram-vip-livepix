const crypto = require('crypto');

function generateToken(size = 32) {
  return crypto.randomBytes(size).toString('hex');
}

function safeCompare(a, b) {
  const aBuf = Buffer.from(String(a || ''));
  const bBuf = Buffer.from(String(b || ''));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

module.exports = {
  generateToken,
  safeCompare
};