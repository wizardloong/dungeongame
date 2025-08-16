require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const { Mistral } = require('@mistralai/mistralai');
const { HfInference } = require('@huggingface/inference');
const fs = require('fs').promises;
const path = require('path');

// Добавляем отладочные логи
const DEBUG_LOGS = true;
function log(...args) {
  if (DEBUG_LOGS) {
    console.log(`[${new Date().toISOString()}]`, ...args);
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 10000
});
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
const hf = new HfInference(process.env.HF_API_KEY);

// Режим отладки
const DEBUG_MODE = process.env.DEBUG_MODE === 'true' || false;
log(`DEBUG_MODE: ${DEBUG_MODE}`);

// Статические файлы
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Явные маршруты для HTML
app.get('/', (req, res) => {
  log(`Request to root, redirecting to /app.html`);
  res.redirect('/app.html');
});

app.get('/app.html', (req, res) => {
  log(`Request to /app.html, serving file`);
  res.sendFile(path.join(publicDir, 'app.html'));
});

// Обработка ошибок 404
app.use((req, res) => {
  log(`404 для ${req.url}`);
  res.status(404).send('Not found');
});

// Создаем папку для изображений
const imagesDir = path.join(__dirname, 'public/images');
fs.mkdir(imagesDir, { recursive: true })
  .then(() => log(`Папка для изображений создана: ${imagesDir}`))
  .catch(err => log(`Ошибка создания папки: ${err}`));

// Проверяем наличие fallback изображения
const fallbackImagePath = path.join(publicDir, 'fallback-image.png');
fs.access(fallbackImagePath)
  .then(() => log(`Fallback изображение найдено`))
  .catch(() => {
    log(`Fallback изображение не найдено, создаем пустое изображение`);
    // Заменяем некорректную копию socket.io на заглушку
    fs.writeFile(fallbackImagePath, Buffer.from(''))
      .catch(err => log(`Не удалось создать fallback изображение: ${err}`));
  });

// Хранение комнат
const rooms = {};

// Системный промпт для GM
const systemPrompt = `Ты - мастер игры в тёмном фэнтези подземелье. Игра ${DEBUG_MODE ? 'в режиме отладки на 1 игрока' : 'на 3 игроков'}, цель - пройти 5 уровней. Не используй Markdown.

КОНТЕКСТ:
- Текущий уровень: {level}
- Цель уровня: {levelGoal}
- Память игры: {gameMemory}
- Последние события: {recentHistory}

ИНСТРУКЦИИ:
1. Всегда помни контекст и историю
2. Кратко описывай ситуации (до 150 симв.)
3. Реагируй на действия: "use", "cancel", "say"
4. Ссылайся на предыдущие события
5. Сложность растёт с уровнем`;

// Генерация изображения
async function generateImage(description) {
  try {
    log(`Генерируем изображение для: "${description.substring(0, 30)}..."`);
    
    if (process.env.FAST_DEBUG === 'true') {
      log('Режим быстрой отладки - пропускаем генерацию изображения');
      return `${process.env.DOMAIN}/fallback-image.png`;
    }
    
    const blob = await hf.textToImage({
      model: 'black-forest-labs/FLUX.1-schnell',
      inputs: `Dark fantasy dungeon scene: ${description}. Moody, gothic, high detail.`,
      parameters: {
        num_inference_steps: 4,
        guidance_scale: 0,
        width: 512,
        height: 512,
      },
    });

    const buffer = Buffer.from(await blob.arrayBuffer());
    const filename = `image_${Date.now()}.png`;
    const filePath = path.join(imagesDir, filename);
    await fs.writeFile(filePath, buffer);
    log(`Изображение сохранено: ${filename}`);

    return `${process.env.DOMAIN}/images/${filename}`;
  } catch (err) {
    log(`Ошибка генерации изображения: ${err}`);
    return `${process.env.DOMAIN}/fallback-image.png`;
  }
}

