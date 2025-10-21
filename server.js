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

function connectToBinance() {
  binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');
  
  binanceWs.on('open', () => {
    console.log('✅ Подключено к Binance WebSocket');
  });

  binanceWs.on('message', (data) => {
    const ticker = JSON.parse(data);
    currentPrice = {
      symbol: ticker.s,
      price: parseFloat(ticker.c),
      change24h: parseFloat(ticker.P),
      high24h: parseFloat(ticker.h),
      low24h: parseFloat(ticker.l),
      volume24h: parseFloat(ticker.v),
      timestamp: new Date().toISOString(),
      rawData: ticker.c // для отладки
    };

    // Логируем каждое обновление
    console.log(`📊 BTC: $${currentPrice.price} (${currentPrice.timestamp})`);

    // Отправляем futures данные
    if (futuresPrice) {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(futuresPrice));
        }
      });
    }
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
  futuresWs = new WebSocket('wss://fstream.binance.com/ws/btcusdt@ticker');
  
  futuresWs.on('open', () => {
    console.log('✅ Подключено к Binance Futures WebSocket');
  });

  futuresWs.on('message', (data) => {
    const ticker = JSON.parse(data);
    futuresPrice = {
      symbol: ticker.s,
      price: parseFloat(ticker.c),
      change24h: parseFloat(ticker.P),
      high24h: parseFloat(ticker.h),
      low24h: parseFloat(ticker.l),
      volume24h: parseFloat(ticker.v),
      timestamp: new Date().toISOString(),
      rawData: ticker.c
    };

    console.log(`📈 BTC Futures: $${futuresPrice.price} (${futuresPrice.timestamp})`);
    
    // Отправляем futures данные
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(futuresPrice));
      }
    });
  });

  futuresWs.on('error', (error) => {
    console.error('❌ Ошибка Futures WS:', error);
  });

  futuresWs.on('close', () => {
    console.log('⚠️ Futures WS закрыт. Переподключение через 5 сек...');
    setTimeout(connectToFutures, 5000);
  });
}

wss.on('connection', (ws) => {
  console.log('👤 Новый клиент подключен');
  
  if (futuresPrice) {
    ws.send(JSON.stringify(futuresPrice));
  }

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

