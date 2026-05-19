import { apiGet, apiPut, getToken, getUser, updateUser, logout, showToast, updateNav } from './auth.js';
import { loadTranslations, applyTranslations, initLangSelector } from './i18n.js';

updateNav();
initLangSelector();
loadTranslations().then(applyTranslations);
document.getElementById('btn-logout')?.addEventListener('click', logout);

if (!getToken()) {
  window.location.href = '/';
}

const user = getUser();

async function loadProfile() {
  try {
    const [me, history] = await Promise.all([
      apiGet('/auth/me'),
      apiGet('/game/history'),
    ]);

    renderHeader(me);
    renderStats(history);
    renderChart(history);
    renderHistory(history);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function renderHeader(me) {
  const avatarUrl = `https://api.dicebear.com/7.x/pixel-art/svg?seed=${encodeURIComponent(me.avatar_seed || me.username)}`;
  document.getElementById('profile-avatar').src = avatarUrl;
  document.getElementById('profile-name').textContent = me.username;
  document.getElementById('profile-since').textContent = `Membre depuis ${new Date(me.created_at).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long' })}`;
}

function renderStats(history) {
  const completed = history.filter(s => s.score !== null);
  const avgScore = completed.length
    ? Math.round(completed.reduce((a, s) => a + s.score, 0) / completed.length)
    : 0;

  document.getElementById('stat-games').textContent = history.length;
  document.getElementById('stat-avg').textContent = avgScore + '%';

  // Streak: consecutive days with at least one game
  const days = new Set(
    completed.map(s => new Date(s.completed_at).toDateString())
  );
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    if (days.has(d.toDateString())) streak++;
    else if (i > 0) break;
  }
  document.getElementById('stat-streak').textContent = streak + ' j';

  // Best difficulty
  const difficultyScores = {};
  completed.forEach(s => {
    if (!difficultyScores[s.difficulty]) difficultyScores[s.difficulty] = [];
    difficultyScores[s.difficulty].push(s.score);
  });
  const bestDiff = Object.entries(difficultyScores)
    .map(([d, scores]) => ({ d, avg: scores.reduce((a, b) => a + b, 0) / scores.length }))
    .sort((a, b) => b.avg - a.avg)[0];
  document.getElementById('stat-best-diff').textContent = bestDiff
    ? { facile: 'Facile', moyen: 'Moyen', difficile: 'Difficile' }[bestDiff.d] || bestDiff.d
    : '—';
}

function renderChart(history) {
  const canvas = document.getElementById('score-chart');
  if (!canvas || !window.Chart) return;

  const completed = history.filter(s => s.score !== null).slice(0, 20).reverse();
  if (!completed.length) return;

  const labels = completed.map((s, i) => `#${i + 1}`);
  const data = completed.map(s => s.score);

  new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Score',
        data,
        borderColor: '#1A7842',
        backgroundColor: 'rgba(26,120,66,0.08)',
        tension: 0.4,
        pointBackgroundColor: '#1A7842',
        pointRadius: 4,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => `${ctx.parsed.y}%` },
        },
      },
      scales: {
        x: { grid: { color: '#E3DDD5' }, ticks: { color: '#6D6660' } },
        y: {
          grid: { color: '#E3DDD5' },
          ticks: { color: '#6D6660', callback: v => v + '%' },
          min: 0, max: 100,
        },
      },
    },
  });
}

function renderHistory(history) {
  const tbody = document.getElementById('history-tbody');
  if (!tbody) return;

  if (!history.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:32px">Aucune partie jouée</td></tr>';
    return;
  }

  const diffBadge = { facile: 'badge-easy', moyen: 'badge-medium', difficile: 'badge-hard' };
  const diffLabel = { facile: 'Facile', moyen: 'Moyen', difficile: 'Difficile' };

  tbody.innerHTML = history.map(s => `
    <tr>
      <td>${new Date(s.completed_at).toLocaleDateString('fr-FR')}</td>
      <td><span class="badge ${diffBadge[s.difficulty] || ''}">${diffLabel[s.difficulty] || s.difficulty}</span></td>
      <td style="font-family:var(--font-display);font-weight:800;color:var(--green)">${s.score !== null ? s.score + '%' : '—'}</td>
      <td>${s.corrections_count} / ${s.total_errors}</td>
      <td style="color:var(--text-dim)">${s.duration_seconds ? Math.floor(s.duration_seconds / 60) + 'min ' + (s.duration_seconds % 60) + 's' : '—'}</td>
    </tr>
  `).join('');
}

loadProfile();

// ── Edit Profile ──────────────────────────────────────────────────────────────

function dicebearUrl(seed) {
  return `https://api.dicebear.com/7.x/pixel-art/svg?seed=${encodeURIComponent(seed || 'default')}`;
}

function openEditModal() {
  const me = getUser();
  document.getElementById('edit-username').value = me?.username || '';
  document.getElementById('edit-avatar-seed').value = me?.avatar_seed || '';
  document.getElementById('edit-avatar-preview').src = dicebearUrl(me?.avatar_seed || me?.username || '');
  document.getElementById('edit-profile-error').textContent = '';
  document.getElementById('modal-edit-profile').classList.remove('hidden');
  document.getElementById('edit-username').focus();
}

function closeEditModal() {
  document.getElementById('modal-edit-profile').classList.add('hidden');
}

document.getElementById('btn-edit-profile')?.addEventListener('click', openEditModal);
document.getElementById('close-edit-profile')?.addEventListener('click', closeEditModal);
document.getElementById('btn-cancel-edit')?.addEventListener('click', closeEditModal);
document.getElementById('modal-edit-profile')?.addEventListener('click', (e) => {
  if (e.target.id === 'modal-edit-profile') closeEditModal();
});

document.getElementById('edit-avatar-seed')?.addEventListener('input', (e) => {
  const username = document.getElementById('edit-username').value.trim();
  const seed = e.target.value.trim() || username;
  if (seed) document.getElementById('edit-avatar-preview').src = dicebearUrl(seed);
});

document.getElementById('edit-username')?.addEventListener('input', (e) => {
  const seed = document.getElementById('edit-avatar-seed').value.trim() || e.target.value.trim();
  if (seed) document.getElementById('edit-avatar-preview').src = dicebearUrl(seed);
});

document.getElementById('form-edit-profile')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('edit-username').value.trim();
  const avatar_seed = document.getElementById('edit-avatar-seed').value.trim();
  const err = document.getElementById('edit-profile-error');
  err.textContent = '';

  const btn = e.target.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Enregistrement…';

  try {
    const updated = await apiPut('/auth/profile', { username, avatar_seed });
    updateUser(updated);
    updateNav();
    renderHeader(updated);
    closeEditModal();
    showToast('Profil mis à jour !', 'success');
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enregistrer';
  }
});
