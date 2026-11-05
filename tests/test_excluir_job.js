const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const resposta = () => { const r = { code: 200 }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; return r; };

test('jobStore.remover: remove só o job pedido e devolve null se não existe', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'js-'));
  try {
    const store = require('../desktop-gui/server/jobStore');
    store.init(path.join(tmp, 'jobs.json'));
    const a = store.upsert({ num_job: 'A', pasta_raiz: 'x' });
    const b = store.upsert({ num_job: 'B', pasta_raiz: 'y' });
    assert.equal(store.remover(a.id).num_job, 'A');
    assert.deepEqual(store.listar().map(j => j.num_job), ['B']);
    assert.equal(store.remover(a.id), null);          // já removido
    assert.equal(store.remover(999), null);           // inexistente
    assert.equal(store.obterPorId(b.id).num_job, 'B');
    // reanalisar recria o job (upsert por num_job)
    assert.equal(store.upsert({ num_job: 'A', pasta_raiz: 'x' }).num_job, 'A');
    assert.equal(store.listar().length, 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Desktop: DELETE /api/jobs/:id via Express (200, depois 404) sem tocar na pasta analisada', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'));
  const cliente = path.join(tmp, 'cliente'); fs.mkdirSync(cliente);
  fs.writeFileSync(path.join(cliente, 'doc.txt'), 'original');
  const { createApp } = require('../desktop-gui/server/app');
  const store = require('../desktop-gui/server/jobStore');
  const app = createApp({ baseDir: tmp, pyScriptPath: 'x.py', dbFile: path.join(tmp, 'data', 'jobs.json'), frontendDir: tmp });
  const job = store.upsert({ num_job: 'CLI', pasta_raiz: cliente });
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    let r = await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).num_job, 'CLI');
    assert.equal((await (await fetch(`${base}/api/jobs`)).json()).total, 0);
    r = await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE' });
    assert.equal(r.status, 404);
    assert.equal(fs.readFileSync(path.join(cliente, 'doc.txt'), 'utf8'), 'original');
  } finally { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('API: excluirJob apaga por id (200), 404 se não existe, 500 em erro de banco', async () => {
  const conexao = require.resolve('../db/connection');
  const chamadas = [];
  let linhas = [{ id: 7, num_job: 'X' }], falhar = false;
  require.cache[conexao] = { id: conexao, filename: conexao, loaded: true, exports: {
    getPool: () => ({ query: async (sql, args) => { chamadas.push([sql, args]); if (falhar) throw new Error('db fora'); return [sql.startsWith('SELECT') ? linhas : { affectedRows: 1 }]; } }),
    iniciarDB: async () => {},
  } };
  delete require.cache[require.resolve('../controllers/job_pro.controller')];
  const ctrl = require('../controllers/job_pro.controller');

  let res = resposta(); await ctrl.excluirJob({ params: { id: '7' } }, res);
  assert.equal(res.code, 200); assert.equal(res.body.num_job, 'X');
  assert.ok(chamadas.some(([s, a]) => s.startsWith('DELETE FROM jobs_pro WHERE id') && a[0] === 7));

  linhas = []; chamadas.length = 0; res = resposta(); await ctrl.excluirJob({ params: { id: '8' } }, res);
  assert.equal(res.code, 404); assert.ok(!chamadas.some(([s]) => s.startsWith('DELETE')));

  falhar = true; res = resposta(); await ctrl.excluirJob({ params: { id: '7' } }, res);
  assert.equal(res.code, 500);
  delete require.cache[conexao];
});