// Socket.io логика
const connectedSockets = new Set();
const connectedUsers = new Map();
io.on('connection', (socket) => {
  log(`Новое соединение: ${socket.id}`);
  
  if (connectedSockets.has(socket.id)) {
    log(`Дубликат соединения, отключаем: ${socket.id}`);
    socket.disconnect();
    return;
  }
  connectedSockets.add(socket.id);

  socket.on('createRoom', (username) => {
    log(`createRoom запрошен пользователем: ${socket.id}, username=${username}`);

    if (socket.roomId) {
      log(`Пользователь уже в комнате: ${socket.roomId}`);
      return socket.emit('error', { message: 'Вы уже находитесь в комнате' });
    }
    
    const roomId = Math.random().toString(36).substring(7);
    socket.roomId = roomId;
    socket.username = username || `Player-${socket.id.substring(0, 4)}`;
    
    rooms[roomId] = {
      players: [socket],
      state: {
        level: 1,
        turn: 'gm',
        history: [],
        levelGoals: {},
        gameMemory: [],
        levelMemory: ""
      }
    };
    
    socket.join(roomId);
    log(`Комната создана: ${roomId}`);
    socket.emit('roomCreated', roomId);
    
    if (!DEBUG_MODE) {
      log(`Установка таймера ожидания для комнаты: ${roomId}`);
      rooms[roomId].timeout = setTimeout(() => {
        if (rooms[roomId] && rooms[roomId].players.length < getRequiredPlayersCount()) {
          log(`Время ожидания истекло для комнаты: ${roomId}`);
          io.to(roomId).emit('error', { message: 'Недостаточно игроков для начала игры' });
          delete rooms[roomId];
        }
      }, 120000);
    } else {
      log(`Режим отладки - используем username: ${socket.username}`);
      const playerNames = [socket.username];
      io.to(roomId).emit('playersUpdate', playerNames);
      log(`Запускаем игру в режиме отладки для комнаты: ${roomId}`);
      startGame(roomId);
    }
  });

  socket.on('joinRoom', (roomId, username) => {
    log(`joinRoom запрошен: roomId=${roomId}, username=${username}`);
    
    if (!rooms[roomId]) {
      log(`Комната ${roomId} не найдена, создаём новую`);
      socket.roomId = roomId;
      socket.username = username || `Player-${socket.id.substring(0, 4)}`;
      
      rooms[roomId] = {
        players: [socket],
        state: {
          level: 1,
          turn: 'gm',
          history: [],
          levelGoals: {},
          gameMemory: [],
          levelMemory: ""
        }
      };
      
      socket.join(roomId);
      log(`Комната создана: ${roomId}`);
      
      if (!DEBUG_MODE) {
        log(`Установка таймера ожидания для комнаты: ${roomId}`);
        rooms[roomId].timeout = setTimeout(() => {
          if (rooms[roomId] && rooms[roomId].players.length < getRequiredPlayersCount()) {
            log(`Время ожидания истекло для комнаты: ${roomId}`);
            io.to(roomId).emit('error', { message: 'Недостаточно игроков для начала игры' });
            delete rooms[roomId];
          }
        }, 120000);
      }
    } else {
      const requiredPlayers = getRequiredPlayersCount();
      if (rooms[roomId].players.length >= requiredPlayers && !rooms[roomId].players.some(p => p.id === socket.id)) {
        log(`Комната заполнена: ${roomId}`);
        return socket.emit('error', { message: 'Комната заполнена' });
      }
      
      if (connectedUsers.has(username)) {
        const oldSocketId = connectedUsers.get(username);
        if (oldSocketId !== socket.id) {
          const oldSocket = io.sockets.sockets.get(oldSocketId);
          if (oldSocket) {
            log(`Отключаем старое соединение для ${username}: ${oldSocketId}`);
            oldSocket.disconnect();
          }
        }
      }
      
      connectedUsers.set(username, socket.id);
      socket.username = username;
      socket.roomId = roomId;
      log(`Пользователь ${username} присоединился к комнате ${roomId}`);
      
      if (!rooms[roomId].players.some(p => p.id === socket.id)) {
        rooms[roomId].players.push(socket);
      }
      
      socket.join(roomId);
    }
    
    const playerNames = rooms[roomId].players.map(p => p.username).filter(Boolean);
    log(`Отправка обновленного списка игроков: ${playerNames.join(', ')}`);
    io.to(roomId).emit('playersUpdate', playerNames);
    
    if (rooms[roomId].players.length >= getRequiredPlayersCount()) {
      log(`Достаточно игроков (${rooms[roomId].players.length}/${getRequiredPlayersCount()}), запускаем игру`);
      startGame(roomId);
    } else {
      log(`Ожидаем игроков: ${rooms[roomId].players.length}/${getRequiredPlayersCount()}`);
    }
  });

  socket.on('action', async ({ roomId, type, text }) => {
    log(`action запрошен: roomId=${roomId}, type=${type}, text=${text}`);
    
    const room = rooms[roomId];
    if (!room) {
      log(`Комната не найдена для действия: ${roomId}`);
      return socket.emit('error', { message: 'Комната не найдена' });
    }
    
    const playerIndex = room.players.findIndex(s => s.id === socket.id);
    const isValidTurn = DEBUG_MODE || (room.state.turn === playerIndex + 1);
    
    log(`Проверка хода: playerIndex=${playerIndex}, room.state.turn=${room.state.turn}, isValidTurn=${isValidTurn}`);
    
    if (!isValidTurn) {
      log(`Сейчас не ход игрока ${socket.username}`);
      return socket.emit('error', { message: 'Сейчас не ваш ход' });
    }

    if (type === 'say') {
      log(`Обработка сообщения чата от ${socket.username}: ${text}`);
    }
    io.to(roomId).emit('sayMessage', { from: socket.username, text });
    
      log(`Обработка игрового действия от ${socket.username}: ${type} - ${text}`);
      room.state.history.push(`${socket.username} ${type}: ${text}`);
      
      try {
        const gmResponse = await getGmResponse(room);
        log(`Получен ответ GM: "${gmResponse.substring(0, 30)}..."`);
        
        const imageUrl = await generateImage(gmResponse);
        log(`Получен URL изображения: ${imageUrl}`);
        
        io.to(roomId).emit('gmUpdate', { text: gmResponse, image: imageUrl });
        room.state.history.push(`GM: ${gmResponse}`);

        log(`Переход хода после действия в комнате ${roomId}`);
        nextTurn(roomId);
      } catch (err) {
        log(`Ошибка при обработке действия: ${err}`);
        socket.emit('error', { message: 'Произошла ошибка при обработке действия' });
      }
  });

  socket.on('disconnect', () => {
    log(`Отключение: ${socket.id} (${socket.username || 'неизвестный'})`);
    
    for (const [username, id] of connectedUsers.entries()) {
      if (id === socket.id) {
        log(`Удаляем пользователя ${username} из списка подключенных`);
        connectedUsers.delete(username);
        break;
      }
    }
    
    if (socket.roomId && rooms[socket.roomId]) {
      const room = rooms[socket.roomId];
      const index = room.players.findIndex(p => p.id === socket.id);
      
      if (index !== -1) {
        const username = room.players[index].username;
        room.players.splice(index, 1);
        
        if (username) {
          log(`Отправка уведомления о выходе игрока ${username}`);
          io.to(socket.roomId).emit('playerLeft', username);
        }
        
        if (room.players.length > 0) {
          const playerNames = room.players.map(p => p.username).filter(Boolean);
          log(`Обновляем список игроков: ${playerNames.join(', ')}`);
          io.to(roomId).emit('playersUpdate', playerNames);
        } else {
          log(`Удаляем пустую комнату: ${socket.roomId}`);
          delete rooms[socket.roomId];
        }
      }
    }
    
    connectedSockets.delete(socket.id);
  });

  socket.on('error', (err) => {
    log(`Ошибка клиента: ${err}`);
  });
});

