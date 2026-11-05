const router     = require('express').Router();
const controller = require('../controllers/job_pro.controller');

require('../desktop-gui/server/jobQueue').mountQueue(router, controller);

// GET  /api/jobs          — lista todos os jobs analisados
router.get('/jobs', controller.listarJobs);

// GET  /api/jobs/:id      — detalhes de um job específico
router.get('/jobs/:id', controller.obterJob);

// DELETE /api/jobs/:id    — exclui um job do histórico
router.delete('/jobs/:id', controller.excluirJob);

// POST /api/jobs/analisar — dispara análise de um diretório
// Body: { pasta_raiz: "...", num_job: "..." }
router.post('/jobs/analisar', controller.analisarJob);

module.exports = router;
