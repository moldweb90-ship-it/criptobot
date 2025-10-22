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
let depthWs = null;
let currentPrice = null;
let futuresPrice = null;

// Массив для хранения всех криптовалют
const cryptos = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT'];
let cryptoPrices = {};
let cryptoFuturesPrices = {};
let cryptoAnalytics = {};
let cryptoOrderBook = {};

// EWMA фильтры для Bid/Ask Ratio (α = 0.3)
let bidAskRatioFilters = {};

// Хранилище предыдущих значений Bid/Ask Ratio для обнаружения резких скачков
let previousBidAskRatio = {};

// Хранилище времени последней волатильности для каждой монеты
let volatilityTimers = {};

// Хранилище времени входа в диапазон для подтверждения сигналов
let rangeEntryTime = {
  long: {},   // { BTCUSDT: 1234567890, ... }
  short: {}
};

const CONFIRMATION_TIME = 20000; // 20 секунд в миллисекундах

// Функция для расчета EWMA (Exponentially Weighted Moving Average)
function calculateEWMA(currentValue, previousValue, alpha = 0.3) {
  if (previousValue === undefined || previousValue === null) {
    return currentValue;
  }
  return alpha * currentValue + (1 - alpha) * previousValue;
}

// Функция для ограничения значения в диапазоне [0.2, 5.0]
function clampBidAskRatio(ratio) {
  return Math.max(0.2, Math.min(5.0, ratio));
}

// Класс для расчета технических индикаторов
class TechnicalIndicators {
  constructor() {
    this.priceHistory = {};
    this.volumeHistory = {};
    this.timeframe = '15m'; // 15-минутный таймфрейм
    this.candleData = {}; // Данные свечей для 15-минутного таймфрейма
  }

  updateHistory(symbol, price, volume, timestamp, timeframe = '15m') {
    if (!this.priceHistory[symbol]) {
      this.priceHistory[symbol] = [];
      this.volumeHistory[symbol] = [];
      this.candleData[symbol] = [];
    }

    // Для 15-минутного таймфрейма группируем данные по 15-минутным интервалам
    const currentTime = new Date(timestamp);
    const candleTime = new Date(currentTime);
    candleTime.setMinutes(Math.floor(currentTime.getMinutes() / 15) * 15, 0, 0);

    // Находим или создаем свечу для текущего 15-минутного интервала
    let candle = this.candleData[symbol].find(c => c.time.getTime() === candleTime.getTime());
    
    if (!candle) {
      candle = {
        time: candleTime,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: volume,
        count: 1
      };
      this.candleData[symbol].push(candle);
    } else {
      // Обновляем существующую свечу
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
      // Для volume берем среднее, а не сумму (т.к. ticker.v - это 24h volume)
      candle.volume = (candle.volume * candle.count + volume) / (candle.count + 1);
      candle.count++;
    }

    // Ограничиваем историю до 200 свечей (50 часов на 15-минутном таймфрейме)
    if (this.candleData[symbol].length > 200) {
      this.candleData[symbol] = this.candleData[symbol].slice(-200);
    }

    // Обновляем массивы для расчетов индикаторов
    this.priceHistory[symbol] = this.candleData[symbol].map(c => ({ price: c.close, timestamp: c.time }));
    this.volumeHistory[symbol] = this.candleData[symbol].map(c => ({ volume: c.volume, timestamp: c.time }));
  }

  calculateEMA(prices, period) {
    if (prices.length < period) return null;
    
    const multiplier = 2 / (period + 1);
    let ema = prices[0];
    
    for (let i = 1; i < prices.length; i++) {
      ema = (prices[i] * multiplier) + (ema * (1 - multiplier));
    }
    
    return ema;
  }

  calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return null;
    
    // Используем сглаженный RSI для более стабильных значений на 15-минутном таймфрейме
    let avgGain = 0;
    let avgLoss = 0;
    
