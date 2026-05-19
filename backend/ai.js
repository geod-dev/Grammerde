import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DIFFICULTY_INSTRUCTIONS = {
  facile: 'fautes grossières: accords simples, homophones évidents (a/à, est/et, son/sont, on/ont, ces/ses)',
  moyen: 'conjugaisons incorrectes, accords sujet-verbe manqués, pluriels oubliés, temps verbaux erronés',
  difficile: 'subjonctif mal employé, participes passés complexes avec accord de COD, accords rares, syntaxe subtile',
};

export async function injectErrors(text, difficulty = 'moyen', errorTypes = []) {
  const difficultyHint = DIFFICULTY_INSTRUCTIONS[difficulty] || DIFFICULTY_INSTRUCTIONS.moyen;
  const activeTypes = errorTypes.length ? errorTypes : ['conjugaison', 'orthographe', 'accord', 'homophone', 'ponctuation', 'syntaxe'];
  const typesConstraint = errorTypes.length
    ? `IMPORTANT : Tu dois UNIQUEMENT introduire des fautes de ces types (aucun autre type n'est autorisé) : ${errorTypes.join(', ')}.`
    : 'Introduis un mélange équilibré de tous les types de fautes.';

  const systemPrompt = `Tu es un assistant qui introduit des fautes de français dans un texte.
Tu reçois un texte en français, un niveau de difficulté et des types de fautes.
Tu retournes UNIQUEMENT un JSON valide avec :
- "corrupted_text" : le texte avec les fautes introduites
- "errors_map" : un tableau d'objets { position_start, position_end, wrong_word, correct_word, error_type, explanation }

Niveaux de difficulté :
- facile : fautes grossières (accords simples, homophones évidents : "a/à", "est/et")
- moyen : conjugaisons incorrectes, accords sujet-verbe manqués, pluriels oubliés
- difficile : subjonctif mal employé, participes passés complexes, accords rares

Types de fautes disponibles : conjugaison, orthographe, accord, homophone, ponctuation, syntaxe

${typesConstraint}

Chaque objet dans errors_map doit avoir error_type égal à l'un des types autorisés.
Introduis entre 8 et 15 fautes. Ne modifie pas les noms propres.`;

  const userPrompt = `Niveau: ${difficulty} (${difficultyHint})
Types de fautes autorisés UNIQUEMENT : ${activeTypes.join(', ')}

Texte:
${text}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
  });

  const result = JSON.parse(response.choices[0].message.content);
  if (!result.corrupted_text || !Array.isArray(result.errors_map)) {
    throw new Error('Réponse OpenAI invalide');
  }
  return result;
}

export function validateCorrection(userAnswer, correctWord) {
  const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalize(userAnswer) === normalize(correctWord);
}
