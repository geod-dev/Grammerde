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
app.use('/public', express.static(join(__dirname, '..', 'public')));
app.use('/favicon.ico', express.static(join(__dirname, '..', 'public', 'favicon.ico')));

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

app.put('/api/auth/profile', authenticateToken, (req, res) => {
  try {
    const { username, avatar_seed } = req.body;
    if (!username || username.trim().length < 2) return res.status(400).json({ error: 'Pseudo trop court (2 caractères min)' });

    const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username.trim(), req.user.id);
    if (taken) return res.status(400).json({ error: 'Ce pseudo est déjà utilisé' });

    const seed = (avatar_seed || '').trim() || username.trim();
    db.prepare('UPDATE users SET username = ?, avatar_seed = ? WHERE id = ?').run(username.trim(), seed, req.user.id);

    const user = db.prepare('SELECT id, username, email, avatar_seed, created_at FROM users WHERE id = ?').get(req.user.id);
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Game ──────────────────────────────────────────────────────────────────────

const TIMER_DURATIONS = { court: 60, moyen: 120, long: 180 };

app.post('/api/game/start', optionalAuth, async (req, res) => {
  try {
    const { difficulty = 'moyen', errorTypes = [], textSize = 'moyen', lang = 'fr' } = req.body;
    const timerDuration = TIMER_DURATIONS[textSize] || 120;
    const { text, url } = await scrapeRandom(lang);
    const { corrupted_text, errors_map } = await injectErrors(text, difficulty, errorTypes, textSize, lang);

    const stmt = db.prepare(`
      INSERT INTO sessions (user_id, source_url, original_text, corrupted_text, errors_map, difficulty, error_types, total_errors, timer_duration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      req.user?.id || null,
      url,
      text,
      corrupted_text,
      JSON.stringify(errors_map),
      difficulty,
      JSON.stringify(errorTypes),
      errors_map.length,
      timerDuration
    );

    res.json({
      session_id: result.lastInsertRowid,
      corrupted_text,
      total_errors: errors_map.length,
      difficulty,
      timer_duration: timerDuration,
    });
  } catch (e) {
    console.error('game/start error:', e);
    res.status(500).json({ error: 'Impossible de démarrer la partie: ' + e.message });
  }
});

// Real-time correction validation
app.post('/api/game/correct', optionalAuth, (req, res) => {
  try {
    const { session_id, span_idx, correction } = req.body;
    if (session_id == null || span_idx == null || !correction) return res.status(400).json({ error: 'Paramètres manquants' });

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id);
    if (!session) return res.status(404).json({ error: 'Session introuvable' });

    const errorsMap = JSON.parse(session.errors_map);
    const error = errorsMap.find(e => e.span_idx === span_idx);

    if (!error) {
      return res.json({ is_correct: false, not_an_error: true });
    }

    const is_correct = validateCorrection(correction, error.original_valid);

    db.prepare(`
      INSERT INTO session_corrections (session_id, span_idx, user_answer, is_correct)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, span_idx) DO UPDATE SET user_answer = excluded.user_answer, is_correct = excluded.is_correct
    `).run(session_id, span_idx, correction, is_correct ? 1 : 0);

    res.json({
      is_correct,
      original_valid: error.original_valid,
      error_type:     error.error_type,
      explanation:    error.explanation,
    });
  } catch (e) {
    console.error('game/correct error:', e);
    res.status(500).json({ error: e.message });
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

    // Prefer server-stored corrections; fallback to client-sent
    const stored = db.prepare('SELECT * FROM session_corrections WHERE session_id = ?').all(session_id);

    let correct = 0;
    const details = errorsMap.map((err) => {
      const sv = stored.find(c => c.span_idx === err.span_idx);
      const cl = corrections.find(c => c.span_idx === err.span_idx);

      let userAnswer, isCorrect;
      if (sv) {
        userAnswer = sv.user_answer;
        isCorrect = sv.is_correct === 1;
      } else if (cl) {
        userAnswer = cl.correction;
        isCorrect = validateCorrection(cl.correction, err.original_valid);
      } else {
        userAnswer = null;
        isCorrect = false;
      }

      if (isCorrect) correct++;
      return {
        span_idx:          err.span_idx,
        displayed_invalid: err.displayed_invalid,
        original_valid:    err.original_valid,
        error_type:        err.error_type,
        explanation:       err.explanation,
        user_answer:       userAnswer,
        is_correct:        isCorrect,
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

const rooms = new Map();

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

      const existing = roomState.players.findIndex(p => p.userId === user_id);
      if (existing >= 0) roomState.players[existing] = ws;
      else roomState.players.push(ws);

      roomState.scores[user_id] = roomState.scores[user_id] || 0;
      broadcast(roomState.players, { type: 'player_joined', username, player_count: roomState.players.length });

      if (roomState.players.length === 2 && !roomState.gameData) {
        try {
          const { text } = await scrapeRandom('wikipedia');
          const { corrupted_text, errors_map } = await injectErrors(text, room.difficulty || 'moyen', [], 'moyen');

          db.prepare('UPDATE vs_rooms SET corrupted_text = ?, errors_map = ?, status = ? WHERE room_code = ?')
            .run(corrupted_text, JSON.stringify(errors_map), 'playing', room_code);

          roomState.gameData = { corrupted_text, errors_map, total: errors_map.length };

          broadcast(roomState.players, {
            type: 'game_start',
            corrupted_text,
            errors_map,
            total_errors: errors_map.length,
            duration: 120,
          });

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
  broadcast(roomState.players, { type: 'game_over', scores, winner_id: winnerId });
  rooms.delete(roomCode);
}

function broadcast(players, data) {
  const msg = JSON.stringify(data);
  players.forEach(p => { if (p.readyState === 1) p.send(msg); });
}

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Grammerde running on http://localhost:${PORT}`));
