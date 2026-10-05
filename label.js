// Etikett-Erkennung über die Claude API (offizielles SDK, direkt aus dem Browser).
// Der API-Key bleibt lokal auf dem Gerät und wird nur an api.anthropic.com gesendet.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm';

const WINE_SCHEMA = {
  type: 'object',
  properties: {
    is_wine_label: { type: 'boolean', description: 'false, wenn auf dem Bild kein Weinetikett zu sehen ist' },
    name: { type: 'string', description: 'Name des Weins / der Cuvée, ohne Produzent' },
    producer: { type: 'string', description: 'Weingut / Produzent' },
    vintage: { type: ['integer', 'null'], description: 'Jahrgang, null wenn nicht erkennbar (z.B. NV)' },
    type: { type: 'string', enum: ['rot', 'weiss', 'rose', 'schaum', 'suess', 'likoer'] },
    country: { type: 'string', description: 'Land auf Deutsch, z.B. Italien' },
    region: { type: 'string', description: 'Anbaugebiet / Appellation' },
    grapes: { type: 'string', description: 'Rebsorte(n), kommagetrennt' },
    alcohol: { type: ['number', 'null'], description: 'Alkohol in % vol.' },
    drink_from: { type: ['integer', 'null'], description: 'Geschätzter Beginn des Trinkfensters (Jahr)' },
    drink_until: { type: ['integer', 'null'], description: 'Geschätztes Ende des Trinkfensters (Jahr)' },
    description: { type: 'string', description: 'Kurze Beschreibung von Stil und Geschmack auf Deutsch, 1-2 Sätze' },
    food_pairing: { type: 'string', description: 'Passende Speisen, kurz, auf Deutsch' },
  },
  required: ['is_wine_label', 'name', 'producer', 'vintage', 'type', 'country', 'region', 'grapes',
    'alcohol', 'drink_from', 'drink_until', 'description', 'food_pairing'],
  additionalProperties: false,
};

const PROMPT = `Du bist Sommelier. Lies das Weinetikett auf dem Foto und gib die Daten zurück.
Felder, die nicht auf dem Etikett stehen, darfst du aus deinem Weinwissen ergänzen (z.B. Rebsorte einer bekannten Appellation).
Schätze das Trinkfenster realistisch anhand von Stil, Herkunft und Jahrgang. Wenn du etwas nicht weisst, nutze einen leeren String bzw. null.`;

let sdkPromise;

export async function recognizeLabel(apiKey, dataUrl) {
  if (!apiKey) throw new Error('Bitte zuerst einen Claude API-Key in den Einstellungen hinterlegen.');
  sdkPromise ??= import(SDK_URL);
  const { default: Anthropic } = await sdkPromise;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const [, mediaType, data] = dataUrl.match(/^data:(image\/[a-z]+);base64,(.*)$/) || [];
  if (!data) throw new Error('Bildformat nicht unterstützt.');

  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: WINE_SCHEMA },
    },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Die Anfrage wurde abgelehnt.');
  if (response.stop_reason === 'max_tokens') throw new Error('Antwort unvollständig, bitte erneut versuchen.');
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Keine Antwort erhalten.');
  const result = JSON.parse(text);
  if (!result.is_wine_label) throw new Error('Auf dem Foto wurde kein Weinetikett erkannt.');
  return result;
}
