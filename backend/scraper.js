import fetch from 'node-fetch';
import { load } from 'cheerio';

export async function scrapeRandom(source = 'wikipedia') {
  const MAX_RETRIES = 5;
  const RETRIABLE_ERRORS = ['Article trop court', 'Texte insuffisant'];

  async function attemptScrape() {
    if (source === 'lemonde') {
      try {
        return await scrapeLeMonde();
      } catch {
        return await scrapeWikipedia();
      }
    }
    return await scrapeWikipedia();
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await attemptScrape();
    } catch (error) {
      if (RETRIABLE_ERRORS.includes(error.message) && attempt < MAX_RETRIES - 1) {
        continue;
      }
      throw error;
    }
  }
}

async function scrapeWikipedia() {
  const res = await fetch('https://fr.wikipedia.org/wiki/Special:Random', {
    headers: { 'Accept-Language': 'fr-FR,fr;q=0.9', 'User-Agent': 'Grammerde/1.0' },
    redirect: 'follow',
  });
  const html = await res.text();
  const $ = load(html);
  const url = res.url;

  const paragraphs = [];
  $('#mw-content-text .mw-parser-output > p').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 50) paragraphs.push(text);
  });

  let text = paragraphs.join('\n\n');
  text = cleanText(text);
  // Send more text to the AI — it will cut to the requested size
  text = trimToWordCount(text, 400, 1200);

  if (text.split(/\s+/).length < 100) throw new Error('Article trop court');
  return { text, url };
}

async function scrapeLeMonde() {
  const res = await fetch('https://www.lemonde.fr', {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
  });
  const html = await res.text();
  const $ = load(html);

  let articleUrl = null;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!articleUrl && href && href.includes('lemonde.fr/') && href.includes('/article/')) {
      articleUrl = href;
    }
  });

  if (!articleUrl) throw new Error('Aucun article trouvé');

  const articleRes = await fetch(articleUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
  });
  const articleHtml = await articleRes.text();
  const $a = load(articleHtml);

  if ($a('.article__restricted-area').length > 0) throw new Error('Article derrière paywall');

  const paragraphs = [];
  $a('article p, .article__content p').each((_, el) => {
    const text = $a(el).text().trim();
    if (text.length > 50) paragraphs.push(text);
  });

  let text = paragraphs.join('\n\n');
  text = cleanText(text);
  text = trimToWordCount(text, 400, 1200);

  if (text.split(/\s+/).length < 100) throw new Error('Texte insuffisant');
  return { text, url: articleUrl };
}

function cleanText(text) {
  return text
    .replace(/\[\d+\]/g, '')                                                  // [1] references
    .replace(/\[note \d+\]/gi, '')                                             // [note 1]
    .replace(/\[réf\.\s*nécessaire\]/gi, '')                                   // [réf. nécessaire]
    .replace(/\([^)]*[Ͱ-ϿЀ-ӿ؀-ۿ][^)]*\)/g, '')  // Greek/Cyrillic in parens
    .replace(/\((?:en|de|it|es|pt|nl|pl|ar|zh|ja|ko|ru|la|gr|el)\s[^)]+\)/gi, '') // (en something)
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function trimToWordCount(text, min, max) {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  const slice = words.slice(0, max).join(' ');
  const lastDot = slice.lastIndexOf('.');
  return lastDot > min * 4 ? slice.slice(0, lastDot + 1) : slice;
}
