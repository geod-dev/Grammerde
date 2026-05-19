import { apiPost, apiGet, getToken, getUser, showToast, updateNav } from './auth.js';

updateNav();

if (!getToken()) {
  showToast('Connectez-vous pour jouer en VS', 'error');
  setTimeout(() => window.location.href = '/', 1500);
}

const user = getUser();
let ws = null;
let roomCode = null;
let corrections = 0;
let gameStarted = false;

// ── Views ─────────────────────────────────────────────────────────────────────

function showView(id) {
  ['view-setup', 'view-waiting', 'view-game'].forEach(v => {
    document.getElementById(v)?.classList.add('hidden');
  });
  document.getElementById(id)?.classList.remove('hidden');
}

showView('view-setup');

// ── Create Room ───────────────────────────────────────────────────────────────

document.getElementById('btn-create-room')?.addEventListener('click', async () => {
  try {
    const difficulty = document.getElementById('create-difficulty')?.value || 'moyen';
    const data = await apiPost('/vs/create', { difficulty });
    roomCode = data.room_code;
    document.getElementById('display-code').textContent = roomCode;
    showView('view-waiting');
    connectWS(roomCode);
  } catch (e) {
    showToast(e.message, 'error');
  }
});

// ── Join Room ─────────────────────────────────────────────────────────────────

document.getElementById('btn-join-room')?.addEventListener('click', async () => {
  const code = document.getElementById('join-code')?.value.trim().toUpperCase();
  if (!code) return showToast('Entrez un code', 'error');
  try {
    await apiPost('/vs/join', { room_code: code });
    roomCode = code;
    showView('view-waiting');
    connectWS(roomCode);
  } catch (e) {
    showToast(e.message, 'error');
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWS(code) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'join_room',
      room_code: code,
      user_id: user.id,
      username: user.username,
    }));
    document.getElementById('waiting-status').textContent = 'Connecté — en attente d\'un adversaire…';
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    if (gameStarted) return;
    showToast('Connexion perdue', 'error');
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'player_joined':
      document.getElementById('waiting-status').textContent =
        `${msg.player_count}/2 joueur(s) connecté(s)…`;
      break;

    case 'game_start':
      gameStarted = true;
      startGame(msg);
      break;

    case 'tick':
      updateTimer(msg.remaining);
      break;

    case 'score_update':
      updateScores(msg.scores);
      break;

    case 'opponent_disconnected':
      showToast('Adversaire déconnecté — victoire dans 10s…', 'success');
      break;

    case 'game_over':
      showGameOver(msg);
      break;

    case 'error':
      showToast(msg.message, 'error');
      break;
  }
}

// ── Game ──────────────────────────────────────────────────────────────────────

function startGame(msg) {
  showView('view-game');
  document.getElementById('my-username').textContent = user.username;
  renderText(msg.corrupted_text);
  corrections = 0;
  updateScores({});
}

function renderText(text) {
  const container = document.getElementById('vs-text');
  if (!container) return;
  const words = text.split(/(\s+)/);
  container.innerHTML = words.map(seg => {
    if (/\s+/.test(seg) || /^[.,;:!?«»"'()\[\]\-—–]+$/.test(seg)) return seg;
    const clean = seg.replace(/^[^a-zA-ZÀ-ÿ]+|[^a-zA-ZÀ-ÿ]+$/g, '');
    if (!clean) return seg;
    return `<span class="word-selectable" style="cursor:pointer" data-word="${clean}">${seg}</span>`;
  }).join('');

  container.querySelectorAll('.word-selectable').forEach(el => {
    el.addEventListener('click', () => openVsPopup(el));
  });
}

let vsCurrentEl = null;

function openVsPopup(el) {
  vsCurrentEl = el;
  document.getElementById('vs-popup-word').textContent = el.dataset.word;
  document.getElementById('vs-popup-input').value = '';
  document.getElementById('vs-popup').classList.remove('hidden');
  document.getElementById('vs-popup-input').focus();
}

document.getElementById('btn-vs-validate')?.addEventListener('click', submitVsCorrection);
document.getElementById('vs-popup-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitVsCorrection();
  if (e.key === 'Escape') document.getElementById('vs-popup').classList.add('hidden');
});

document.getElementById('btn-vs-skip')?.addEventListener('click', () => {
  document.getElementById('vs-popup').classList.add('hidden');
});

function submitVsCorrection() {
  const correction = document.getElementById('vs-popup-input').value.trim();
  if (!correction) return;

  vsCurrentEl.classList.add('corrected');
  corrections++;

  document.getElementById('vs-popup').classList.add('hidden');

  ws?.send(JSON.stringify({
    type: 'correction',
    room_code: roomCode,
    user_id: user.id,
    corrections_count: corrections,
  }));

  document.getElementById('my-score').textContent = corrections;
}

function updateTimer(remaining) {
  const el = document.getElementById('vs-timer');
  if (!el) return;
  el.textContent = remaining;
  el.classList.toggle('urgent', remaining <= 30);
}

function updateScores(scores) {
  const myScore = scores[user.id] ?? corrections;
  document.getElementById('my-score').textContent = myScore;

  const opponentId = Object.keys(scores).find(id => id != user.id);
  if (opponentId) {
    document.getElementById('opponent-score').textContent = scores[opponentId] ?? 0;
  }
}

function showGameOver(msg) {
  const screen = document.getElementById('finish-screen');
  screen.classList.remove('hidden');

  const isWinner = String(msg.winner_id) === String(user.id);
  document.getElementById('finish-title').textContent = isWinner ? 'Victoire !' : 'Défaite';
  document.getElementById('finish-title').style.color = isWinner ? 'var(--green)' : 'var(--red)';

  const myScore = msg.scores[user.id] ?? corrections;
  const opId = Object.keys(msg.scores).find(id => id != user.id);
  const opScore = opId ? msg.scores[opId] : 0;
  document.getElementById('finish-scores').textContent = `${myScore} vs ${opScore} corrections`;
}

document.getElementById('btn-play-again')?.addEventListener('click', () => window.location.href = '/');
