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
  cors: { origin: '*', methods: ["GET", "POST"] },
  // Добавляем настройки для отладки
  pingTimeout: 60000,
  pingInterval: 10000
});
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
const hf = new HfInference(process.env.HF_API_KEY);

// Режим отладки - для запуска игры с одним игроком
const DEBUG_MODE = process.env.DEBUG_MODE === 'true' || true; // Принудительно включаем режим отладки
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
    // Создаем простое изображение
    const defaultImagePath = path.join(__dirname, 'node_modules/socket.io/client-dist/socket.io.min.js');
    fs.copyFile(defaultImagePath, fallbackImagePath)
      .catch(err => log(`Не удалось создать fallback изображение: ${err}`));
  });

// Хранение комнат
const rooms = {};

// Системный промпт для GM
const systemPrompt = `Ты - мастер игры в тёмном фэнтези подземелье. Игра ${DEBUG_MODE ? 'в режиме отладки на 1 игрока' : 'на 3 игроков'}, цель - пройти 5 уровней, каждый сложнее предыдущего. В конце 5-го - босс. Описывай ситуации кратко, красиво, до 150 символов. Не используй Markdown. Реагируй на действия игроков ("use", "cancel", "say"). Сложность растёт: level {level}. Текущая ситуация: {history}.`;