    // Первый расчет средних значений
    for (let i = 1; i <= period; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) avgGain += change;
      else avgLoss -= change;
    }
    
    avgGain /= period;
    avgLoss /= period;
    
    // Сглаживание для последующих значений
    for (let i = period + 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      
      avgGain = ((avgGain * (period - 1)) + gain) / period;
      avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    }
    
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    
    // Округляем до 2 знаков как на Binance и ограничиваем в разумных пределах
    return Math.max(0, Math.min(100, Math.round(rsi * 100) / 100));
  }

  calculateMACD(prices) {
    if (prices.length < 34) return null; // Нужно минимум 26 + 9 = 35 точек для Signal
    
    // Шаг 1: Рассчитываем EMA(12) и EMA(26) для всех доступных цен
    const ema12Values = [];
    const ema26Values = [];
    
    for (let i = 11; i < prices.length; i++) {
      ema12Values.push(this.calculateEMA(prices.slice(0, i + 1), 12));
    }
    
    for (let i = 25; i < prices.length; i++) {
      ema26Values.push(this.calculateEMA(prices.slice(0, i + 1), 26));
    }
    
    // Шаг 2: Рассчитываем MACD line = EMA(12) - EMA(26)
    const macdLine = [];
    const minLength = Math.min(ema12Values.length, ema26Values.length);
    
    for (let i = 0; i < minLength; i++) {
      const idx12 = ema12Values.length - minLength + i;
      const idx26 = i;
      macdLine.push(ema12Values[idx12] - ema26Values[idx26]);
    }
    
    if (macdLine.length < 9) return null;
    
    // Шаг 3: Рассчитываем Signal line = EMA(9) от MACD line
    const signalLine = this.calculateEMA(macdLine, 9);
    
    // Шаг 4: Рассчитываем Histogram = MACD line - Signal line
    const currentMacd = macdLine[macdLine.length - 1];
    const histogram = currentMacd - signalLine;
    
    return {
      macd: currentMacd,
      signal: signalLine,
      histogram: histogram
    };
  }

  calculateATR(prices, period = 14) {
    if (prices.length < period + 1) return null;
    
    let trSum = 0;
    for (let i = 1; i <= period; i++) {
      const high = prices[i];
      const low = prices[i - 1];
      const tr = Math.abs(high - low);
      trSum += tr;
    }
    
    return trSum / period;
  }

  calculateVolumeRatio(volumes) {
    if (volumes.length < 20) return null;
    
    // Извлекаем объемы из объектов { volume, timestamp }
    const volumeValues = volumes.map(v => v.volume || v);
    
    // Берем последние 20 значений
    const last20 = volumeValues.slice(-20);
    
    // Вычисляем медиану для определения порога аномалий
    const sorted = [...last20].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    
    // Фильтруем аномальные объемы (больше 3x медианы)
    const threshold = median * 3;
    const filteredVolumes = last20.filter(v => v <= threshold);
    
    // Если после фильтрации осталось меньше 10 значений - данных недостаточно
    if (filteredVolumes.length < 10) return null;
    
    // Делим на две группы: последние 5 и предыдущие
    const recentCount = Math.min(5, Math.floor(filteredVolumes.length / 4));
    const recent = filteredVolumes.slice(-recentCount);
    const older = filteredVolumes.slice(-filteredVolumes.length, -recentCount);
    
    if (older.length === 0) return null;
    
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
    
    const ratio = avgRecent / avgOlder;
    
    return ratio;
  }

  getAnalytics(symbol) {
    const prices = this.priceHistory[symbol];
    const volumes = this.volumeHistory[symbol];
    
    if (!prices || prices.length < 2) return null;
    
    let priceArray = prices.map(p => p.price);
    const volumeArray = volumes.map(v => v.volume);
    
    // Добавляем текущую цену для обновления индикаторов в реальном времени
    const currentSpotPrice = cryptoPrices[symbol] ? cryptoPrices[symbol].price : null;
    if (currentSpotPrice && priceArray.length > 0) {
      // Заменяем последнюю цену на текущую для более точных расчетов
      priceArray[priceArray.length - 1] = currentSpotPrice;
    }
    
    const currentPrice = priceArray[priceArray.length - 1];
    const priceArrayLength = priceArray.length;
    
    const ema9 = priceArrayLength >= 3 ? this.calculateEMA(priceArray, Math.min(9, priceArrayLength)) : currentPrice;
    const ema21 = priceArrayLength >= 3 ? this.calculateEMA(priceArray, Math.min(21, priceArrayLength)) : currentPrice;
    const ema50 = priceArrayLength >= 3 ? this.calculateEMA(priceArray, Math.min(50, priceArrayLength)) : currentPrice;
    
      // Определяем тренд: EMA9 > EMA21 > EMA50 (восходящий) или EMA9 < EMA21 < EMA50 (нисходящий)
      const isUptrend = ema9 > ema21 && ema21 > ema50;
      const isDowntrend = ema9 < ema21 && ema21 < ema50;
      
      // Анализ Bid/Ask Ratio для определения силы покупателей и продавцов
      const orderBookData = cryptoOrderBook[symbol] || null;
      const bidAskRatio = orderBookData?.bidAskRatio || 1.0;
      let bidAskConfidence = 0;
      let bidAskSignal = 'neutral'; // neutral, weak, good, strong, short-weak, short-strong, short-aggressive, volatile
      
      // Проверка на резкие скачки Bid/Ask Ratio
      const prevRatio = previousBidAskRatio[symbol] || bidAskRatio;
      const ratioChange = Math.abs(bidAskRatio - prevRatio);
      const currentTime = Date.now();

      // Сохраняем текущее значение для следующей проверки
      previousBidAskRatio[symbol] = bidAskRatio;

      // Проверяем, есть ли активный таймер волатильности
      const lastVolatilityTime = volatilityTimers[symbol] || 0;
      const timeSinceVolatility = currentTime - lastVolatilityTime;
      const isVolatilityActive = timeSinceVolatility < 10000; // 10 секунд

      // Жёсткие пороги для однозначных сигналов
      // Если изменение > 1.0 - это волатильность (спуфинг), игнорируем
      if (ratioChange > 1.0) {
        bidAskSignal = 'volatile';
        bidAskConfidence = 0;
        // Запускаем таймер волатильности на 10 секунд
        volatilityTimers[symbol] = currentTime;
        // Сбрасываем таймеры подтверждения
        rangeEntryTime.long[symbol] = null;
        rangeEntryTime.short[symbol] = null;
      } else if (isVolatilityActive) {
        // Если таймер волатильности еще активен, показываем крестик
        bidAskSignal = 'volatile';
        bidAskConfidence = 0;
        // Сбрасываем таймеры подтверждения
        rangeEntryTime.long[symbol] = null;
        rangeEntryTime.short[symbol] = null;
      } else if (ratioChange <= 0.8) {
        // Стабильные значения - проверяем диапазоны с подтверждением 20 секунд
        
        // Проверяем LONG диапазон (2.0x - 5.0x)
        if (bidAskRatio >= 2.0 && bidAskRatio <= 5.0) {
          if (!rangeEntryTime.long[symbol]) {
            rangeEntryTime.long[symbol] = currentTime; // Первый вход в диапазон
          }
          
          const timeInLongRange = currentTime - rangeEntryTime.long[symbol];
          
          if (timeInLongRange >= CONFIRMATION_TIME) {
            // Подтверждено 20 секунд в диапазоне
            bidAskConfidence = 20;
            bidAskSignal = 'long';
          }
          
          // Сбрасываем SHORT таймер
          rangeEntryTime.short[symbol] = null;
          
        } else if (bidAskRatio >= 0.10 && bidAskRatio <= 0.90) {
          // Проверяем SHORT диапазон (0.10x - 0.90x)
          if (!rangeEntryTime.short[symbol]) {
            rangeEntryTime.short[symbol] = currentTime; // Первый вход в диапазон
          }
          
          const timeInShortRange = currentTime - rangeEntryTime.short[symbol];
          
          if (timeInShortRange >= CONFIRMATION_TIME) {
            // Подтверждено 20 секунд в диапазоне
            bidAskConfidence = 20;
            bidAskSignal = 'short';
          }
          
          // Сбрасываем LONG таймер
          rangeEntryTime.long[symbol] = null;
          
        } else {
          // Вне диапазонов - сбрасываем оба таймера
          rangeEntryTime.long[symbol] = null;
          rangeEntryTime.short[symbol] = null;
        }
      } else {
        // Изменение > 0.8 и ≤ 1.0 - неопределенность, сбрасываем таймеры
        rangeEntryTime.long[symbol] = null;
        rangeEntryTime.short[symbol] = null;
      }
      
      // Отладочная информация для BTCUSDT
      if (symbol === 'BTCUSDT') {
        const volumeRatio = volumeArray.length >= 20 ? this.calculateVolumeRatio(volumeArray) : null;
        const volumeValues = volumeArray.map(v => v.volume || v);
        const last20 = volumeValues.slice(-20);
        const sorted = [...last20].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const threshold = median * 3;
        const filtered = last20.filter(v => v <= threshold);
        const anomalies = last20.filter(v => v > threshold);
        
        console.log(`🔍 ${symbol} Volume Ratio Analysis:`, {
          volumeHistoryLength: volumeArray.length,
          volumeRatio: volumeRatio ? volumeRatio.toFixed(2) : 'null',
          median: median.toFixed(0),
          threshold: threshold.toFixed(0),
          anomaliesDetected: anomalies.length,
          anomalyValues: anomalies.map(v => v.toFixed(0)),
          filteredCount: filtered.length,
          recentVolumes: volumeValues.slice(-5).map(v => v.toFixed(0))
        });
      }
      
      // Анализ Volume Ratio для определения силы тренда
      const volumeRatio = volumeArray.length >= 20 ? this.calculateVolumeRatio(volumeArray) : null;
      let volumeConfidence = 0;
      let volumeSignal = 'neutral'; // neutral, long-weak, long-strong, short-weak, short-strong, caution, anomaly, critical
      
      if (volumeRatio !== null) {
        if (volumeRatio >= 20.0) {
          // Критическая аномалия
          volumeSignal = 'critical';
          volumeConfidence = 0;
        } else if (volumeRatio > 19.99) {
          // Аномалия (красный крестик)
          volumeSignal = 'anomaly';
          volumeConfidence = 0;
        } else if (volumeRatio >= 3.0 && volumeRatio <= 19.99) {
          // Желтый кружок - осторожность
          volumeSignal = 'caution';
          volumeConfidence = 0;
        } else if (volumeRatio >= 2.0 && volumeRatio < 3.0) {
          // Сильный рост объема → +20% к LONG
          volumeSignal = 'long-strong';
          volumeConfidence = 20;
        } else if (volumeRatio >= 1.5 && volumeRatio < 2.0) {
          // Объем растет → +10% к LONG
          volumeSignal = 'long-weak';
          volumeConfidence = 10;
        } else if (volumeRatio < 0.5) {
          // Сильное падение объема → +20% к SHORT
          volumeSignal = 'short-strong';
          volumeConfidence = 20;
        } else if (volumeRatio < 0.7) {
          // Объем падает → +10% к SHORT
          volumeSignal = 'short-weak';
          volumeConfidence = 10;
        } else {
          // Стабильный объем (0.7 - 1.5)
          volumeSignal = 'neutral';
          volumeConfidence = 0;
        }
      }
      
      // Комбинируем EMA тренд с Bid/Ask анализом и Volume Ratio
      let longPercentage = 0;
      let shortPercentage = 0;
      
      // Определяем тип Bid/Ask сигнала
      const isLongSignal = bidAskSignal === 'long';
      const isShortSignal = bidAskSignal === 'short';
      
      // Определяем тип Volume сигнала
      const isVolumeLongSignal = volumeSignal === 'long-weak' || volumeSignal === 'long-strong';
      const isVolumeShortSignal = volumeSignal === 'short-weak' || volumeSignal === 'short-strong';
      
      if (isUptrend) {
        longPercentage = 20 + (isLongSignal ? bidAskConfidence : 0) + (isVolumeLongSignal ? volumeConfidence : 0);
      } else if (isDowntrend) {
        shortPercentage = 20 + (isShortSignal ? bidAskConfidence : 0) + (isVolumeShortSignal ? volumeConfidence : 0);
        // НО Bid/Ask LONG сигнал все равно добавляет уверенность к LONG
        if (isLongSignal && bidAskConfidence > 0) {
          longPercentage = bidAskConfidence + (isVolumeLongSignal ? volumeConfidence : 0);
        }
      } else {
        // Если EMA нейтральный, но есть Bid/Ask или Volume сигнал
        if (isLongSignal && bidAskConfidence > 0) {
          longPercentage = bidAskConfidence + (isVolumeLongSignal ? volumeConfidence : 0);
        } else if (isShortSignal && bidAskConfidence > 0) {
          shortPercentage = bidAskConfidence + (isVolumeShortSignal ? volumeConfidence : 0);
        } else {
          // Только Volume сигнал
          if (isVolumeLongSignal) {
            longPercentage = volumeConfidence;
          } else if (isVolumeShortSignal) {
            shortPercentage = volumeConfidence;
          }
        }
      }
    
    return {
      ema9: ema9,
      ema21: ema21,
      ema50: ema50,
      rsi: priceArrayLength >= 3 ? this.calculateRSI(priceArray, Math.min(14, priceArrayLength - 1)) : 50,
      macd: priceArrayLength >= 3 ? this.calculateMACD(priceArray) : { macd: 0, signal: 0, histogram: 0 },
      atr: priceArrayLength >= 3 ? this.calculateATR(priceArray, Math.min(14, priceArrayLength - 1)) : 0,
      volumeRatio: volumeRatio,
      // Новые поля для тренда
      isUptrend: isUptrend,
      isDowntrend: isDowntrend,
      longPercentage: longPercentage,
      shortPercentage: shortPercentage,
      // Bid/Ask анализ
      bidAskRatio: bidAskRatio,
      bidAskConfidence: bidAskConfidence,
      bidAskSignal: bidAskSignal,
      // Volume анализ
      volumeConfidence: volumeConfidence,
      volumeSignal: volumeSignal
    };
  }
}

