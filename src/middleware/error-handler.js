const logger = require('../lib/logger');

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  req.log.error(
    {
      err,
      path: req.path,
      method: req.method
    },
    'Unhandled request error'
  );

  const statusCode = Number(err.statusCode || err.status || 500);
  return res.status(statusCode).json({
    ok: false,
    error: statusCode >= 500 ? 'internal_error' : err.message
  });
}

process.on('multipleResolves', (type, promise, reason) => {
  logger.warn({ type, err: reason }, 'multipleResolves');
});

module.exports = {
  errorHandler
};
