/**
 * Comprueba la clave y el modelo de Gemini que usa la app.
 *
 *   pnpm gemini:check
 *
 * Hace una llamada real, muy corta, por el mismo SDK y con la misma clave que
 * el servidor. Nunca imprime la clave completa: solo una huella para poder
 * compararla con la de Google AI Studio.
 */
import { SETTINGS, llmDiagnostico, llmModeLabel } from '../src/config';

/** Traduce los errores habituales de la API a una causa concreta. */
function pista(mensaje: string): string | null {
  const texto = mensaje.toLowerCase();
  if (
    texto.includes('api key') ||
    texto.includes('api_key') ||
    texto.includes('unauthenticated') ||
    texto.includes('permission') ||
    texto.includes('403')
  ) {
    return 'La clave no es valida para este proyecto o no tiene la Generative Language API habilitada.';
  }
  if (texto.includes('not found') || texto.includes('404')) {
    return `El modelo "${SETTINGS.geminiModel}" no esta disponible para esta clave. Revisa GEMINI_MODEL.`;
  }
  if (texto.includes('quota') || texto.includes('429')) {
    return 'Se agoto la cuota del proyecto: la clave si se esta aplicando.';
  }
  if (texto.includes('excedio')) {
    return 'La API no respondio a tiempo: puede ser red o un modelo sobrecargado.';
  }
  return null;
}

async function main(): Promise<number> {
  const llm = llmDiagnostico();
  console.log(`Modo: ${llm.modoSolicitado} -> efectivo ${llm.modo} (${llmModeLabel()})`);
  console.log(`Modelo: ${llm.modelo} (${llm.modeloOrigen})`);
  console.log(`GEMINI_API_KEY: ${llm.apiKey}`);

  if (!llm.apiKeyPresente) {
    console.error('Falta GEMINI_API_KEY en .env: la app usaria fixtures locales, sin red.');
    return 1;
  }
  if (llm.modo !== 'gemini' && llm.modo !== 'cache') {
    console.error(
      `LLM_MODE=${llm.modoSolicitado} no usa Gemini: la clave esta cargada pero no se aplicaria.`,
    );
    return 1;
  }

  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: SETTINGS.geminiApiKey });

  try {
    const inicio = performance.now();
    const respuesta = await ai.models.generateContent({
      model: SETTINGS.geminiModel,
      contents: 'Responde unicamente con la palabra ok.',
      config: { temperature: 0, maxOutputTokens: 16 },
    });
    const ms = Math.round(performance.now() - inicio);
    console.log(`  Llamada: OK en ${ms} ms`);
    console.log(`  Modelo que respondio: ${respuesta.modelVersion ?? '(no informado)'}`);
    console.log(`  Texto: ${JSON.stringify((respuesta.text ?? '').trim().slice(0, 60))}`);
    console.log(`  Tokens: ${respuesta.usageMetadata?.totalTokenCount ?? 'n/d'}`);
    return 0;
  } catch (causa) {
    const mensaje = causa instanceof Error ? causa.message : String(causa);
    console.error(`  Llamada: ERROR -> ${mensaje}`);
    const sugerencia = pista(mensaje);
    if (sugerencia) console.error(`  Pista: ${sugerencia}`);
    return 1;
  }
}

process.exitCode = await main();
