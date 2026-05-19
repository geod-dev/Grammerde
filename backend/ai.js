import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TEXT_SIZE_HINTS = {
  court: 'environ 1 paragraphe',
  moyen: 'environ 2 paragraphes',
  long:  'environ 3 paragraphes',
};

// Same word-splitting logic as the frontend renderAllWords — must stay in sync
function processSegments(segments) {
  const corrupted_text = segments.map(s => s.type === 'error' ? s.invalide : s.content).join('');

  // Build character range for each segment
  let pos = 0;
  const ranges = segments.map((seg) => {
    const content = seg.type === 'error' ? seg.invalide : seg.content;
    const range = { start: pos, end: pos + content.length, seg };
    pos += content.length;
    return range;
  });

  // Walk the same token split as the frontend to assign span_idx
  const errors_map = [];
  const usedSegments = new Set();
  let spanIdx = 0;
  let charPos = 0;

  for (const token of corrupted_text.split(/(\s+)/)) {
    const isWhitespace = /^\s+$/.test(token);
    const isPunct    = /^[.,;:!?«»"'()\[\]\-—–]+$/.test(token);
    const clean      = token.replace(/^[^a-zA-ZÀ-ÿ]+|[^a-zA-ZÀ-ÿ]+$/g, '');
    const isWord     = !isWhitespace && !isPunct && clean;

    if (isWord) {
      const range = ranges.find(r => charPos >= r.start && charPos < r.end);
      if (range?.seg.type === 'error' && !usedSegments.has(range)) {
        usedSegments.add(range);
        errors_map.push({
          span_idx:     spanIdx,
          mot_invalide: clean,
          mot_valide:   range.seg.valide,
          error_type:   range.seg.error_type,
          explanation:  range.seg.explanation,
        });
      }
      spanIdx++;
    }
    charPos += token.length;
  }

  return { corrupted_text, errors_map };
}

export async function injectErrors(text, difficulty = 'moyen', errorTypes = [], textSize = 'moyen') {
  const sizeHint    = TEXT_SIZE_HINTS[textSize] || TEXT_SIZE_HINTS.moyen;
  const activeTypes = errorTypes.length
    ? errorTypes
    : ['conjugaison', 'accord', 'homophone', 'orthographe'];

  const typesConstraint = `IMPORTANT : Tu dois UNIQUEMENT introduire des fautes de ces types, de manière équilibrée (minimum 1 par type si possible) : ${activeTypes.join(', ')}.`;

  const systemPrompt = `Tu es un assistant qui introduit des fautes de français dans un texte.
Tu reçois un texte en français, un niveau de difficulté et des types de fautes.
Tu retournes UNIQUEMENT un JSON valide avec deux champs :

- "plan" : tableau de { word, context, replacement, error_type, explanation } — liste préparatoire des mots à modifier avec 5-6 mots de contexte autour pour t'assurer de choisir les bons. Ce champ sert uniquement à ta réflexion.
- "segments" : décomposition COMPLÈTE du texte choisi (${sizeHint}) en éléments consécutifs couvrant 100 % du texte, chaque élément étant soit :
    { "type": "text",    "content": "..." }
    { "type": "error",   "invalide": "...", "valide": "...", "error_type": "...", "explanation": "..." }

Règles :
- Les segments text + error mis bout à bout doivent reconstituer EXACTEMENT le texte choisi, caractère par caractère
- Chaque error porte sur UN SEUL mot (invalide et valide sont des mots isolés, sans espace ni ponctuation)
- invalide : le mot fautif tel qu'il apparaîtra dans le texte affiché au joueur
- valide : le mot original correct que le joueur doit retrouver
- ${typesConstraint}
- Introduis entre 8 et 15 fautes réparties équitablement sur tous les types autorisés
- Ne modifie jamais les noms propres ni les chiffres`;

  const userPrompt = `Types de fautes OBLIGATOIRES (tous, répartis équitablement) : ${activeTypes.join(', ')}

Texte:
${text}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
  });

  const result = JSON.parse(response.choices[0].message.content);
  if (!Array.isArray(result.segments)) {
    throw new Error('Réponse OpenAI invalide');
  }
  return processSegments(result.segments);
}

export function validateCorrection(userAnswer, correctWord) {
  const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalize(userAnswer) === normalize(correctWord);
}
