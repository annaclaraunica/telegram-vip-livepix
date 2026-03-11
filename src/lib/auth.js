const env = require('../config/env');
const { safeCompare } = require('./crypto');

function basicAuth(req, res, next) {
  if (!env.adminUser || !env.adminPass) {
    return res.status(503).json({ ok: false, error: 'Admin desabilitado' });
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Autenticacao necessaria');
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  const user = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : '';
  const pass = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';

  if (!safeCompare(user, env.adminUser) || !safeCompare(pass, env.adminPass)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Credenciais invalidas');
  }

  req.adminUser = user;
  next();
}

module.exports = {
  basicAuth
};
