// Используем singleton для сокета
let socket = null;
let roomId = null;
let players = []; // Список игроков в комнате
let myTurnIndex = -1; // Индекс текущего игрока в массиве players
let username; // Добавить эту переменную
let eventImage, gmText, messages; // Объявить явно элементы DOM

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
    const roomIdFromUrl = urlParams.get('room');
    
    if (roomIdFromUrl) {
      joinRoom(roomIdFromUrl);
    } else {
      createRoom();
    }
  });
  
  socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err);
    alert('Connection error. Please refresh.');
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
    // Обработка как объекта, так и строкового формата ошибки
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
    roomId = id;
    // Обновляем URL для возможности поделиться
    window.history.replaceState(null, null, `?room=${id}`);
  });

  socket.on('playersUpdate', (updatedPlayers) => {
    console.log('Players updated:', updatedPlayers);
    players = updatedPlayers;
    updatePlayersUI(updatedPlayers);
    
     console.log('Players name:', username);
    
    // Определяем наш индекс
    myTurnIndex = players.indexOf(username);
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
    // turnIndex: 1,2,3 - номер игрока (не индекс массива!)
    const playerIndex = turnIndex - 1; // Преобразуем в индекс массива
    
    if (playerIndex === myTurnIndex) {
      enableButtons();
    } else {
      disableButtons();
    }
  });

  // Добавляем новые обработчики событий
  socket.on('gmTurn', () => {
    console.log('GM Turn - ожидание хода мастера');
    disableButtons(); // Отключаем кнопки на время хода GM
  });

  socket.on('playerLeft', (username) => {
    console.log(`Игрок вышел: ${username}`);
    alert(`Игрок ${username} покинул игру`);
  });

  socket.on('levelComplete', (level) => {
    alert(`Уровень пройден! Вы переходите на уровень ${level}`);
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
  
  // Получаем username из Telegram
  const tg = window.Telegram.WebApp;
  username = tg.initDataUnsafe.user?.username || 'Player' + Math.floor(Math.random() * 1000);
  
  socket.emit('joinRoom', roomIdToJoin, username);
}

// Обновление UI списка игроков
function updatePlayersUI(playersList) {
  const playersContainer = document.getElementById('players-container');
  if (!playersContainer) return;
  
  const maxPlayers = 3; // Максимальное количество игроков
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
  if (!socket || !socket.connected || !roomId) return;
  
  let text = '';
  if (type === 'say') {
    text = prompt('Что вы хотите сказать?');
  } else {
    text = prompt(`Опишите действие "${type}":`);
  }
  
  if (text) {
    socket.emit('action', { roomId, type, text });
    disableButtons(); // Отключаем кнопки после действия
  }
}

// Включение/выключение кнопок
function enableButtons() {
  const buttons = document.querySelectorAll('#controls button');
  buttons.forEach(btn => btn.disabled = false);
}

function disableButtons() {
  const buttons = document.querySelectorAll('#controls button');
  buttons.forEach(btn => btn.disabled = true);
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
  
  // Инициализируем сокет
  initSocket();
});
