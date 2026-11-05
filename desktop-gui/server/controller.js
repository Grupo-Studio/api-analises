// controller.js — mesma lógica de controllers/job_pro.controller.js (Modo API),
// adaptada para o jobStore (JSON local) em vez de MySQL.
//
// Exporta uma factory (createController) em vez de funções fixas, pra poder
// injetar onde fica o analisar_job.exe/services/analisar_job.py — isso deixa
// o módulo testável com Node puro (sem precisar do Electron de verdade rodando)
// e também correto quando empacotado pelo electron-packager.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const jobStore = require('./jobStore');
const logger = require('./logger');

/**
 * @param {object} opts
 * @param {string} opts.baseDir       Pasta onde procurar analisar_job.exe
 *                                    (pasta do .exe principal quando empacotado;
 *                                    pasta do projeto em desenvolvimento).
 * @param {string} opts.pyScriptPath  Caminho absoluto p/ services/analisar_job.py
 *                                    (fallback quando não há .exe empacotado).
 */
function createController({ baseDir, pyScriptPath }) {
  function caminhoAnalisadorPadrao() {
    const exeEmpacotado = path.join(baseDir, 'analisar_job.exe');
    if (fs.existsSync(exeEmpacotado)) return exeEmpacotado;
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  function usaScriptPy() {
    return !fs.existsSync(path.join(baseDir, 'analisar_job.exe'));
  }

  const PYTHON_BIN = process.env.PYTHON_BIN || caminhoAnalisadorPadrao();
  const SCRIPT_ARGS_PREFIX = usaScriptPy() ? [pyScriptPath] : [];

  logger.info(`Analisador: ${PYTHON_BIN}${SCRIPT_ARGS_PREFIX.length ? ' ' + SCRIPT_ARGS_PREFIX.join(' ') : ''} ` +
              `(${usaScriptPy() ? 'script .py' : 'analisar_job.exe empacotado'}) | baseDir=${baseDir}`);

  // ───────────────────────────────────────────────────────────────────────
  //  GET /api/jobs
  // ───────────────────────────────────────────────────────────────────────
  async function listarJobs(req, res) {
    try {
      const jobs = jobStore.listar();
      res.json({ total: jobs.length, jobs });
    } catch (err) {
      logger.erro('[listarJobs]', err);
      res.status(500).json({ error: err.message });
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  //  GET /api/jobs/:id  (raw_resultado já vem como objeto, não string)
  // ───────────────────────────────────────────────────────────────────────
  async function obterJob(req, res) {
    try {
      const job = jobStore.obterPorId(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job não encontrado' });
      res.json(job);
    } catch (err) {
      logger.erro('[obterJob]', err);
      res.status(500).json({ error: err.message });
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  //  DELETE /api/jobs/:id  (só o histórico local; nunca as pastas analisadas)
  // ───────────────────────────────────────────────────────────────────────
  async function excluirJob(req, res) {
    try {
      const job = jobStore.remover(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job não encontrado' });
      logger.info(`[excluir] Job removido do histórico: job="${job.num_job}" id=${job.id}`);
      res.json({ mensagem: 'Job excluído', id: job.id, num_job: job.num_job });
    } catch (err) {
      logger.erro('[excluirJob]', err);
      res.status(500).json({ error: err.message });
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  //  POST /api/jobs/analisar   Body: { pasta_raiz, num_job }
  // ───────────────────────────────────────────────────────────────────────
  async function analisarJob(req, res) {
    const { pasta_raiz, num_job } = req.body || {};

    if (!pasta_raiz || !num_job) {
      return res.status(400).json({ error: 'Campos obrigatórios: pasta_raiz, num_job' });
    }

    const inicio = Date.now();
    const duracao = () => logger.formatarDuracao(Date.now() - inicio);
    logger.info(`[analisar] Iniciando: job="${num_job}" pasta="${pasta_raiz}"`);

    const python = spawn(PYTHON_BIN, [...SCRIPT_ARGS_PREFIX, pasta_raiz], {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    let respondido = false;
    const responder = (status, corpo) => {
      if (respondido) return;
      respondido = true;
      res.status(status).json(corpo);
    };

    let stdout = '';
    let stderr = '';

    // setEncoding usa um decoder que não corta caractere multibyte no meio
    // quando o texto chega dividido em vários pedaços.
    python.stdout.setEncoding('utf8');
    python.stderr.setEncoding('utf8');
    python.stdout.on('data', chunk => { stdout += chunk; });
    python.stderr.on('data', chunk => {
      stderr += chunk;
      chunk.split(/\r?\n/).filter(l => l.trim()).forEach(l => logger.info(`[analisador ${num_job}] ${l}`));
    });

    python.on('error', err => {
      logger.erro(`[spawn] Não foi possível iniciar o analisador (${PYTHON_BIN}): ${err.message}`);
      responder(500, {
        error: 'Não foi possível iniciar o analisador de documentos',
        detalhes: err.message,
      });
    });

    python.on('close', code => {
      logger.info(`[analisar] Analisador terminou: job="${num_job}" exit=${code} | duração=${duracao()} | stdout=${stdout.length} chars | stderr=${stderr.length} chars`);
      if (respondido) return;
      let analise;
      try {
        const jsonStart = stdout.indexOf('{');
        if (jsonStart === -1) throw new Error('Nenhum JSON encontrado no stdout');
        analise = JSON.parse(stdout.slice(jsonStart));
      } catch (e) {
        if (code !== 0) {
          logger.erro(`[analisar] Falhou (exit ${code}) e a saída não é JSON.\n--- stderr (final) ---\n${stderr.slice(-2000)}\n--- stdout (final) ---\n${stdout.slice(-1000)}`);
          return responder(500, {
            error: `Análise falhou (exit ${code})`,
            detalhes: stderr.slice(-1000) || stdout.slice(-1000),
          });
        }
        logger.erro(`[analisar] Saída do analisador não é JSON válido: ${stdout.slice(0, 500)}`);
        return responder(500, {
          error: 'Resposta do analisador não é JSON válido',
          raw: stdout.slice(0, 500),
        });
      }

      if (analise.erro) {
        // O traceback do Python não vai pra tela do usuário, mas fica no log.
        logger.erro(`[analisar] Analisador devolveu erro para "${num_job}": ${analise.erro}` +
                    (analise.traceback ? `\n--- traceback do Python ---\n${analise.traceback}` : ''));
        return responder(422, { error: analise.erro });
      }
      if (code !== 0) {
        logger.erro(`[analisar] Falhou (exit ${code}).\n--- stderr (final) ---\n${stderr.slice(-2000)}`);
        return responder(500, {
          error: `Análise falhou (exit ${code})`,
          detalhes: stderr.slice(-1000),
        });
      }

      const resultados = analise.resultados || [];
      const checklist = analise.checklist || [];

      const campo = id => {
        const r = resultados.find(x => x.id === id);
        return r?.valor || null;
      };
      const alertaAtivo = desc => {
        const c = checklist.find(x => x.descricao === desc);
        return c?.alerta ? 1 : 0;
      };

      try {
        const job = jobStore.upsert({
          num_job, pasta_raiz,
          contrato_existe: campo('contrato_existe'),
          procuracao_existe: campo('procuracao_existe'),
          honorarios: campo('honorarios'),
          gross_up: campo('gross_up'),
          passivo: campo('passivo'),
          data_abertura: campo('data_abertura'),
          simples_nacional: campo('simples_nacional'),
          socios: campo('socios'),
          situacao_fiscal: campo('situacao_fiscal'),
          regularize: campo('regularize'),
          perfil: campo('perfil'),
          faturamento: campo('faturamento'),
          fastpass: campo('fastpass'),
          supply: campo('supply'),
          finap: campo('finap'),
          alerta_sem_contrato: alertaAtivo('SEM CONTRATO'),
          alerta_sem_procuracao: alertaAtivo('SEM PROCURAÇÃO'),
          alerta_baixo_fat: 0,
          alerta_regularize: alertaAtivo('COM REGULARIZE'),
          raw_resultado: analise, // objeto, não string — o frontend espera isso
        });

        logger.info(`[analisar] Concluído e salvo: job="${num_job}" id=${job.id} | duração=${duracao()} ` +
                    `(${analise.resumo?.encontrados ?? '?'}/${analise.resumo?.total ?? '?'} itens encontrados)`);
        responder(201, { mensagem: 'Análise concluída e salva com sucesso', job });
      } catch (dbErr) {
        logger.erro('[analisar] Erro ao salvar o resultado:', dbErr);
        responder(207, {
          mensagem: 'Análise concluída, mas não foi possível salvar',
          erro_banco: dbErr.message,
          analise,
        });
      }
    });
  }

  return { listarJobs, obterJob, analisarJob, excluirJob };
}

module.exports = { createController };