// Генерация изображения
async function generateImage(description) {
    try {
        log(`Генерируем изображение для: "${description.substring(0, 30)}..."`);
        
        // В режиме быстрой отладки можно использовать заглушку
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

  // Создание комнаты
  socket.on('createRoom', (username) => {
    log(`createRoom запрошен пользователем: ${socket.id}, username=${username}`);

    if (socket.roomId) {
        log(`Пользователь уже в комнате: ${socket.roomId}`);
        return socket.emit('error', { message: 'Вы уже находитесь в комнате' });
    }
    
    const roomId = Math.random().toString(36).substring(7);
    socket.roomId = roomId;
    socket.username = username || `Player-${socket.id.substring(0, 4)}`; // Используем переданный или генерируем
    
    rooms[roomId] = { 
        players: [socket], 
        state: { level: 1, turn: 'gm', history: [] } 
    };
    
    socket.join(roomId);
    log(`Комната создана: ${roomId}`);
    socket.emit('roomCreated', roomId);
    
    // Таймер ожидания игроков (не используется в режиме отладки)
    if (!DEBUG_MODE) {
        log(`Установка таймера ожидания для комнаты: ${roomId}`);
        rooms[roomId].timeout = setTimeout(() => {
            if (rooms[roomId] && rooms[roomId].players.length < getRequiredPlayersCount()) {
                log(`Время ожидания истекло для комнаты: ${roomId}`);
                io.to(roomId).emit('error', { message: 'Недостаточно игроков для начала игры' });
                delete rooms[roomId];
            }
        }, 120000); // 2 минуты на ожидание
    } else {
        // В режиме отладки сразу запускаем игру
        log(`Режим отладки - используем username: ${socket.username}`);
        log(`Режим отладки - автоматически присоединяемся к комнате: ${roomId}`);
        // socket.username = `Player-${socket.id.substring(0, 4)}`;
        const playerNames = [socket.username];
        io.to(roomId).emit('playersUpdate', playerNames);
        log(`Запускаем игру в режиме отладки для комнаты: ${roomId}`);
        startGame(roomId);
    }
  });

  // Присоединение к комнате
  socket.on('joinRoom', (roomId, username) => {
    log(`joinRoom запрошен: roomId=${roomId}, username=${username}`);
    
    if (!rooms[roomId]) {
        log(`Комната не найдена: ${roomId}`);
        return socket.emit('error', { message: 'Комната не найдена' });
    }

    // Проверяем, не достигнут ли лимит игроков
    const requiredPlayers = getRequiredPlayersCount();
    if (rooms[roomId].players.length >= requiredPlayers && !rooms[roomId].players.some(p => p.id === socket.id)) {
        log(`Комната заполнена: ${roomId}`);
        return socket.emit('error', { message: 'Комната заполнена' });
    }

    // Проверяем, входил ли пользователь ранее с другого соединения
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
    
    // Добавляем игрока, если его ещё нет в комнате
    if (!rooms[roomId].players.some(p => p.id === socket.id)) {
        rooms[roomId].players.push(socket);
    }
    
    socket.join(roomId);

    // Обновляем список игроков для всех
    const playerNames = rooms[roomId].players.map(p => p.username).filter(Boolean);
    log(`Отправка обновленного списка игроков: ${playerNames.join(', ')}`);
    io.to(roomId).emit('playersUpdate', playerNames);

    // Запускаем игру при наборе нужного количества игроков
    if (rooms[roomId].players.length >= getRequiredPlayersCount()) {
        log(`Достаточно игроков (${rooms[roomId].players.length}/${getRequiredPlayersCount()}), запускаем игру`);
        startGame(roomId);
    } else {
        log(`Ожидаем игроков: ${rooms[roomId].players.length}/${getRequiredPlayersCount()}`);
    }
  });

  // Обработка игровых действий
  socket.on('action', async ({ roomId, type, text }) => {
    log(`action запрошен: roomId=${roomId}, type=${type}, text=${text}`);
    
    const room = rooms[roomId];
    if (!room) {
        log(`Комната не найдена для действия: ${roomId}`);
        return socket.emit('error', { message: 'Комната не найдена' });
    }
    
    // В режиме отладки всегда разрешаем действие одному игроку
    const playerIndex = room.players.findIndex(s => s.id === socket.id);
    const isValidTurn = DEBUG_MODE || (room.state.turn === playerIndex + 1);
    
    log(`Проверка хода: playerIndex=${playerIndex}, room.state.turn=${room.state.turn}, isValidTurn=${isValidTurn}`);
        
    if (!isValidTurn) {
        log(`Сейчас не ход игрока ${socket.username}`);
        return socket.emit('error', { message: 'Сейчас не ваш ход' });
    }

    if (type === 'say') {
      // Обработка сообщений чата
      log(`Обработка сообщения чата от ${socket.username}: ${text}`);
      io.to(roomId).emit('sayMessage', { from: socket.username, text });
    } else {
      // Обработка игровых действий
      log(`Обработка игрового действия от ${socket.username}: ${type} - ${text}`);
      room.state.history.push(`${socket.username} ${type}: ${text}`);
      
      try {
        const gmResponse = await getGmResponse(room);
        log(`Получен ответ GM: "${gmResponse.substring(0, 30)}..."`);
        
        const imageUrl = await generateImage(gmResponse);
        log(`Получен URL изображения: ${imageUrl}`);
        
        io.to(roomId).emit('gmUpdate', { text: gmResponse, image: imageUrl });
        room.state.history.push(`GM: ${gmResponse}`);

        // Переход хода
        log(`Переход хода после действия в комнате ${roomId}`);
        nextTurn(roomId);
      } catch (err) {
        log(`Ошибка при обработке действия: ${err}`);
        socket.emit('error', { message: 'Произошла ошибка при обработке действия' });
      }
    }
  });

  // Отключение игрока
  socket.on('disconnect', () => {
    log(`Отключение: ${socket.id} (${socket.username || 'неизвестный'})`);
    
    // Удаляем из карты пользователей
    for (const [username, id] of connectedUsers.entries()) {
        if (id === socket.id) {
            log(`Удаляем пользователя ${username} из списка подключенных`);
            connectedUsers.delete(username);
            break;
        }
    }
    
    // Обрабатываем выход из комнаты
    if (socket.roomId && rooms[socket.roomId]) {
        const room = rooms[socket.roomId];
        const index = room.players.findIndex(p => p.id === socket.id);
        
        if (index !== -1) {
            const username = room.players[index].username;
            room.players.splice(index, 1);
            
            // Уведомляем оставшихся игроков
            if (username) {
                log(`Отправка уведомления о выходе игрока ${username}`);
                io.to(socket.roomId).emit('playerLeft', username);
            }
            
            // Обновляем список игроков
            if (room.players.length > 0) {
                const playerNames = room.players.map(p => p.username).filter(Boolean);
                log(`Обновляем список игроков: ${playerNames.join(', ')}`);
                io.to(socket.roomId).emit('playersUpdate', playerNames);
            } else {
                // Удаляем пустую комнату
                log(`Удаляем пустую комнату: ${socket.roomId}`);
                delete rooms[socket.roomId];
            }
        }
    }
    
    connectedSockets.delete(socket.id);
  });
  
  // Обработчик для ожидаемых событий на стороне клиента
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
  
  // Очищаем таймер ожидания, если есть
  if (room.timeout) {
    clearTimeout(room.timeout);
    delete room.timeout;
    log(`Таймер ожидания очищен для комнаты ${roomId}`);
  }
  
  try {
    // Генерируем начальную ситуацию
    log(`Запрашиваем начальное описание ситуации`);
    const initialSituation = await getGmResponse(room, true);
    log(`Начальная ситуация: "${initialSituation.substring(0, 30)}..."`);
    
    log(`Генерируем изображение для начальной ситуации`);
    const imageUrl = await generateImage(initialSituation);
    log(`URL начального изображения: ${imageUrl}`);
    
    // Отправляем начальные данные всем игрокам
    log(`Отправляем gameStart всем игрокам в комнате ${roomId}`);
    io.to(roomId).emit('gameStart', { text: initialSituation, image: imageUrl });
    
    // Обновляем состояние
    room.state.history.push(`GM: ${initialSituation}`);
    room.state.turn = 1; // Первый игрок
    log(`Установлен ход первого игрока (playerIndex=0, turn=1)`);
    
    // Уведомляем о первом ходе
    log(`Отправляем событие playerTurn с номером 1`);
    io.to(roomId).emit('playerTurn', 1);
  } catch (error) {
    log(`Ошибка при запуске игры: ${error}`);
    io.to(roomId).emit('error', { message: 'Произошла ошибка при запуске игры' });
  }
}

// Получение ответа GM
// async function getGmResponse(room, isInitial = false) {
//   log(`Запрос ответа GM: isInitial=${isInitial}, level=${room.state.level}, history length=${room.state.history.length}`);
  
//   const prompt = systemPrompt
//     .replace('{level}', room.state.level)
//     .replace('{history}', room.state.history.join('\n'));
    
//   const userMessage = isInitial ? 
//     'Начни игру: опиши вход в подземелье.' : 
//     'Опиши результат действий и новую ситуацию.';
  
//   log(`Подготовлен промпт для GM, длина: ${prompt.length}`);
  
//   try {
//     // Опция для быстрой отладки без запросов к API
//     if (process.env.FAST_DEBUG === 'true') {
//       log(`Режим быстрой отладки - возвращаем заготовленный ответ`);
//       return isInitial 
//         ? "Перед вами темный вход в древнее подземелье. Массивные каменные двери покрыты рунами и мхом. Холодный воздух веет из черного проема. Слышны странные звуки из глубины." 
//         : "Вы продвигаетесь глубже. Факелы на стенах горят синим пламенем, освещая мрачный коридор. Впереди виднеется развилка путей и слышно тихое рычание.";
//     }
    
//     log(`Отправка запроса к Mistral API`);
//     const response = await mistral.chat({
//       model: 'mistral-large-latest',
//       messages: [
//         { role: 'system', content: prompt },
//         { role: 'user', content: userMessage }
//       ],
//     });
    
//     const result = response.choices[0].message.content.slice(0, 250);
//     log(`Получен ответ от GM API: "${result.substring(0, 30)}..."`);
//     return result;
//   } catch (error) {
//     log(`Ошибка получения ответа GM: ${error}`);
//     return "Мастер игры задумался... Продолжайте путешествие.";
//   }
// }

async function getGmResponse(room, isInitial = false) {
  log(`Запрос ответа GM: isInitial=${isInitial}, level=${room.state.level}, history length=${room.state.history.length}`);
  
  // Быстрый режим отладки
  if (process.env.FAST_DEBUG === 'true') {
    log(`Режим быстрой отладки - возвращаем заготовленный ответ`);
    return isInitial 
      ? "Перед вами темный вход в древнее подземелье. Массивные каменные двери покрыты рунами и мхом. Холодный воздух веет из черного проема. Слышны странные звуки из глубины." 
      : "Вы продвигаетесь глубже. Факелы на стенах горят синим пламенем, освещая мрачный коридор. Впереди виднеется развилка путей и слышно тихое рычание.";
  }
  
  const prompt = systemPrompt
    .replace('{level}', room.state.level)
    .replace('{history}', room.state.history.join('\n'));
    
  const userMessage = isInitial ? 
    'Начни игру: опиши вход в подземелье.' : 
    'Опиши результат действий и новую ситуацию.';
  
  try {
    log(`Отправка запроса к Mistral API`);        
    // Вариант 3: Используем полностью альтернативный синтаксис
    log(`Пробуем метод API v3...`);
    
    // Заменить на правильный синтаксис, если нужно
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
    log(`Получен ответ от Mistral API v3: "${result.substring(0, 30)}..."`);
    return result;
  } 
  catch (error) {
    log(`Все попытки запроса к Mistral API завершились ошибкой: ${error}`);
    
    // Возвращаем заглушку в случае ошибки
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
  
  // В режиме отладки с 1 игроком всегда возвращаем ход первому игроку
  if (DEBUG_MODE) {
    // Короткий ход GM для реакции
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
        
        // Проверка на завершение уровня
        if (gmResponse.toLowerCase().includes('level complete')) {
          room.state.level++;
          log(`Уровень завершен! Новый уровень: ${room.state.level}`);
          io.to(roomId).emit('levelComplete', room.state.level);
        }
        
        // Проверка на конец игры
        if (room.state.level > 5) {
          log(`Игра завершена! (уровень > 5)`);
          io.to(roomId).emit('gameEnd');
        } else {
          // Возвращаем ход игроку
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
  
  // Стандартный режим для 3 игроков
  let currentTurn = typeof room.state.turn === 'number' ? room.state.turn : 0;
  currentTurn++;
  
  // После последнего игрока - ход GM
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
        
        // Проверка на завершение уровня
        if (gmResponse.toLowerCase().includes('level complete')) {
          room.state.level++;
          log(`Уровень завершен! Новый уровень: ${room.state.level}`);
          io.to(roomId).emit('levelComplete', room.state.level);
        }
        
        // Проверка на конец игры
        if (room.state.level > 5) {
          log(`Игра завершена! (уровень > 5)`);
          io.to(roomId).emit('gameEnd');
        } else {
          // Следующий круг - первый игрок
          room.state.turn = 1;
          log(`Переход хода к первому игроку (turn=1)`);
          io.to(roomId).emit('playerTurn', 1);
        }
      } catch (err) {
        log(`Ошибка в таймере GM: ${err}`);
      }
    }, 2000);
  } else {
    // Ход следующего игрока
    room.state.turn = currentTurn;
    log(`Переход хода к игроку ${currentTurn}`);
    io.to(roomId).emit('playerTurn', currentTurn);
  }
}