const indicators = new TechnicalIndicators();

// Получение реальных исторических данных с Binance для 15-минутного таймфрейма
async function fetchHistoricalData(symbol) {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`);
    const data = await response.json();
    
    data.forEach(candle => {
      const [timestamp, open, high, low, close, volume] = candle;
      indicators.updateHistory(symbol, parseFloat(close), parseFloat(volume), new Date(timestamp).toISOString(), '15m');
    });
    
    console.log(`✅ Исторические данные для ${symbol} загружены (${data.length} свечей)`);
  } catch (error) {
    console.error(`❌ Ошибка загрузки исторических данных для ${symbol}:`, error.message);
  }
}

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
    
    const price = parseFloat(ticker.c);
    const volume = parseFloat(ticker.v);
    const timestamp = new Date().toISOString();
    
    cryptoPrices[ticker.s] = {
      symbol: ticker.s,
      price: price,
      change24h: parseFloat(ticker.P),
      high24h: parseFloat(ticker.h),
      low24h: parseFloat(ticker.l),
      volume24h: volume,
      timestamp: timestamp,
      rawData: ticker.c
    };

    // Обновляем историю для расчета индикаторов (15-минутный таймфрейм)
    indicators.updateHistory(ticker.s, price, volume, timestamp, '15m');


    console.log(`📊 ${ticker.s}: $${price}`);

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

function connectToDepth() {
  const depthStreams = cryptos.map(symbol => `${symbol.toLowerCase()}@depth20`).join('/');
  depthWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${depthStreams}`);
  
  depthWs.on('open', () => {
    console.log('✅ Подключено к Binance Depth WebSocket для всех монет');
  });

  depthWs.on('message', (data) => {
    const message = JSON.parse(data);
    const depth = message.data;
    
    // Извлекаем символ из названия потока (например: "btcusdt@depth20" -> "BTCUSDT")
    const symbol = message.stream.split('@')[0].toUpperCase();
    
    // Отладочная информация
    console.log('🔍 Depth message:', message.stream, 'Symbol:', symbol);
    
    // Проверяем что у нас есть все необходимые данные
    if (!symbol || !depth.bids || !depth.asks || depth.bids.length === 0 || depth.asks.length === 0) {
      console.log('⚠️ Неполные данные depth:', depth);
      return;
    }
    
    // Рассчитываем ликвидность и spread
    const bestBid = parseFloat(depth.bids[0][0]);
    const bestAsk = parseFloat(depth.asks[0][0]);
    const spread = bestAsk - bestBid;
    const spreadPercent = (spread / bestBid) * 100;
    
    // Рассчитываем mid цену
    const midPrice = (bestBid + bestAsk) / 2;
    
    // Определяем окно ±0.10% от mid цены
    const priceWindow = midPrice * 0.001; // 0.10%
    const minPrice = midPrice - priceWindow;
    const maxPrice = midPrice + priceWindow;
    
    // Суммируем объемы в долларах только в пределах ±0.10% окна
    const bidVolumeUSD = depth.bids.reduce((sum, [price, volume]) => {
      const priceFloat = parseFloat(price);
      if (priceFloat >= minPrice && priceFloat <= maxPrice) {
        return sum + (priceFloat * parseFloat(volume));
      }
      return sum;
    }, 0);
    
    const askVolumeUSD = depth.asks.reduce((sum, [price, volume]) => {
      const priceFloat = parseFloat(price);
      if (priceFloat >= minPrice && priceFloat <= maxPrice) {
        return sum + (priceFloat * parseFloat(volume));
      }
      return sum;
    }, 0);
    
    const totalLiquidity = bidVolumeUSD + askVolumeUSD;
    
    // Дополнительная информация о ликвидности (топ-5 уровней)
    const top5BidVolumeUSD = depth.bids.slice(0, 5).reduce((sum, [price, volume]) => {
      return sum + (parseFloat(price) * parseFloat(volume));
    }, 0);
    const top5AskVolumeUSD = depth.asks.slice(0, 5).reduce((sum, [price, volume]) => {
      return sum + (parseFloat(price) * parseFloat(volume));
    }, 0);
    
    // Рассчитываем сырой Bid/Ask Ratio
    const rawBidAskRatio = bidVolumeUSD / askVolumeUSD;
    
    // Применяем EWMA фильтр для сглаживания
    const previousFilteredRatio = bidAskRatioFilters[symbol];
    const filteredRatio = calculateEWMA(rawBidAskRatio, previousFilteredRatio, 0.3);
    
    // Ограничиваем значение в диапазоне [0.2, 5.0]
    const clampedRatio = clampBidAskRatio(filteredRatio);
    
    // Сохраняем отфильтрованное значение для следующего расчета
    bidAskRatioFilters[symbol] = filteredRatio;
    
    cryptoOrderBook[symbol] = {
      symbol: symbol,
      bestBid: bestBid,
      bestAsk: bestAsk,
      spread: spread,
      spreadPercent: spreadPercent,
      bidVolume: bidVolumeUSD,
      askVolume: askVolumeUSD,
      totalLiquidity: totalLiquidity,
      top5BidVolume: top5BidVolumeUSD,
      top5AskVolume: top5AskVolumeUSD,
      top5Liquidity: top5BidVolumeUSD + top5AskVolumeUSD,
      bidAskRatio: rawBidAskRatio, // Используем сырое значение для анализа
      bidAskRatioFiltered: clampedRatio, // Отфильтрованное значение для отображения
      rawBidAskRatio: rawBidAskRatio, // Сохраняем сырое значение для отладки
      timestamp: new Date().toISOString()
    };

    console.log(`📊 ${symbol} OrderBook: Spread ${spreadPercent.toFixed(4)}%, Liquidity (±0.10%): $${totalLiquidity.toFixed(2)}, B/A Ratio: ${rawBidAskRatio.toFixed(2)}x → ${clampedRatio.toFixed(2)}x (filtered)`);

    // Отправляем обновленные данные всем клиентам
    sendAllPricesToClients();
  });

  depthWs.on('error', (error) => {
    console.error('❌ Ошибка Depth WS:', error);
  });

  depthWs.on('close', () => {
    console.log('⚠️ Depth WS закрыт. Переподключение через 5 сек...');
    setTimeout(connectToDepth, 5000);
  });
}

