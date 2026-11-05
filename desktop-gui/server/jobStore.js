// jobStore.js — "banco de dados" simples: um arquivo JSON local.
// ══════════════════════════════════════════════════════════════════════════
// Sem servidor, sem módulo nativo compilado (evita todo o problema de ABI
// do Electron com libs como better-sqlite3/sqlite3). Guarda um array de
// jobs em jobs.json, lido/escrito inteiro a cada operação — mais do que
// suficiente para o volume desta aplicação (dezenas/centenas de jobs).
//
// Cada processo (Electron) acessa SEMPRE o mesmo arquivo nesta mesma
// instância, então não há concorrência real de múltiplos processos
// escrevendo ao mesmo tempo — só precisamos ser atômicos o bastante pra não
// corromper o arquivo se o app fechar no meio de uma escrita.

const fs = require('fs');
const path = require('path');

let dbPath = null;

function init(filePath) {
  dbPath = filePath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ nextId: 1, jobs: [] }, null, 2), 'utf8');
  }
}

function _ler() {
  if (!dbPath) throw new Error('jobStore.init() não foi chamado ainda');
  try {
    const raw = fs.readFileSync(dbPath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.jobs)) data.jobs = [];
    if (typeof data.nextId !== 'number') data.nextId = data.jobs.length + 1;
    return data;
  } catch (e) {
    // Arquivo ausente, vazio ou corrompido: começa do zero (não derruba o app).
    console.warn('[jobStore] Não foi possível ler o banco, iniciando vazio:', e.message);
    return { nextId: 1, jobs: [] };
  }
}

function _escrever(data) {
  // Escreve em arquivo temporário e troca (rename é atômico na maioria dos
  // sistemas de arquivos) — evita corromper jobs.json se o processo morrer
  // no meio da escrita.
  const tmp = dbPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, dbPath);
}

function listar() {
  const { jobs } = _ler();
  // Mais recente primeiro (mesma ordenação que o SQL original: analisado_em DESC)
  return [...jobs].sort((a, b) => (b.analisado_em || '').localeCompare(a.analisado_em || ''));
}

function obterPorId(id) {
  const { jobs } = _ler();
  return jobs.find(j => String(j.id) === String(id)) || null;
}

// Insere ou atualiza (upsert) por num_job — mesma semântica do ON DUPLICATE
// KEY UPDATE / ON CONFLICT das versões anteriores.
function upsert(campos) {
  const data = _ler();
  const agora = new Date().toISOString();
  const idx = data.jobs.findIndex(j => j.num_job === campos.num_job);

  if (idx === -1) {
    const novo = {
      id: data.nextId++,
      ...campos,
      status_analise: 'ok',
      analisado_em: agora,
      created_at: agora,
      updated_at: agora,
    };
    data.jobs.push(novo);
    _escrever(data);
    return novo;
  }

  const existente = data.jobs[idx];
  const atualizado = {
    ...existente,
    ...campos,
    status_analise: 'ok',
    analisado_em: agora,
    updated_at: agora,
  };
  data.jobs[idx] = atualizado;
  _escrever(data);
  return atualizado;
}

// Remove um job do histórico local. Devolve o job removido (ou null se não existe).
function remover(id) {
  const data = _ler();
  const idx = data.jobs.findIndex(j => String(j.id) === String(id));
  if (idx === -1) return null;
  const [removido] = data.jobs.splice(idx, 1);
  _escrever(data);
  return removido;
}

module.exports = { init, listar, obterPorId, upsert, remover };
