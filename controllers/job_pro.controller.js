const { spawn }  = require('child_process');
const path        = require('path');
const fs          = require('fs');
const { getPool } = require('../db/connection');
// Logger compartilhado com o Modo Desktop (buffer em memória + data/logs/app.log).
const logger      = require('../desktop-gui/server/logger');

const DATA_DIR    = path.join(baseDir(), 'data', 'jobs');
const PYTHON_BIN   = process.env.PYTHON_BIN || caminhoAnalisadorPadrao();
const SCRIPT_ARGS_PREFIX = usaScriptPy() ? [path.join(__dirname, '../services/analisar_job.py')] : [];

// Quando empacotado (process.pkg definido), o caminho base é a pasta onde
// está o .exe; em desenvolvimento, é a raiz do projeto.
function baseDir() {
  return process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
}

// Se existir um analisar_job.exe standalone (gerado com PyInstaller) ao lado
// do executável/projeto, usa ele — não precisa de Python instalado na máquina.
// Caso contrário, cai para "python3 services/analisar_job.py" (modo dev).
function caminhoAnalisadorPadrao() {
  const exeEmpacotado = path.join(baseDir(), 'analisar_job.exe');
  if (fs.existsSync(exeEmpacotado)) return exeEmpacotado;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function usaScriptPy() {
  const exeEmpacotado = path.join(baseDir(), 'analisar_job.exe');
  return !fs.existsSync(exeEmpacotado);
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/jobs  — lista todos os jobs
// ─────────────────────────────────────────────────────────────────────────────
exports.listarJobs = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(`
      SELECT
        id, num_job, pasta_raiz, status_analise,
        contrato_existe, procuracao_existe, honorarios, gross_up, passivo,
        data_abertura, simples_nacional, socios,
        situacao_fiscal, regularize, perfil,
        faturamento, fastpass, supply, finap,
        alerta_sem_contrato, alerta_sem_procuracao, alerta_baixo_fat, alerta_regularize,
        analisado_em, created_at
      FROM jobs_pro
      ORDER BY analisado_em DESC
    `);
    res.json({ total: rows.length, jobs: rows });
  } catch (err) {
    logger.erro('[listarJobs]', err);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/jobs/:id  — detalhes de um job (inclui raw_resultado)
// ─────────────────────────────────────────────────────────────────────────────
exports.obterJob = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM jobs_pro WHERE id = ?', [req.params.id]);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Job não encontrado' });
    }
    res.json(row);
  } catch (err) {
    logger.erro('[obterJob]', err);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/jobs/:id  — remove um job do histórico (só o registro no MySQL;
//  nunca toca nas pastas analisadas nem nos JSONs de data/jobs/)
// ─────────────────────────────────────────────────────────────────────────────
exports.excluirJob = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT id, num_job FROM jobs_pro WHERE id = ?', [req.params.id]);
    const job = rows[0];
    if (!job) return res.status(404).json({ error: 'Job não encontrado' });
    await pool.query('DELETE FROM jobs_pro WHERE id = ?', [job.id]);
    logger.info(`[excluir] Job removido do histórico: job="${job.num_job}" id=${job.id}`);
    res.json({ mensagem: 'Job excluído', id: job.id, num_job: job.num_job });
  } catch (err) {
    logger.erro('[excluirJob]', err);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/jobs/analisar  — dispara análise de um diretório
//  Body: { pasta_raiz: "...", num_job: "..." }
// ─────────────────────────────────────────────────────────────────────────────
exports.analisarJob = async (req, res) => {
  const { pasta_raiz, num_job } = req.body || {};

  if (!pasta_raiz || !num_job) {
    return res.status(400).json({
      error: 'Campos obrigatórios: pasta_raiz, num_job',
    });
  }

  const inicio  = Date.now();
  const duracao = () => logger.formatarDuracao(Date.now() - inicio);
  logger.info(`[analisar] Iniciando: job="${num_job}" pasta="${pasta_raiz}"`);

  // Executa o analisador (exe standalone em produção, ou "python3 script.py" em dev)
  const python = spawn(PYTHON_BIN, [...SCRIPT_ARGS_PREFIX, pasta_raiz], {
    env: { ...process.env, PYTHONUTF8: '1' },
    windowsHide: true, // evita janela de console piscando ao chamar o analisar_job.exe
  });

  let stdout = '';
  let stderr = '';

  // setEncoding usa um decoder que não corta caractere multibyte no meio.
  python.stdout.setEncoding('utf8');
  python.stderr.setEncoding('utf8');
  python.stdout.on('data', chunk => { stdout += chunk; });
  python.stderr.on('data', chunk => {
    stderr += chunk;
    // repassa o progresso do analisador; o nome do job separa análises simultâneas
    chunk.split(/\r?\n/).filter(l => l.trim()).forEach(l => logger.info(`[analisador ${num_job}] ${l}`));
  });

  let spawnFailed = false;
  python.on('error', err => {
    spawnFailed = true;
    logger.erro(`[spawn] Não foi possível iniciar o analisador (${PYTHON_BIN}): ${err.message}`);
    return res.status(500).json({
      error: 'Não foi possível iniciar o analisador de documentos',
      detalhes: err.message,
    });
  });

  python.on('close', async code => {
    if (spawnFailed) return;
    logger.info(`[analisar] Analisador terminou: job="${num_job}" exit=${code} | duração=${duracao()}`);
    // Parse do JSON retornado pelo script
    // Ignora qualquer linha de warning antes do JSON (ex: warnings do pymupdf)
    let analise;
    try {
      const jsonStart = stdout.indexOf('{');
      if (jsonStart === -1) throw new Error('Nenhum JSON encontrado no stdout');
      const jsonStr = stdout.slice(jsonStart);
      analise = JSON.parse(jsonStr);
    } catch (e) {
      // Não veio JSON válido: aí sim é uma falha "crua" (crash, script não encontrado etc.)
      if (code !== 0) {
        logger.erro(`[analisar] Falhou: job="${num_job}" (exit ${code}) e a saída não é JSON | duração=${duracao()}\n--- stderr (final) ---\n${stderr.slice(-2000)}`);
        return res.status(500).json({
          error: `Análise falhou (exit ${code})`,
          detalhes: stderr.slice(-1000) || stdout.slice(-1000),
        });
      }
      logger.erro(`[analisar] JSON inválido: job="${num_job}": ${stdout.slice(0, 500)}`);
      return res.status(500).json({
        error: 'Resposta do analisador não é JSON válido',
        raw: stdout.slice(0, 500),
      });
    }

    // O script pode sair com código != 0 e ainda assim ter devolvido um JSON
    // de erro amigável (ex.: "Diretório não encontrado"). Nesse caso usamos
    // a mensagem dele em vez de um erro genérico.
    if (analise.erro) {
      logger.erro(`[analisar] Analisador devolveu erro: job="${num_job}": ${analise.erro} | duração=${duracao()}` +
                  (analise.traceback ? `\n--- traceback do Python ---\n${analise.traceback}` : ''));
      return res.status(422).json({ error: analise.erro });
    }
    if (code !== 0) {
      logger.erro(`[analisar] Falhou: job="${num_job}" (exit ${code}) | duração=${duracao()}\n--- stderr (final) ---\n${stderr.slice(-2000)}`);
      return res.status(500).json({
        error: `Análise falhou (exit ${code})`,
        detalhes: stderr.slice(-1000),
      });
    }

    // ── Salva JSON sidecar em data/jobs/ ───────────────────────────────────
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const ts       = new Date().toISOString().replace(/[:.]/g, '-');
      const fname    = `${num_job.replace(/[^\w\-]/g, '_')}_${ts}.json`;
      const filepath = path.join(DATA_DIR, fname);
      fs.writeFileSync(filepath, JSON.stringify(analise, null, 2), 'utf8');
      logger.info(`[analisar] Sidecar salvo: ${filepath}`);
    } catch (e) {
      logger.aviso(`[analisar] Não foi possível salvar sidecar: ${e.message}`);
    }

    // ── Extrai campos do resultado ─────────────────────────────────────────
    const resultados = analise.resultados || [];
    const checklist  = analise.checklist  || [];

    const campo = id => {
      const r = resultados.find(x => x.id === id);
      return r?.valor || null;
    };

    const alertaAtivo = desc => {
      const c = checklist.find(x => x.descricao === desc);
      return c?.alerta ? 1 : 0;
    };

    // ── Insere (ou atualiza) no MySQL ───────────────────────────────────────
    try {
      const pool = getPool();
      const valores = {
        num_job, pasta_raiz,
        contrato_existe:   campo('contrato_existe'),
        procuracao_existe: campo('procuracao_existe'),
        honorarios:        campo('honorarios'),
        gross_up:          campo('gross_up'),
        passivo:           campo('passivo'),
        data_abertura:     campo('data_abertura'),
        simples_nacional:  campo('simples_nacional'),
        socios:            campo('socios'),
        situacao_fiscal:   campo('situacao_fiscal'),
        regularize:        campo('regularize'),
        perfil:            campo('perfil'),
        faturamento:       campo('faturamento'),
        fastpass:          campo('fastpass'),
        supply:            campo('supply'),
        finap:             campo('finap'),
        alerta_sem_contrato:   alertaAtivo('SEM CONTRATO'),
        alerta_sem_procuracao: alertaAtivo('SEM PROCURAÇÃO'),
        alerta_baixo_fat:      0,
        alerta_regularize:     alertaAtivo('COM REGULARIZE'),
        raw_resultado: JSON.stringify(analise),
      };

      await pool.query(
        `INSERT INTO jobs_pro (
          num_job, pasta_raiz,
          contrato_existe, procuracao_existe, honorarios, gross_up, passivo,
          data_abertura, simples_nacional, socios,
          situacao_fiscal, regularize, perfil,
          faturamento, fastpass, supply, finap,
          alerta_sem_contrato, alerta_sem_procuracao, alerta_baixo_fat, alerta_regularize,
          raw_resultado, status_analise, analisado_em
        ) VALUES (
          :num_job, :pasta_raiz,
          :contrato_existe, :procuracao_existe, :honorarios, :gross_up, :passivo,
          :data_abertura, :simples_nacional, :socios,
          :situacao_fiscal, :regularize, :perfil,
          :faturamento, :fastpass, :supply, :finap,
          :alerta_sem_contrato, :alerta_sem_procuracao, :alerta_baixo_fat, :alerta_regularize,
          :raw_resultado, 'ok', NOW()
        )
        ON DUPLICATE KEY UPDATE
          pasta_raiz        = VALUES(pasta_raiz),
          contrato_existe    = VALUES(contrato_existe),
          procuracao_existe  = VALUES(procuracao_existe),
          honorarios         = VALUES(honorarios),
          gross_up           = VALUES(gross_up),
          passivo            = VALUES(passivo),
          data_abertura      = VALUES(data_abertura),
          simples_nacional   = VALUES(simples_nacional),
          socios             = VALUES(socios),
          situacao_fiscal    = VALUES(situacao_fiscal),
          regularize         = VALUES(regularize),
          perfil             = VALUES(perfil),
          faturamento        = VALUES(faturamento),
          fastpass           = VALUES(fastpass),
          supply             = VALUES(supply),
          finap              = VALUES(finap),
          alerta_sem_contrato   = VALUES(alerta_sem_contrato),
          alerta_sem_procuracao = VALUES(alerta_sem_procuracao),
          alerta_baixo_fat      = VALUES(alerta_baixo_fat),
          alerta_regularize     = VALUES(alerta_regularize),
          raw_resultado      = VALUES(raw_resultado),
          status_analise     = 'ok',
          analisado_em       = NOW()
        `,
        valores
      );

      const [rows] = await pool.query('SELECT * FROM jobs_pro WHERE num_job = ?', [num_job]);
      const row = rows[0];
      logger.info(`[analisar] Concluído e salvo: job="${num_job}" id=${row?.id} | duração=${duracao()} ` +
                  `(${analise.resumo?.encontrados ?? '?'}/${analise.resumo?.total ?? '?'} itens encontrados)`);

      res.status(201).json({
        mensagem: 'Análise concluída e salva com sucesso',
        job: row || { num_job, pasta_raiz },
      });
    } catch (dbErr) {
      logger.erro(`[analisar] Erro ao salvar no banco: job="${num_job}" | duração=${duracao()}: ${dbErr.message}`);
      // Retorna o resultado da análise mesmo sem banco
      res.status(207).json({
        mensagem: 'Análise concluída, mas não foi possível salvar no banco',
        erro_banco: dbErr.message,
        analise,
      });
    }
  });
};