// Функция для определения необходимого количества игроков
function getRequiredPlayersCount() {
  return DEBUG_MODE ? 1 : 3;
}

// Запуск игры
async function startGame(roomId) {
  log(`Запуск игры в комнате ${roomId}`);
  const room = rooms[roomId];
  if (!room) {
    log(`Ошибка запуска игры - комната ${roomId} не существует`);
    return;
  }
  
  if (room.timeout) {
    clearTimeout(room.timeout);
    delete room.timeout;
    log(`Таймер ожидания очищен для комнаты ${roomId}`);
  }
  
  try {
    log(`Запрашиваем начальное описание ситуации`);
    const initialSituation = await getGmResponse(room, true);
    log(`Начальная ситуация: "${initialSituation.substring(0, 30)}..."`);
    
    log(`Генерируем изображение для начальной ситуации`);
    const imageUrl = await generateImage(initialSituation);
    log(`URL начального изображения: ${imageUrl}`);
    
    log(`Отправляем gameStart всем игрокам в комнате ${roomId}`);
    io.to(roomId).emit('gameStart', { text: initialSituation, image: imageUrl });
    
    room.state.history.push(`GM: ${initialSituation}`);
    room.state.turn = 1;
    log(`Установлен ход первого игрока (playerIndex=0, turn=1)`);
    
    log(`Отправляем событие playerTurn с номером 1`);
    io.to(roomId).emit('playerTurn', 1);
  } catch (error) {
    log(`Ошибка при запуске игры: ${error}`);
    io.to(roomId).emit('error', { message: 'Произошла ошибка при запуске игры' });
  }
}

