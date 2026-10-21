const http = require('http');

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/healthz') {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, status: 'clean-reset', bots: 0 }));
    return;
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ status: 'clean-reset', message: 'No trading bots are configured.' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Clean reset shell listening on ${port}`);
});
