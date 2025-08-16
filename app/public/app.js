// Используем singleton для сокета
let socket = null;
let roomId = null;
let players = []; // Список игроков в комнате
let myTurnIndex = -1; // Индекс текущего игрока в массиве players
let username; // Глобальная переменная для имени пользователя
let eventImage, gmText, messages; // Элементы DOM

// Инициализация сокета с защитой от повторного подключения
function initSocket() {
  if (socket && socket.connected) return socket;
  
  if (socket) socket.disconnect();
  
  socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
  });
  
  // Основные обработчики событий
  socket.on('connect', () => {
    console.log('Connected to server');
    
    // Проверяем параметры URL для присоединения к комнате
    const urlParams = new URLSearchParams(window.location.search);
    const roomIdFromUrl = urlParams.get('room') || '1'; // Используем '1' как fallback
    joinRoom(roomIdFromUrl);
  });
  
  socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err);
    alert('Connection error. Please refresh.');
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
    const errorMessage = typeof err === 'string' ? err : (err.message || 'Unknown error');
    alert(`Error: ${errorMessage}`);
  });

  socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
    if (reason === 'io server disconnect') {
      alert('Server disconnected. Please refresh.');
    }
  });

  // Игровые события
  socket.on('roomCreated', (id) => {
    console.log('Room created:', id);
    roomId = id; // Обновляем roomId
    window.history.replaceState(null, null, `?room=${id}`);
  });

  socket.on('playersUpdate', (updatedPlayers) => {
    console.log('Players updated:', updatedPlayers);
    players = updatedPlayers;
    updatePlayersUI(updatedPlayers);
    
    console.log('Players name:', username);
    myTurnIndex = players.indexOf(username); // Обновляем индекс
    console.log('Updated myTurnIndex:', myTurnIndex); // Отладка
  });

  socket.on('gameStart', ({ text, image }) => {
    updateScene(text, image);
    disableButtons(); // Отключаем кнопки до своего хода
  });

  socket.on('gmUpdate', ({ text, image }) => {
    updateScene(text, image);
  });

  socket.on('sayMessage', ({ from, text }) => {
    messages.innerHTML += `<p style="color: #ff0;">${from}: ${text}</p>`;
    messages.scrollTop = messages.scrollHeight;
  });

  socket.on('playerTurn', (turnIndex) => {
    const playerIndex = turnIndex - 1; // Преобразуем в индекс массива
    console.log('playerTurn received: turnIndex=', turnIndex, 'myTurnIndex=', myTurnIndex, 'playerIndex=', playerIndex);
    
    if (playerIndex === myTurnIndex) {
      enableButtons();
    } else {
      disableButtons();
    }
  });

  socket.on('gmTurn', () => {
    console.log('GM Turn - ожидание хода мастера');
    disableButtons();
  });

  socket.on('playerLeft', (username) => {
    console.log(`Игрок вышел: ${username}`);
    alert(`Игрок ${username} покинул игру`);
  });

  socket.on('levelComplete', ({ level, goal }) => {
    alert(`Уровень пройден! Вы переходите на уровень ${level}: ${goal}`);
  });

  socket.on('gameEnd', () => {
    alert('Игра завершена!');
    disableButtons();
  });

  return socket;
}

// Создание комнаты
function createRoom() {
  if (!socket || !socket.connected) return;
  socket.emit('createRoom', username);
}

// Присоединение к комнате
function joinRoom(roomIdToJoin) {
  if (!socket || !socket.connected) return;
  
  roomId = roomIdToJoin; // Обновляем roomId сразу
  socket.emit('joinRoom', roomIdToJoin, username);
}

// Обновление UI списка игроков
function updatePlayersUI(playersList) {
  const playersContainer = document.getElementById('players-container');
  if (!playersContainer) return;
  
  const maxPlayers = 3;
  playersContainer.innerHTML = `
    <h3>Игроки (${playersList.length}/${maxPlayers}):</h3>
    <ul>${playersList.map(p => `<li>${p === username ? `<b>${p} (вы)</b>` : p}</li>`).join('')}</ul>
  `;
}

// Обновление игровой сцены
function updateScene(text, image) {
  if (eventImage) eventImage.src = image;
  if (gmText) gmText.textContent = text;
  
  const description = document.getElementById('description');
  if (description) description.scrollTop = 0;
}

// Обработка действий игрока
function handleAction(type) {
  if (!socket || !socket.connected || !roomId) {
    console.log('Cannot handle action: socket=', socket?.connected, 'roomId=', roomId);
    return;
  }
  
  let text = '';
  if (type === 'say') {
    text = prompt('Что вы хотите сказать?');
  } else {
    text = prompt(`Опишите действие "${type}":`);
  }
  
  if (text) {
    console.log('Sending action:', { roomId, type, text });
    socket.emit('action', { roomId, type, text });
    disableButtons();
  }
}

// Включение/выключение кнопок
function enableButtons() {
  const buttons = document.querySelectorAll('#controls button');
  buttons.forEach(btn => {
    btn.disabled = false;
    console.log('Button enabled:', btn.textContent);
  });
}

function disableButtons() {
  const buttons = document.querySelectorAll('#controls button');
  buttons.forEach(btn => {
    btn.disabled = true;
    console.log('Button disabled:', btn.textContent);
  });
}

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', () => {
  const tg = window.Telegram.WebApp;
  if (tg) {
    tg.expand();
    tg.enableClosingConfirmation();
  }
  
  // Инициализируем элементы UI
  eventImage = document.getElementById('eventImage');
  gmText = document.getElementById('gmText');
  messages = document.getElementById('messages');
  
  // Создаем контейнер для списка игроков
  const playersContainer = document.createElement('div');
  playersContainer.id = 'players-container';
  document.body.insertBefore(playersContainer, document.getElementById('scene'));

  username = tg.initDataUnsafe.user?.username || 'Player' + Math.floor(Math.random() * 1000);
  console.log('Initialized username:', username);
  
  // Инициализируем сокет
  initSocket();
});