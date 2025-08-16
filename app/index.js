require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const { Mistral } = require('@mistralai/mistralai'); 
const { HfInference } = require('@huggingface/inference');
const fs = require('fs').promises; // Для сохранения файлов
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
const hf = new HfInference(process.env.HF_API_KEY);

app.use(express.static('public')); // Для сервировки Mini App файлов

// Создай папку public/images, если нет (можно добавить в код или вручную)
const imagesDir = path.join(__dirname, 'public/images');
fs.mkdir(imagesDir, { recursive: true }).catch(() => {});

// Хранение комнат: { roomId: { players: [socket1, socket2, socket3], state: { level: 1, turn: 'gm', history: [] }, gmPrompt: '' } }
const rooms = {};

// Системный промпт для GM (Mistral)
const systemPrompt = `Ты - мастер игры в тёмном фэнтези подземелье. Игра на 3 игроков, цель - пройти 5 уровней, каждый сложнее предыдущего. В конце 5-го - босс. Описывай ситуации кратко, красиво, до 250 символов. Реагируй на действия игроков ("use", "cancel", "say"). Сложность растёт: level {level}. Текущая ситуация: {history}.`;

// Генерация изображения (теперь с Hugging Face FLUX.1-schnell для скорости)
async function generateImage(description) {
  const blob = await hf.textToImage({
    model: 'black-forest-labs/FLUX.1-schnell', // stabilityai/sdxl-turbo // качество ниже скорость ~1секунда
    inputs: `Dark fantasy dungeon scene: ${description}. Moody, gothic, high detail.`,
    parameters: {
      num_inference_steps: 4, // Минимально для скорости (schnell оптимизирован под 1-4 шага)
      guidance_scale: 0, // Не нужен для schnell, ускоряет
      width: 512, // Меньший размер для скорости
      height: 512,
    },
  });

  const buffer = Buffer.from(await blob.arrayBuffer());
  const filename = `image_${Date.now()}.png`;
  const filePath = path.join(imagesDir, filename);
  await fs.writeFile(filePath, buffer);

  // Возвращаем URL (предполагая, что сервер на localhost:PORT; в проде замени на domain)
  return `${process.env.DOMAIN}:${process.env.PORT}/images/${filename}`;
}

// Socket.io логика
io.on('connection', (socket) => {
  socket.on('createRoom', () => {
    const roomId = Math.random().toString(36).substring(7);
    rooms[roomId] = { players: [socket], state: { level: 1, turn: 'gm', history: [] } };
    socket.join(roomId);
    socket.emit('roomCreated', roomId);
  });

  socket.on('joinRoom', (roomId, username) => {
    if (rooms[roomId] && rooms[roomId].players.length < 3) {
      socket.username = username; // Сохраняем username из Telegram initData
      rooms[roomId].players.push(socket);
      socket.join(roomId);
      io.to(roomId).emit('playerJoined', rooms[roomId].players.map(s => s.username));
      if (rooms[roomId].players.length === 3) {
        startGame(roomId);
      }
    } else {
      socket.emit('error', 'Room full or not found');
    }
  });

  socket.on('action', async ({ roomId, type, text }) => {
    const room = rooms[roomId];
    if (!room || room.state.turn !== room.players.findIndex(s => s.id === socket.id) + 1) return; // Проверка хода

    if (type === 'say') {
      io.to(roomId).emit('sayMessage', { from: socket.username, text }); // Broadcast всем
    } else {
      // Отправка к GM (use или cancel)
      room.state.history.push(`${socket.username} ${type}: ${text}`);
      const gmResponse = await getGmResponse(room);
      const imageUrl = await generateImage(gmResponse);
      io.to(roomId).emit('gmUpdate', { text: gmResponse, image: imageUrl });
      room.state.history.push(`GM: ${gmResponse}`);

      // Следующий ход
      nextTurn(roomId);
    }
  });
});

async function startGame(roomId) {
  const room = rooms[roomId];
  const initialSituation = await getGmResponse(room, true); // Первая ситуация
  const imageUrl = await generateImage(initialSituation);
  io.to(roomId).emit('gameStart', { text: initialSituation, image: imageUrl });
  room.state.history.push(`GM: ${initialSituation}`);
  room.state.turn = 1; // Первый игрок
}

async function getGmResponse(room, isInitial = false) {
  const prompt = systemPrompt.replace('{level}', room.state.level).replace('{history}', room.state.history.join('\n'));
  const userMessage = isInitial ? 'Начни игру: опиши вход в подземелье.' : 'Опиши результат действий и новую ситуацию.';
  const response = await mistral.chat({
    model: 'mistral-large-latest',
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: userMessage }],
  });
  return response.choices[0].message.content.slice(0, 250);
}

function nextTurn(roomId) {
  const room = rooms[roomId];
  let currentTurn = typeof room.state.turn === 'number' ? room.state.turn : 0;
  currentTurn++;
  if (currentTurn > 3) {
    // После последнего игрока - GM новый раунд
    room.state.turn = 'gm';
    io.to(roomId).emit('gmTurn');
    // Авто-GM после паузы или по событию
    setTimeout(async () => {
      const gmResponse = await getGmResponse(room);
      const imageUrl = await generateImage(gmResponse);
      io.to(roomId).emit('gmUpdate', { text: gmResponse, image: imageUrl });
      room.state.history.push(`GM: ${gmResponse}`);
      if (gmResponse.includes('level complete')) room.state.level++; // Логика прогресса (доработай по промпту)
      if (room.state.level > 5) io.to(roomId).emit('gameEnd');
      room.state.turn = 1;
    }, 2000);
  } else {
    room.state.turn = currentTurn;
    io.to(roomId).emit('playerTurn', currentTurn);
  }
}

// Бот: Кнопка для Mini App
bot.start((ctx) => {
  ctx.reply('Добро пожаловать в подземелье!', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Старт', web_app: { url: `${process.env.DOMAIN}:${process.env.PORT}/app.html` } }]],
    },
  });
});
bot.launch();

server.listen(process.env.PORT, () => console.log(`Server on port ${process.env.PORT}`));