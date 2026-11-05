// app.js — monta o Express app (rotas + frontend estático).
// Fábrica pura: não escuta porta nenhuma sozinha (quem faz isso é main.js
// ou, em teste headless, um pequeno script à parte) — facilita testar com
// supertest/curl sem precisar do Electron de verdade.

const express = require('express');
const cors = require('cors');
const path = require('path');
const jobStore = require('./jobStore');
const logger = require('./logger');
const { createController } = require('./controller');

/**
 * @param {object} opts
 * @param {string} opts.baseDir      Pasta onde procurar analisar_job.exe.
 * @param {string} opts.pyScriptPath Caminho p/ services/analisar_job.py (dev).
 * @param {string} opts.dbFile       Caminho do arquivo jobs.json.
 * @param {string} opts.frontendDir  Pasta com o index.html a servir em "/".
 */
function createApp({ baseDir, pyScriptPath, dbFile, frontendDir }) {
  jobStore.init(dbFile);

  const controller = createController({ baseDir, pyScriptPath });

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Registra toda chamada de API que deu erro (4xx/5xx). O polling da tela de
  // logs fica de fora pra não poluir.
  app.use('/api', (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400 && !req.originalUrl.startsWith('/api/logs')) {
        logger.aviso(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
      }
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', db: 'ok' }));

  // Tela de logs (frontend/logs.html): lista incremental + limpar tela.
  app.get('/api/logs', (req, res) => res.json({
    ...logger.listar(parseInt(req.query.desde, 10) || 0),
    arquivo: logger.caminhoArquivo(),
  }));
  app.post('/api/logs/limpar', (req, res) => { logger.limparTela(); res.json({ ok: true }); });


  const queueRouter = express.Router();
  require('./jobQueue').mountQueue(queueRouter, controller);
  app.use('/api', queueRouter);

  app.get('/api/jobs', controller.listarJobs);
  app.get('/api/jobs/:id', controller.obterJob);
  app.post('/api/jobs/analisar', controller.analisarJob);
  app.delete('/api/jobs/:id', controller.excluirJob);

  app.use(express.static(frontendDir));
  app.get('/', (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));

  return app;
}

module.exports = { createApp };
