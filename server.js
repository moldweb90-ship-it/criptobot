import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.static('public'));

let binanceWs = null;
let futuresWs = null;
let currentPrice = null;
let futuresPrice = null;

// Массив для хранения всех криптовалют
const cryptos = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT'];
let cryptoPrices = {};
let cryptoFuturesPrices = {};

function connectToBinance() {
  // Создаем WebSocket для всех криптовалют
  const streams = cryptos.map(symbol => `${symbol.toLowerCase()}@ticker`).join('/');
  binanceWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
  
  binanceWs.on('open', () => {
    console.log('✅ Подключено к Binance WebSocket для всех монет');
  });

  binanceWs.on('message', (data) => {
    const message = JSON.parse(data);
    const ticker = message.data;
    
    cryptoPrices[ticker.s] = {
      symbol: ticker.s,
      price: parseFloat(ticker.c),
      change24h: parseFloat(ticker.P),
      high24h: parseFloat(ticker.h),
      low24h: parseFloat(ticker.l),
      volume24h: parseFloat(ticker.v),
      timestamp: new Date().toISOString(),
      rawData: ticker.c
    };

    console.log(`📊 ${ticker.s}: $${cryptoPrices[ticker.s].price}`);

    // Отправляем обновленные данные всем клиентам
    sendAllPricesToClients();
  });

  binanceWs.on('error', (error) => {
    console.error('❌ Ошибка Binance WS:', error);
  });

  binanceWs.on('close', () => {
    console.log('⚠️ Binance WS закрыт. Переподключение через 5 сек...');
    setTimeout(connectToBinance, 5000);
  });
}

function connectToFutures() {
  // Создаем WebSocket для всех фьючерсов
  const streams = cryptos.map(symbol => `${symbol.toLowerCase()}@ticker`).join('/');
  futuresWs = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
  
  futuresWs.on('open', () => {
    console.log('✅ Подключено к Binance Futures WebSocket для всех монет');
  });

  futuresWs.on('message', (data) => {
    const message = JSON.parse(data);
    const ticker = message.data;
    
    cryptoFuturesPrices[ticker.s] = {
      symbol: ticker.s,
      price: parseFloat(ticker.c),
      change24h: parseFloat(ticker.P),
      high24h: parseFloat(ticker.h),
      low24h: parseFloat(ticker.l),
      volume24h: parseFloat(ticker.v),
      timestamp: new Date().toISOString(),
      rawData: ticker.c
    };

    console.log(`📈 ${ticker.s} Futures: $${cryptoFuturesPrices[ticker.s].price}`);
    
    // Отправляем обновленные данные всем клиентам
    sendAllPricesToClients();
  });

  futuresWs.on('error', (error) => {
    console.error('❌ Ошибка Futures WS:', error);
  });

  futuresWs.on('close', () => {
    console.log('⚠️ Futures WS закрыт. Переподключение через 5 сек...');
    setTimeout(connectToFutures, 5000);
  });
}

function sendAllPricesToClients() {
  const allPrices = {};
  
  // Собираем данные по всем монетам
  cryptos.forEach(symbol => {
    if (cryptoPrices[symbol] && cryptoFuturesPrices[symbol]) {
      allPrices[symbol] = {
        spot: cryptoPrices[symbol],
        futures: cryptoFuturesPrices[symbol],
        spread: cryptoFuturesPrices[symbol].price - cryptoPrices[symbol].price,
        spreadPercent: ((cryptoFuturesPrices[symbol].price - cryptoPrices[symbol].price) / cryptoPrices[symbol].price * 100).toFixed(3)
      };
    }
  });

  // Отправляем только если есть данные
  if (Object.keys(allPrices).length > 0) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(allPrices));
      }
    });
  }
}

wss.on('connection', (ws) => {
  console.log('👤 Новый клиент подключен');
  
  // Отправляем текущие данные если они есть
  sendAllPricesToClients();

  ws.on('close', () => {
    console.log('👤 Клиент отключен');
  });
});

connectToBinance();
connectToFutures();

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});