// Получение ответа GM
async function getGmResponse(room, isInitial = false) {
  log(`Запрос ответа GM: isInitial=${isInitial}, level=${room.state.level}, history length=${room.state.history.length}`);
  
  if (process.env.FAST_DEBUG === 'true') {
    log(`Режим быстрой отладки - возвращаем заготовленный ответ`);
    return isInitial
      ? "Перед вами темный вход в древнее подземелье. Массивные каменные двери покрыты рунами и мхом. Холодный воздух веет из черного проема. Слышны странные звуки из глубины."
      : "Вы продвигаетесь глубже. Факелы на стенах горят синим пламенем, освещая мрачный коридор. Впереди виднеется развилка путей и слышно тихое рычание.";
  }
    
  const userMessage = isInitial
    ? 'Начни игру: опиши вход в подземелье.'
    : 'Опиши результат действий и новую ситуацию.';
  
  try {
    await updateGameMemory(room);
    
    const levelGoal = room.state.levelGoals[room.state.level] || "Пройти этот уровень";
    const gameMemory = room.state.gameMemory.slice(-3).map(m => m.summary).join('\n') || "Начало приключения";
    const recentHistory = room.state.history.join('\n') || "Событий пока нет";
    
    const prompt = systemPrompt
      .replace('{level}', room.state.level)
      .replace('{levelGoal}', levelGoal)
      .replace('{gameMemory}', gameMemory)
      .replace('{recentHistory}', recentHistory);

    log(`Отправка запроса к Mistral API`);
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`
      },
      body: JSON.stringify({
        model: "mistral-large-latest",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userMessage }
        ],
        max_tokens: 300
      })
    });
    
    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }
    
    const data = await response.json();
    const result = data.choices[0].message.content.slice(0, 250);
    log(`Получен ответ от Mistral API: "${result.substring(0, 30)}..."`);
    return result;
  } catch (error) {
    log(`Все попытки запроса к Mistral API завершились ошибкой: ${error}`);
    return "Мастер игры задумался... Продолжайте путешествие.";
  }
}

// Переход хода
function nextTurn(roomId) {
  log(`nextTurn вызван для комнаты ${roomId}`);
  const room = rooms[roomId];
  if (!room) {
    log(`Ошибка nextTurn - комната ${roomId} не существует`);
    return;
  }
  
  if (DEBUG_MODE) {
    room.state.turn = 'gm';
    log(`Режим отладки - установлен ход GM`);
    io.to(roomId).emit('gmTurn');
    
    log(`Установлен таймер для хода GM (2 секунды)`);
    setTimeout(async () => {
      try {
        log(`Получение ответа GM после действия игрока`);
        const gmResponse = await getGmResponse(room);
        log(`Ответ GM: "${gmResponse.substring(0, 30)}..."`);
        
        log(`Генерация изображения для ответа GM`);
        const imageUrl = await generateImage(gmResponse);
        log(`URL изображения: ${imageUrl}`);
        
        log(`Отправка gmUpdate клиентам`);
        io.to(roomId).emit('gmUpdate', { text: gmResponse, image: imageUrl });
        room.state.history.push(`GM: ${gmResponse}`);
        
        if (gmResponse.toLowerCase().includes('level complete')) {
          room.state.level++;
          room.state.history = [];
          room.state.levelMemory = "";
          const levelGoal = room.state.levelGoals[room.state.level] || "Новая цель будет определена";
          log(`Уровень завершен! Новый уровень: ${room.state.level}`);
          io.to(roomId).emit('levelComplete', { level: room.state.level, goal: levelGoal });
        }
        
        if (room.state.level > 5) {
          log(`Игра завершена! (уровень > 5)`);
          io.to(roomId).emit('gameEnd');
        } else {
          room.state.turn = 1;
          log(`Возвращаем ход первому игроку (turn=1)`);
          io.to(roomId).emit('playerTurn', 1);
        }
      } catch (err) {
        log(`Ошибка в таймере GM: ${err}`);
      }
    }, 2000);
    return;
  }
  
  let currentTurn = typeof room.state.turn === 'number' ? room.state.turn : 0;
  currentTurn++;
  
  if (currentTurn > room.players.length) {
    room.state.turn = 'gm';
    log(`Переход к ходу GM (после всех игроков)`);
    io.to(roomId).emit('gmTurn');
    
    log(`Установлен таймер для хода GM (2 секунды)`);
    setTimeout(async () => {
      try {
        const gmResponse = await getGmResponse(room);
        log(`Ответ GM: "${gmResponse.substring(0, 30)}..."`);
        
        const imageUrl = await generateImage(gmResponse);
        log(`URL изображения: ${imageUrl}`);
        
        io.to(roomId).emit('gmUpdate', { text: gmResponse, image: imageUrl });
        room.state.history.push(`GM: ${gmResponse}`);
        
        if (gmResponse.toLowerCase().includes('level complete')) {
          room.state.level++;
          room.state.history = [];
          room.state.levelMemory = "";
          const levelGoal = room.state.levelGoals[room.state.level] || "Новая цель будет определена";
          log(`Уровень завершен! Новый уровень: ${room.state.level}`);
          io.to(roomId).emit('levelComplete', { level: room.state.level, goal: levelGoal });
        }
        
        if (room.state.level > 5) {
          log(`Игра завершена! (уровень > 5)`);
          io.to(roomId).emit('gameEnd');
        } else {
          room.state.turn = 1;
          log(`Переход хода к первому игроку (turn=1)`);
          io.to(roomId).emit('playerTurn', 1);
        }
      } catch (err) {
        log(`Ошибка в таймере GM: ${err}`);
      }
    }, 2000);
  } else {
    room.state.turn = currentTurn;
    log(`Переход хода к игроку ${currentTurn}`);
    io.to(roomId).emit('playerTurn', currentTurn);
  }
}

async function fetchMistral(messages) {
  try {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`
      },
      body: JSON.stringify({
        model: "mistral-large-latest",
        messages: messages,
        max_tokens: 100
      })
    });

    const data = await response.json();
    return data.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    log(`Ошибка запроса к Mistral: ${err}`);
    return "";
  }
}

