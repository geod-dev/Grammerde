import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db.js';
import { register, login, authenticateToken, optionalAuth } from './auth.js';
import { scrapeRandom } from './scraper.js';
import { injectErrors, validateCorrection } from './ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'frontend')));

// ── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Champs manquants' });
    const result = await register(username, email, password);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await login(email, password);
    res.json(result);
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, username, email, avatar_seed, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(user);
});

// ── Game ──────────────────────────────────────────────────────────────────────

app.post('/api/game/start', optionalAuth, async (req, res) => {
  try {
    const { difficulty = 'moyen', errorTypes = [], source = 'wikipedia' } = req.body;
    const { text, url } = await scrapeRandom(source);
    const { corrupted_text, errors_map } = await injectErrors(text, difficulty, errorTypes);

    const stmt = db.prepare(`
      INSERT INTO sessions (user_id, source_url, original_text, corrupted_text, errors_map, difficulty, error_types, total_errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      req.user?.id || null,
      url,
      text,
      corrupted_text,
      JSON.stringify(errors_map),
      difficulty,
      JSON.stringify(errorTypes),
      errors_map.length
    );

    res.json({
      session_id: result.lastInsertRowid,
      corrupted_text,
      total_errors: errors_map.length,
      difficulty,
    });
  } catch (e) {
    console.error('game/start error:', e);
    res.status(500).json({ error: 'Impossible de démarrer la partie: ' + e.message });
  }
});

app.post('/api/game/submit', optionalAuth, (req, res) => {
  try {
    const { session_id, corrections = [], duration_seconds } = req.body;
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id);
    if (!session) return res.status(404).json({ error: 'Session introuvable' });
    if (req.user && session.user_id !== req.user.id && session.user_id !== null) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const errorsMap = JSON.parse(session.errors_map);
    let correct = 0;
    const details = errorsMap.map((err) => {
      const userCorrection = corrections.find((c) => c.wrong_word === err.wrong_word);
      const isCorrect = userCorrection ? validateCorrection(userCorrection.correction, err.correct_word) : false;
      if (isCorrect) correct++;
      return {
        wrong_word: err.wrong_word,
        correct_word: err.correct_word,
        error_type: err.error_type,
        explanation: err.explanation,
        user_answer: userCorrection?.correction || null,
        is_correct: isCorrect,
      };
    });

    const score = errorsMap.length > 0 ? Math.round((correct / errorsMap.length) * 100) : 0;

    db.prepare(`
      UPDATE sessions SET score = ?, corrections_count = ?, duration_seconds = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(score, correct, duration_seconds || null, session_id);

    res.json({ score, correct, total: errorsMap.length, details });
  } catch (e) {
    console.error('game/submit error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/game/history', authenticateToken, (req, res) => {
  const sessions = db.prepare(`
    SELECT id, source_url, difficulty, score, corrections_count, total_errors, duration_seconds, completed_at
    FROM sessions WHERE user_id = ? AND completed_at IS NOT NULL
    ORDER BY completed_at DESC LIMIT 50
  `).all(req.user.id);
  res.json(sessions);
});

// ── Leaderboard ───────────────────────────────────────────────────────────────

app.get('/api/leaderboard', (req, res) => {
  const { period = 'all' } = req.query;
  let dateFilter = '';
  if (period === 'week') dateFilter = "AND s.completed_at >= datetime('now', '-7 days')";
  else if (period === 'month') dateFilter = "AND s.completed_at >= datetime('now', '-30 days')";

  const rows = db.prepare(`
    SELECT u.id, u.username, u.avatar_seed,
           ROUND(AVG(s.score), 1) as avg_score,
           COUNT(s.id) as games_played
    FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE s.completed_at IS NOT NULL AND s.score IS NOT NULL ${dateFilter}
    GROUP BY u.id
    ORDER BY avg_score DESC
    LIMIT 10
  `).all();
  res.json(rows);
});

// ── VS Mode ───────────────────────────────────────────────────────────────────

function genRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

app.post('/api/vs/create', authenticateToken, (req, res) => {
  const { difficulty = 'moyen' } = req.body;
  let code;
  do { code = genRoomCode(); } while (db.prepare('SELECT id FROM vs_rooms WHERE room_code = ?').get(code));

  db.prepare('INSERT INTO vs_rooms (room_code, player1_id, difficulty) VALUES (?, ?, ?)').run(code, req.user.id, difficulty);
  res.json({ room_code: code });
});

app.post('/api/vs/join', authenticateToken, (req, res) => {
  const { room_code } = req.body;
  const room = db.prepare('SELECT * FROM vs_rooms WHERE room_code = ?').get(room_code);
  if (!room) return res.status(404).json({ error: 'Room introuvable' });
  if (room.status !== 'waiting') return res.status(400).json({ error: 'Partie déjà en cours' });
  if (room.player1_id === req.user.id) return res.status(400).json({ error: 'Vous êtes déjà dans cette room' });

  db.prepare('UPDATE vs_rooms SET player2_id = ? WHERE id = ?').run(req.user.id, room.id);
  res.json({ room_code, room_id: room.id });
});

app.get('/api/vs/room/:code', (req, res) => {
  const room = db.prepare('SELECT * FROM vs_rooms WHERE room_code = ?').get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room introuvable' });
  res.json(room);
});

app.post('/api/vs/submit', authenticateToken, (req, res) => {
  const { room_code, corrections_count } = req.body;
  const room = db.prepare('SELECT * FROM vs_rooms WHERE room_code = ?').get(room_code);
  if (!room) return res.status(404).json({ error: 'Room introuvable' });

  db.prepare('INSERT INTO vs_scores (room_id, user_id, corrections_count) VALUES (?, ?, ?)').run(room.id, req.user.id, corrections_count);
  res.json({ ok: true });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

const rooms = new Map(); // roomCode → { p1: ws, p2: ws, timer, scores, gameData }

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join_room') {
      const { room_code, user_id, username } = msg;
      const room = db.prepare('SELECT * FROM vs_rooms WHERE room_code = ?').get(room_code);
      if (!room) return ws.send(JSON.stringify({ type: 'error', message: 'Room introuvable' }));

      if (!rooms.has(room_code)) rooms.set(room_code, { players: [], scores: {}, gameData: null, timer: null });
      const roomState = rooms.get(room_code);

      ws.roomCode = room_code;
      ws.userId = user_id;
      ws.username = username;

      // Replace if reconnecting
      const existing = roomState.players.findIndex(p => p.userId === user_id);
      if (existing >= 0) roomState.players[existing] = ws;
      else roomState.players.push(ws);

      roomState.scores[user_id] = roomState.scores[user_id] || 0;
      broadcast(roomState.players, { type: 'player_joined', username, player_count: roomState.players.length });

      if (roomState.players.length === 2 && !roomState.gameData) {
        // Both players connected — start game
        try {
          const { text } = await scrapeRandom('wikipedia');
          const { corrupted_text, errors_map } = await injectErrors(text, room.difficulty || 'moyen', []);

          db.prepare('UPDATE vs_rooms SET corrupted_text = ?, errors_map = ?, status = ? WHERE room_code = ?')
            .run(corrupted_text, JSON.stringify(errors_map), 'playing', room_code);

          roomState.gameData = { corrupted_text, errors_map, total: errors_map.length };

          const startMsg = {
            type: 'game_start',
            corrupted_text,
            total_errors: errors_map.length,
            duration: 120,
          };
          broadcast(roomState.players, startMsg);

          // Timer
          let remaining = 120;
          roomState.timer = setInterval(() => {
            remaining--;
            broadcast(roomState.players, { type: 'tick', remaining });
            if (remaining <= 0) endGame(room_code);
          }, 1000);

        } catch (e) {
          broadcast(roomState.players, { type: 'error', message: 'Erreur de démarrage: ' + e.message });
        }
      }
    }

    if (msg.type === 'correction') {
      const { room_code, user_id, corrections_count } = msg;
      const roomState = rooms.get(room_code);
      if (!roomState) return;
      roomState.scores[user_id] = corrections_count;
      broadcast(roomState.players, { type: 'score_update', scores: roomState.scores });
    }
  });

  ws.on('close', () => {
    const { roomCode, userId } = ws;
    if (!roomCode || !rooms.has(roomCode)) return;
    const roomState = rooms.get(roomCode);
    roomState.players = roomState.players.filter(p => p !== ws);

    if (roomState.players.length === 1 && roomState.gameData) {
      // Opponent disconnected — give winner 10s
      broadcast(roomState.players, { type: 'opponent_disconnected' });
      setTimeout(() => {
        if (rooms.has(roomCode)) endGame(roomCode, userId);
      }, 10000);
    }
  });
});

function endGame(roomCode, disconnectedUserId = null) {
  const roomState = rooms.get(roomCode);
  if (!roomState) return;

  clearInterval(roomState.timer);

  const scores = roomState.scores;
  let winnerId = null;
  if (disconnectedUserId) {
    const remaining = roomState.players.find(p => p.userId !== disconnectedUserId);
    winnerId = remaining?.userId;
  } else {
    winnerId = Object.entries(scores).sort(([, a], [, b]) => b - a)[0]?.[0];
  }

  db.prepare('UPDATE vs_rooms SET status = ?, winner_id = ? WHERE room_code = ?').run('finished', winnerId, roomCode);

  broadcast(roomState.players, {
    type: 'game_over',
    scores,
    winner_id: winnerId,
  });

  rooms.delete(roomCode);
}

function broadcast(players, data) {
  const msg = JSON.stringify(data);
  players.forEach(p => { if (p.readyState === 1) p.send(msg); });
}

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Grammerde running on http://localhost:${PORT}`));
