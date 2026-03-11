const env = require('../config/env');
const { safeCompare } = require('./crypto');

function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Autenticação necessária');
  }

  const base64 = header.replace('Basic ', '');
  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');

  const user = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : '';
  const pass = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';

  const validUser = safeCompare(user, env.adminUser);
  const validPass = safeCompare(pass, env.adminPass);

  if (!validUser || !validPass) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Credenciais inválidas');
  }

  next();
}

module.exports = {
  basicAuth
};