import { apiPost, authHeaders, showToast, updateNav } from './auth.js';

updateNav();

const gameDataRaw = sessionStorage.getItem('gameData');
if (!gameDataRaw) { window.location.href = '/'; }

const gameData = JSON.parse(gameDataRaw);
let corrections = [];
let startTime = Date.now();
let currentErrorWord = null;

// ── Render text with error highlights ────────────────────────────────────────

function renderText(text, errorsMap) {
  // Build list of positions to highlight
  // We use wrong_word occurrences as markers
  const container = document.getElementById('text-display');
  if (!container) return;

  // Build segments from errors_map
  let html = text;

  // Sort errors by position (if available) then by word occurrence
  // We'll replace each wrong_word occurrence once
  const replaced = new Set();
  let result = '';
  let i = 0;

  // Build word spans - wrap each error word with a span
  const words = text.split(/(\s+)/);
  result = words.map(segment => {
    if (/\s+/.test(segment)) return segment;
    // Check if this word matches any error
    const error = errorsMap.find(e => {
      const normalize = s => s.replace(/[.,;:!?«»"'()\[\]]/g, '').trim();
      return normalize(segment).toLowerCase() === normalize(e.wrong_word).toLowerCase() && !replaced.has(e.wrong_word + '_' + segment);
    });
    if (error) {
      replaced.add(error.wrong_word + '_' + segment);
      const idx = errorsMap.indexOf(error);
      return `<span class="error-word" data-idx="${idx}" data-wrong="${error.wrong_word}" title="Cliquez pour corriger">${segment}</span>`;
    }
    return segment;
  }).join('');

  container.innerHTML = result;

  // Add click handlers
  container.querySelectorAll('.error-word').forEach(el => {
    el.addEventListener('click', () => openPopup(el));
  });
}

// ── Popup ─────────────────────────────────────────────────────────────────────

function openPopup(el) {
  currentErrorWord = el;
  const wrongWord = el.dataset.wrong;
  const existing = corrections.find(c => c.wrong_word === wrongWord);

  document.getElementById('popup-word').textContent = wrongWord;
  document.getElementById('popup-input').value = existing?.correction || '';
  document.getElementById('popup-overlay').classList.remove('hidden');
  document.getElementById('popup-input').focus();
}

function closePopup() {
  document.getElementById('popup-overlay').classList.add('hidden');
  currentErrorWord = null;
}

document.getElementById('popup-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'popup-overlay') closePopup();
});

document.getElementById('btn-popup-validate')?.addEventListener('click', submitCorrection);
document.getElementById('popup-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitCorrection();
  if (e.key === 'Escape') closePopup();
});

document.getElementById('btn-popup-skip')?.addEventListener('click', closePopup);

function submitCorrection() {
  const correction = document.getElementById('popup-input').value.trim();
  if (!correction) return;
  const wrongWord = currentErrorWord.dataset.wrong;

  const existing = corrections.findIndex(c => c.wrong_word === wrongWord);
  if (existing >= 0) corrections[existing].correction = correction;
  else corrections.push({ wrong_word: wrongWord, correction });

  currentErrorWord.classList.add('corrected');
  currentErrorWord.title = `Votre correction: ${correction}`;
  closePopup();
  updateProgress();
}

function updateProgress() {
  const total = gameData.total_errors;
  const done = corrections.length;
  const pct = total ? (done / total) * 100 : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = `${done} / ${total} fautes corrigées`;
}

// ── Submit final ─────────────────────────────────────────────────────────────

document.getElementById('btn-submit')?.addEventListener('click', async () => {
  const duration = Math.round((Date.now() - startTime) / 1000);
  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = 'Correction…';

  try {
    const result = await apiPost('/game/submit', {
      session_id: gameData.session_id,
      corrections,
      duration_seconds: duration,
    });
    sessionStorage.setItem('gameResult', JSON.stringify(result));
    sessionStorage.removeItem('gameData');
    renderResults(result);
  } catch (e) {
    showToast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Terminer et voir le score';
  }
});

function renderResults(result) {
  document.getElementById('game-view').classList.add('hidden');
  const rv = document.getElementById('results-view');
  rv.classList.remove('hidden');

  document.getElementById('score-value').textContent = result.score + '%';
  document.getElementById('score-summary').textContent =
    `${result.correct} / ${result.total} fautes corrigées correctement`;

  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = result.details.map(d => `
    <tr>
      <td>${d.wrong_word}</td>
      <td class="${d.is_correct ? 'result-correct' : 'result-wrong'}">${d.correct_word}</td>
      <td>${d.user_answer || '—'}</td>
      <td class="${d.is_correct ? 'result-correct' : 'result-wrong'}">${d.is_correct ? '✓' : '✗'}</td>
      <td>
        <div>${d.error_type}</div>
        <div class="result-explanation">${d.explanation || ''}</div>
      </td>
    </tr>
  `).join('');
}

document.getElementById('btn-replay')?.addEventListener('click', () => {
  window.location.href = '/';
});

// ── Init ─────────────────────────────────────────────────────────────────────

// For VS mode - check if timer data passed
const vsTimerData = sessionStorage.getItem('vsTimer');
if (vsTimerData) {
  document.getElementById('timer-block')?.classList.remove('hidden');
}

renderText(gameData.corrupted_text, []); // We don't have errors_map on client for security
// Fallback: parse text to find suspicious patterns visually
// The server sends total_errors but not the errors_map
// We render the whole text as is and let users click on any word

// Actually let's re-render properly: we need to present the corrupted text
// For the game page the server returned corrupted_text directly
// We create clickable spans for every word so user can select which to correct
function renderAllWords(text) {
  const container = document.getElementById('text-display');
  if (!container) return;
  const words = text.split(/(\s+)/);
  container.innerHTML = words.map(seg => {
    if (/\s+/.test(seg) || /^[.,;:!?«»"'()\[\]\-—–]+$/.test(seg)) return seg;
    const clean = seg.replace(/^[^a-zA-ZÀ-ÿ]+|[^a-zA-ZÀ-ÿ]+$/g, '');
    if (!clean) return seg;
    return `<span class="word-selectable" data-word="${clean}">${seg}</span>`;
  }).join('');

  container.querySelectorAll('.word-selectable').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => openWordPopup(el));
  });
}

function openWordPopup(el) {
  const word = el.dataset.word;
  document.getElementById('popup-word').textContent = word;
  const existing = corrections.find(c => c.wrong_word === word);
  document.getElementById('popup-input').value = existing?.correction || '';
  document.getElementById('popup-overlay').classList.remove('hidden');
  document.getElementById('popup-input').focus();
  currentErrorWord = el;
  currentErrorWord.dataset.wrong = word;
}

renderAllWords(gameData.corrupted_text);
updateProgress();
