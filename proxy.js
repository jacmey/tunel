/*
  proxy.js
  --------
  Servidor proxy HTTP simple usando http-proxy.
  
  Este proxy redirige las peticiones HTTP al destino indicado (utilizando el header "host").
  Úsalo para probar el túnel: configura Firefox para que utilice este proxy en 127.0.0.1:1080.
*/

const http = require('http');
const httpProxy = require('http-proxy');
const chalk = require('chalk');

const proxy = httpProxy.createProxyServer({});

const server = http.createServer((req, res) => {
  // Se determina el destino a partir del header "host"
  const target = 'http://' + req.headers.host;
  console.log(chalk.cyan(`Proxy: Redirigiendo petición a ${target}`));
  
  proxy.web(req, res, { target: target, changeOrigin: true }, (err) => {
    console.error(chalk.red("Error en el proxy:"), err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end("Error en el proxy: " + err.message);
  });
});

const PORT = 1080;
server.listen(PORT, () => {
  console.log(chalk.green(`Proxy HTTP corriendo en http://127.0.0.1:${PORT}`));
});
