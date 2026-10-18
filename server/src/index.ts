import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { PATHS, SETTINGS, llmDiagnostico, llmModeLabel } from './config';
import { createApiRouter } from './api/routes';
import { getDb } from './storage/db';
import { iniciarTurso, programarSincronizacion } from './storage/turso';
import { ensureSeeded } from './storage/seed';
import { startQueue } from './jobs/queue';

/** RNF-8: una sola app; Express sirve la API y el build de React. */
export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  // El PDF viaja en base64 (crece ~33 %): 8 MB de archivo son ~10,7 MB de JSON.
  // El limite debe ir por encima del limite real que valida `normalizeEntry`.
  app.use(express.json({ limit: '12mb' }));

  // Cada escrito de la API adelanta la réplica a Turso (debounce de 800 ms),
  // así la nube no espera el siguiente ciclo periódico. Los trabajos de fondo
  // sin petición (cola) quedan cubiertos por el intervalo.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.on('finish', () => {
        if (res.statusCode < 400) programarSincronizacion();
      });
    }
    next();
  });

  app.use('/api', createApiRouter());

  // Express responde HTML por defecto a un cuerpo demasiado grande; la UI espera JSON.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const tipo = (error as { type?: string } | null)?.type;
    if (tipo === 'entity.too.large') {
      return res.status(413).json({
        error: 'El archivo supera el limite de 8 MB. Sube un PDF mas liviano.',
      });
    }
    if (error instanceof SyntaxError) {
      return res.status(400).json({ error: 'El cuerpo de la peticion no es JSON valido.' });
    }
    return res.status(500).json({ error: 'Error interno del servidor.' });
  });

  if (existsSync(PATHS.webDist)) {
    app.use(express.static(PATHS.webDist));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(resolve(PATHS.webDist, 'index.html'));
    });
  }

  return app;
}

const app = createApp();

getDb();
// La réplica va antes del seed: si la nube ya tiene datos y el local esta
// vacío, se restaura el local y el seed no vuelve a sembrar encima.
await iniciarTurso();
await ensureSeeded();
startQueue();

app.listen(SETTINGS.port, () => {
  console.log(`PayBlink escuchando en http://localhost:${SETTINGS.port}`);
  const llm = llmDiagnostico();
  const modo =
    llm.modoSolicitado === llm.modo
      ? `modo=${llm.modo}`
      : `modo=${llm.modo} (LLM_MODE=${llm.modoSolicitado})`;
  console.log(`  LLM: ${llmModeLabel()} · ${modo}`);
  console.log(`  Modelo: ${llm.modelo} (${llm.modeloOrigen})`);
  console.log(`  GEMINI_API_KEY: ${llm.apiKey}`);
  if (!llm.apiKeyPresente && llm.modoSolicitado !== 'fixture' && llm.modoSolicitado !== 'mock') {
    console.log('  Aviso: sin GEMINI_API_KEY; se usan fixtures locales (sin red).');
  }
  console.log(`  Estrategia del agente: ${SETTINGS.agentStrategy} (MAX_STEPS=${SETTINGS.maxSteps})`);
  if (!existsSync(PATHS.webDist)) {
    console.log('  Aviso: web/dist no existe. Ejecuta `npm run build` para servir la interfaz.');
  }
});
