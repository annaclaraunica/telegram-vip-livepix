function notFoundHandler(req, res) {
  return res.status(404).json({
    ok: false,
    error: 'not_found'
  });
}

module.exports = {
  notFoundHandler
};
