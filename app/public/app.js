const socket = io();
const tg = window.Telegram.WebApp;
tg.expand();

let roomId = null;
let username = tg.initDataUnsafe.user.username || 'Player';

// UI элементы
const eventImage = document.getElementById('eventImage');
const gmText = document.getElementById('gmText');
const messages = document.getElementById('messages');

// Создать/присоединиться (покажи UI для ввода roomId или create)
document.addEventListener('DOMContentLoaded', () => {
  // Пример: кнопки "Создать" и "Присоединиться" (добавь в HTML)
  socket.emit('createRoom'); //-> получает roomId
  socket.emit('joinRoom', roomId, username);
});

socket.on('roomCreated', (id) => { roomId = id; alert(`Room ID: ${id}`); });
socket.on('playerJoined', (players) => { /* Обнови список игроков */ });
socket.on('gameStart', ({ text, image }) => updateScene(text, image));
socket.on('gmUpdate', ({ text, image }) => updateScene(text, image));
socket.on('sayMessage', ({ from, text }) => {
  messages.innerHTML += `<p style="color: #ff0;">${from}: ${text}</p>`;
  messages.scrollTop = messages.scrollHeight;
});
socket.on('playerTurn', (turn) => { if (turn === myTurnIndex) enableButtons(); }); // Определи myTurnIndex по players

function updateScene(text, image) {
  eventImage.src = image;
  gmText.textContent = text;
  document.getElementById('description').scrollTop = 0; // Прокрутка в начало
}

function handleAction(type) {
  const text = prompt(`Введите для ${type}:`);
  if (text) socket.emit('action', { roomId, type, text });
}

function enableButtons() { /* Включи кнопки только на свой ход */ }