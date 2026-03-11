const express = require('express');
const contentLinks = require('../services/content-links');

const router = express.Router();

router.get('/c/:token', async (req, res) => {
  const result = await contentLinks.consumeContentLink(req.params.token);

  if (result.status === 'missing') {
    return res.status(404).send('Link invalido.');
  }

  if (result.status === 'used') {
    return res.status(410).send('Link ja utilizado.');
  }

  if (result.status === 'expired') {
    return res.status(410).send('Acesso expirado.');
  }

  return res.redirect(302, result.url);
});

module.exports = router;