async function updateGameMemory(room) {
  if (process.env.FAST_DEBUG === 'true') {
    if (!room.state.levelGoals[room.state.level]) {
      room.state.levelGoals[room.state.level] = `Пройти уровень ${room.state.level}`;
    }
    return;
  }
  
  try {
    log(`Обновление памяти для уровня ${room.state.level}`);
    
    if (!room.state.levelGoals[room.state.level]) {
      const goalPrompt = `Игроки находятся на уровне ${room.state.level} темного фэнтези подземелья. Основная цель - пройти 5 уровней. Придумай конкретную цель для этого уровня (1 предложение).`;
      
      const response = await fetchMistral([{ role: "user", content: goalPrompt }]);
      const goal = response || `Исследовать уровень ${room.state.level}`;
      
      room.state.levelGoals[room.state.level] = goal;
      log(`Установлена цель уровня: ${goal}`);
    }
    
    if (room.state.history.length > 4) {
      const summaryPrompt = `Создай очень краткое резюме (1 предложение) этих событий:\n${room.state.history.slice(-4).join('\n')}`;
      
      const response = await fetchMistral([{ role: "user", content: summaryPrompt }]);
      const summary = response || "Игроки продвигаются вперед";
      
      room.state.gameMemory.push({
        level: room.state.level,
        summary: summary,
        timestamp: Date.now()
      });
      
      room.state.history = room.state.history.slice(-2);
      log(`Добавлено в память: ${summary}`);
    }
    
    if (room.state.gameMemory.length > 3) {
      const memoryPrompt = `Сожми эти воспоминания в одно краткое предложение:\n${room.state.gameMemory.map(m => m.summary).join('\n')}`;
      
      const response = await fetchMistral([{ role: "user", content: memoryPrompt }]);
      const compressed = response || "Ключевые события путешествия";
      
      room.state.gameMemory = [{
        level: room.state.level,
        summary: compressed,
        timestamp: Date.now()
      }];
      log(`Память сжата: ${compressed}`);
    }
  } catch (err) {
    log(`Ошибка обновления памяти: ${err.message}`);
  }
}