function sendAllPricesToClients() {
  const allPrices = {};
  
  // Собираем данные по всем монетам
  cryptos.forEach(symbol => {
    if (cryptoPrices[symbol] && cryptoFuturesPrices[symbol]) {
      // Получаем аналитику для символа (15-минутный таймфрейм)
      const analytics = indicators.getAnalytics(symbol);
      
      // Получаем данные стакана заявок
      const orderBookData = cryptoOrderBook[symbol];
      
      allPrices[symbol] = {
        spot: cryptoPrices[symbol],
        futures: cryptoFuturesPrices[symbol],
        spread: cryptoFuturesPrices[symbol].price - cryptoPrices[symbol].price,
        spreadPercent: ((cryptoFuturesPrices[symbol].price - cryptoPrices[symbol].price) / cryptoPrices[symbol].price * 100).toFixed(3),
        orderBook: orderBookData || {
          bestBid: null,
          bestAsk: null,
          spread: null,
          spreadPercent: null,
          bidVolume: null,
          askVolume: null,
          totalLiquidity: null,
          bidAskRatio: null
        },
        analytics: analytics || {
          ema9: null,
          ema21: null,
          ema50: null,
          rsi: null,
          macd: null,
          atr: null,
          volumeRatio: null
        },
        timeframe: '15m' // Указываем таймфрейм
      };
    }
  });

  // Отправляем данные МГНОВЕННО всем подключенным клиентам
  if (Object.keys(allPrices).length > 0) {
    const dataString = JSON.stringify(allPrices);
    
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(dataString);
        } catch (error) {
          console.error(`❌ Ошибка отправки данных клиенту:`, error);
        }
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

// Загружаем реальные исторические данные с Binance для всех криптовалют
async function initializeRealData() {
  console.log('🔄 Загружаем реальные исторические данные с Binance...');
  
  for (const symbol of cryptos) {
    await fetchHistoricalData(symbol);
    // Небольшая задержка чтобы не превысить лимиты API
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log('✅ Все исторические данные загружены, запускаем WebSocket соединения...');
}

// Инициализируем реальные данные
initializeRealData();

connectToBinance();
connectToFutures();
connectToDepth();

// Периодическое обновление индикаторов в реальном времени (каждые 2 секунды)
setInterval(() => {
  // Отправляем обновленные данные всем клиентам с актуальными индикаторами
  sendAllPricesToClients();
}, 2000);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});