// Бот: Кнопка для Mini App
bot.start((ctx) => {
  // Добавляем индикатор режима отладки в сообщение
  const modeMsg = DEBUG_MODE ? ' [РЕЖИМ ОТЛАДКИ]' : '';
  
  log(`Запрос /start от пользователя ${ctx.from.username || ctx.from.id}`);
  ctx.reply(`Добро пожаловать в подземелье!${modeMsg}`, {
    reply_markup: {
      inline_keyboard: [[{ text: 'Старт', web_app: { url: `${process.env.DOMAIN}/app.html` } }]],
    },
  });
});

// Обработка ошибок бота
bot.catch((err, ctx) => {
  log(`Ошибка бота: ${err}`);
  ctx.reply('Произошла ошибка, попробуйте еще раз.');
});

// Запуск бота
bot.launch()
  .then(() => log('Бот запущен'))
  .catch(err => log(`Ошибка запуска бота: ${err}`));

// Запуск сервера
server.listen(process.env.PORT, () => {
  log(`Сервер запущен на порту ${process.env.PORT}`);
  log(`Режим отладки: ${DEBUG_MODE ? 'ВКЛЮЧЕН (1 игрок)' : 'ОТКЛЮЧЕН (3 игрока)'}`);
  
  // Проверяем наличие домена в настройках
  if (!process.env.DOMAIN) {
    log('ВНИМАНИЕ: Переменная DOMAIN не установлена в .env файле! Используйте полный URL включая протокол, например https://yourdomain.com');
  } else {
    log(`DOMAIN: ${process.env.DOMAIN}`);
  }
});