// Бот: Кнопка для Mini App
bot.start((ctx) => {
  const modeMsg = DEBUG_MODE ? ' [РЕЖИМ ОТЛАДКИ]' : '';
  log(`Запрос /start от пользователя ${ctx.from.username || ctx.from.id}`);
  ctx.reply(`Добро пожаловать в подземелье!${modeMsg}`, {
    reply_markup: {
      inline_keyboard: [[{ text: 'Старт', web_app: { url: `${process.env.DOMAIN}/app.html` } }]],
    },
  });
});

bot.catch((err, ctx) => {
  log(`Ошибка бота: ${err}`);
  ctx.reply('Произошла ошибка, попробуйте еще раз.');
});

bot.launch()
  .then(() => log('Бот запущен'))
  .catch(err => log(`Ошибка запуска бота: ${err}`));

server.listen(process.env.PORT, () => {
  log(`Сервер запущен на порту ${process.env.PORT}`);
  log(`Режим отладки: ${DEBUG_MODE ? 'ВКЛЮЧЕН (1 игрок)' : 'ОТКЛЮЧЕН (3 игрока)'}`);
  
  if (!process.env.DOMAIN) {
    log('ВНИМАНИЕ: Переменная DOMAIN не установлена в .env файле! Используйте полный URL включая протокол, например https://yourdomain.com');
  } else {
    log(`DOMAIN: ${process.env.DOMAIN}`);
  }
});