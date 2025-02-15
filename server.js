const net = require('net');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { logger } = require('./utils/logger');
const { startSock, sendData } = require('./wasocket');
const { LOGGER_TYPES, DELIMITER } = require('./constants');

const argv = yargs(hideBin(process.argv))
  .command(
    '$0 <proxy-host> <proxy-port> <client-wa-num> [disable-files]',
    'Start a wa-tunnel server listening on <localport>',
    (yargsData) => {
      yargsData
        .positional('local-port', {
          demandOption: true,
          describe: 'Port to be forwarded'
        })
        .positional('client-wa-num', {
          demandOption: true,
          describe: 'Client WhatsApp number following this format: 12345678901'
        })
        .option('disable-files', {
          description:
            'Disable sending WhatsApp files to reduce the amount of messages (sometimes not allowed)',
          default: false,
          type: 'boolean'
        })
        .version(false);
    }
  )
  .parse();

const sockets = {};
const cacheTimers = {};
const cacheRequests = {};
const { proxyHost } = argv;
const { proxyPort } = argv;
const { disableFiles } = argv;
const clientNum = `${argv.clientWaNum}@s.whatsapp.net`;

// Declaramos waSock en un ámbito superior para usarlo en el callback
let waSock;

const sendCachedData = async (
  waSockData,
  socketNumber,
  clientNumber,
  disableFilesData
) => {
  const cachedRequests = cacheRequests[socketNumber];
  delete cacheRequests[socketNumber];
  await sendData(waSockData, cachedRequests, socketNumber, clientNumber, disableFilesData);
};

const callback = (socketNumber, decryptedText) => {
  if (!sockets[socketNumber]) {
    logger(`Socket NOT In list -> ${socketNumber}`);
    const client = new net.Socket();

    client.connect(proxyPort, proxyHost, () => {
      logger(`STARTED Connection -> ${socketNumber}`);
      client.write(decryptedText);
    });

    client.on('data', (data) => {
      logger(`RECEIVING DATA [${data.length}] -> ${socketNumber}`);
      if (cacheTimers[socketNumber]) clearTimeout(cacheTimers[socketNumber]);
      if (!cacheRequests[socketNumber]) cacheRequests[socketNumber] = data;
      else
        cacheRequests[socketNumber] = Buffer.concat([
          cacheRequests[socketNumber],
          DELIMITER,
          data
        ]);
      cacheTimers[socketNumber] = setTimeout(
        sendCachedData,
        300,
        waSock, // Ahora waSock está definida en el ámbito superior
        socketNumber,
        clientNum,
        disableFiles
      );
    });

    client.on('end', () => {
      logger(`CLOSED -> ${socketNumber}`);
      delete sockets[socketNumber];
    });

    client.on('error', (e) => {
      logger('ERROR Client!', LOGGER_TYPES.ERROR);
      logger(e, LOGGER_TYPES.ERROR);
      delete sockets[socketNumber];
    });
    sockets[socketNumber] = client;
  } else {
    sockets[socketNumber].write(decryptedText);
  }
};

(async () => {
  waSock = await startSock(clientNum, callback, 'server');
  // waSock se inicializa y estará disponible para el callback
})();
