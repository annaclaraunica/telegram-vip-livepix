const crypto = require('crypto');

function generateToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  generateToken,
  safeCompare
};
