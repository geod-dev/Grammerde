import { apiPost, getToken, getUser, showToast, updateNav } from './auth.js';

updateNav();

if (!getToken()) {
  showToast('Connectez-vous pour jouer en VS', 'error');
  setTimeout(() => window.location.href = '/', 1500);
}

const user = getUser();
let ws = null;
let roomCode = null;
let vsCorrections = []; // { idx, displayed_invalid, correction }
let vsErrors = [];
let vsCorruptedText = '';
let gameStarted = false;

// ── Views ─────────────────────────────────────────────────────────────────────

function showView(id) {
  ['view-setup', 'view-waiting', 'view-game', 'finish-screen'].forEach(v => {
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
    ws.send(JSON.stringify({ type: 'join_room', room_code: code, user_id: user.id, username: user.username }));
    document.getElementById('waiting-status').textContent = "Connecté — en attente d'un adversaire…";
  };

  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = () => { if (!gameStarted) showToast('Connexion perdue', 'error'); };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'player_joined':
      if (msg.player_count === 2) {
        document.getElementById('waiting-code-card')?.classList.add('hidden');
        document.getElementById('waiting-status').textContent = 'Génération du texte en cours…';
      } else {
        document.getElementById('waiting-status').textContent = `${msg.player_count}/2 joueur(s) connecté(s)…`;
      }
      break;

    case 'game_start':
      gameStarted = true;
      vsErrors = msg.errors_map || [];
      vsCorruptedText = msg.corrupted_text;
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
  vsCorrections = [];
  renderText(msg.corrupted_text);
  updateScores({});
}

function renderText(text) {
  const container = document.getElementById('vs-text');
  if (!container) return;
  let idx = 0;
  container.innerHTML = text.split(/(\s+)/).map(seg => {
    if (/^\s+$/.test(seg) || /^[.,;:!?«»"'()\[\]\-—–]+$/.test(seg)) return seg;
    const clean = seg.replace(/^[^a-zA-ZÀ-ÿ]+|[^a-zA-ZÀ-ÿ]+$/g, '');
    if (!clean) return seg;
    const i = idx++;
    return `<span class="word-selectable" style="cursor:pointer" data-idx="${i}" data-word="${clean}">${seg}</span>`;
  }).join('');

  container.querySelectorAll('.word-selectable').forEach(el => {
    el.addEventListener('click', () => openVsPopup(el));
  });
}

let vsCurrentEl = null;

function openVsPopup(el) {
  const existing = vsCorrections.find(c => c.idx === el.dataset.idx);
  vsCurrentEl = el;
  document.getElementById('vs-popup-word').textContent = el.dataset.word;
  document.getElementById('vs-popup-input').value = existing?.correction || '';
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
  if (!correction || !vsCurrentEl) return;

  const idx = vsCurrentEl.dataset.idx;
  const displayedInvalid = vsCurrentEl.dataset.word;

  const existingIdx = vsCorrections.findIndex(c => c.idx === idx);
  if (existingIdx >= 0) vsCorrections[existingIdx].correction = correction;
  else vsCorrections.push({ idx, displayed_invalid: displayedInvalid, correction });

  vsCurrentEl.textContent = correction;
  vsCurrentEl.classList.add('corrected');
  document.getElementById('vs-popup').classList.add('hidden');

  ws?.send(JSON.stringify({
    type: 'correction',
    room_code: roomCode,
    user_id: user.id,
    corrections_count: vsCorrections.length,
  }));

  document.getElementById('my-score').textContent = vsCorrections.length;
}

function updateTimer(remaining) {
  const el = document.getElementById('vs-timer');
  if (!el) return;
  el.textContent = remaining;
  el.classList.toggle('urgent', remaining <= 30);
}

function updateScores(scores) {
  document.getElementById('my-score').textContent = scores[user.id] ?? vsCorrections.length;
  const opId = Object.keys(scores).find(id => id != user.id);
  if (opId) document.getElementById('opponent-score').textContent = scores[opId] ?? 0;
}

// ── Results ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function normalizeStr(s) { return s.trim().toLowerCase().replace(/\s+/g, ' '); }

function showGameOver(msg) {
  showView('finish-screen');

  const isWinner = String(msg.winner_id) === String(user.id);
  const titleEl = document.getElementById('finish-title');
  titleEl.textContent = isWinner ? 'Victoire !' : 'Défaite';
  titleEl.style.color = isWinner ? 'var(--green)' : 'var(--red)';

  const opId = Object.keys(msg.scores).find(id => id != user.id);
  const opCount = opId ? (msg.scores[opId] ?? 0) : null;

  renderVsResults(opCount);
}

function renderVsResults(opponentCount) {
  const detailMap = new Map(vsErrors.map(e => [e.span_idx, e]));
  const userAnswerMap = new Map(vsCorrections.map(c => [parseInt(c.idx), c.correction]));

  // Compute stats
  let valid = 0, wrong = 0, missed = 0;
  vsErrors.forEach(err => {
    const answer = userAnswerMap.get(err.span_idx);
    if (!answer) { missed++; return; }
    if (normalizeStr(answer) === normalizeStr(err.original_valid)) valid++;
    else wrong++;
  });
  const applied = vsCorrections.length;
  const score = vsErrors.length ? Math.round((valid / vsErrors.length) * 100) : 0;

  document.getElementById('finish-my-score').textContent = `${score}% — ${valid} / ${vsErrors.length} fautes corrigées correctement`;
  document.getElementById('finish-stat-applied').textContent = applied;
  document.getElementById('finish-stat-valid').textContent = valid;
  document.getElementById('finish-stat-wrong').textContent = wrong;
  document.getElementById('finish-stat-missed').textContent = missed;

  if (opponentCount !== null) {
    document.getElementById('finish-op-applied').textContent = opponentCount;
  }

  // Words touched that are not errors
  const touchedCorrectSet = new Set();
  vsCorrections.forEach(c => {
    const idx = parseInt(c.idx);
    if (!detailMap.has(idx)) touchedCorrectSet.add(idx);
  });

  // Render text with colored badges
  let spanIdx = 0;
  const html = vsCorruptedText.split(/(\s+)/).map(seg => {
    if (/^\s+$/.test(seg)) return seg;
    const isPunct = /^[.,;:!?«»"'()\[\]\-—–]+$/.test(seg);
    const clean   = seg.replace(/^[^a-zA-ZÀ-ÿ]+|[^a-zA-ZÀ-ÿ]+$/g, '');
    if (isPunct || !clean) return escapeHtml(seg);

    const currentIdx = spanIdx++;
    const detail = detailMap.get(currentIdx);

    if (detail) {
      const userAnswer = userAnswerMap.get(currentIdx);
      let cls, display;
      if (!userAnswer)                                                      { cls = 'badge-result-red';    display = seg; }
      else if (normalizeStr(userAnswer) === normalizeStr(detail.original_valid)) { cls = 'badge-result-green';  display = userAnswer; }
      else                                                                   { cls = 'badge-result-orange'; display = userAnswer; }

      const tip = `<span class="tooltip-row"><span class="tooltip-label">Mot invalide</span><span>${escapeHtml(detail.displayed_invalid)}</span></span><span class="tooltip-row"><span class="tooltip-label">Votre réponse</span><span>${escapeHtml(userAnswer || '—')}</span></span><span class="tooltip-row"><span class="tooltip-label">Mot valide</span><span>${escapeHtml(detail.original_valid)}</span></span><span class="tooltip-divider"></span><span class="tooltip-row"><span class="tooltip-label">${escapeHtml(detail.error_type)}</span><span>${escapeHtml(detail.explanation || '')}</span></span>`;
      return `<span class="result-badge ${cls}">${escapeHtml(display)}<span class="result-tooltip">${tip}</span></span>`;
    }

    if (touchedCorrectSet.has(currentIdx)) {
      const c = vsCorrections.find(x => parseInt(x.idx) === currentIdx);
      const tip = `<span class="tooltip-row"><span class="tooltip-label">Mot correct</span><span>${escapeHtml(seg)}</span></span><span class="tooltip-row"><span class="tooltip-label">Votre modification</span><span>${escapeHtml(c?.correction || '—')}</span></span>`;
      return `<span class="result-badge badge-result-blue">${escapeHtml(c?.correction || seg)}<span class="result-tooltip">${tip}</span></span>`;
    }

    return escapeHtml(seg);
  }).join('');

  const container = document.getElementById('vs-results-text');
  if (container) container.innerHTML = html;
}

document.getElementById('btn-play-again')?.addEventListener('click', () => window.location.href = '/');
