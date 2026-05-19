export const LANGUAGES = [
  { code: 'fr', flag: 'fr', name: 'Français' },
  { code: 'en', flag: 'gb', name: 'English'  },
  { code: 'es', flag: 'es', name: 'Español'  },
  { code: 'it', flag: 'it', name: 'Italiano' },
  { code: 'de', flag: 'de', name: 'Deutsch'  },
  { code: 'ar', flag: 'sa', name: 'العربية'  },
];

export function getLang() {
  return localStorage.getItem('lang') || 'fr';
}

export function setLang(code) {
  localStorage.setItem('lang', code);
}

export async function loadTranslations(lang = getLang()) {
  try {
    const res = await fetch(`/translations/${lang}.json`);
    if (!res.ok) throw new Error();
    return await res.json();
  } catch {
    if (lang !== 'fr') return loadTranslations('fr');
    return null;
  }
}

export function applyTranslations(t) {
  if (!t) return;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const value = el.dataset.i18n.split('.').reduce((o, k) => o?.[k], t);
    if (value != null) el.textContent = value;
  });
}

export function initLangSelector() {
  const currentCode = getLang();
  const current = LANGUAGES.find(l => l.code === currentCode) || LANGUAGES[0];

  const flagImg = document.getElementById('lang-flag-current');
  if (flagImg) {
    flagImg.src = `/public/${current.flag}.png`;
    flagImg.alt = current.name;
  }

  const dropdown = document.getElementById('lang-dropdown');
  if (!dropdown) return;

  dropdown.innerHTML = LANGUAGES.map(l => `
    <button class="lang-option${l.code === currentCode ? ' active' : ''}" data-lang="${l.code}">
      <img src="/public/${l.flag}.png" alt="${l.name}" class="lang-flag">
      <span>${l.name}</span>
    </button>
  `).join('');

  dropdown.querySelectorAll('.lang-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setLang(btn.dataset.lang);
      window.location.reload();
    });
  });

  document.getElementById('lang-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', () => dropdown.classList.add('hidden'));
}
