# AGENTS.md — guia para uma IA trabalhando neste repositório

Este arquivo existe para orientar uma IA (Claude, Copilot, etc.) a se mover
pelo projeto sem precisar reconstruir o contexto do zero a cada vez. Leia
isto antes de mexer em qualquer coisa.

## O que este projeto faz

É um analisador automático de pastas de documentos fiscais/societários
(contratos, CNPJ, QSA, certidões, faturamento...) de clientes do Studio
Fiscal. Dado o caminho de uma pasta de rede de um cliente (ex.:
`\\studiofiscal\Temporarios\001 - EMPRESA`), o sistema varre a estrutura de
subpastas esperada, extrai texto de PDFs/XLSX (com OCR como fallback para
PDF escaneado), roda uma lista fixa de "elementos de análise" (honorários,
data de abertura, simples nacional, sócios, faturamento médio, etc.) e monta
um checklist de alertas (sem contrato, faturamento baixo, com Regularize...).

O **core de negócio é 100% o script Python** (`services/analisar_job.py`) —
é ele que sabe onde procurar cada documento, como extrair cada dado e quais
são os limiares (R$ 200M/30M/50M; Regularize = dívida PGFN+RFB acima de R$ 600 mil etc.). Tudo o mais
no repo (Node, banco, build) é só **transporte e persistência** do que esse
script já decidiu. Se a tarefa for "mudar uma regra de negócio" (ex.: outro
limiar, outra pasta-alvo, outro padrão de nome de arquivo), o lugar certo é
quase sempre dentro de `ELEMENTOS` / `PROCESSADORES` em `analisar_job.py` —
não no lado Node.

⚠️ O analisador é **somente leitura**: nunca move, renomeia ou apaga
arquivos do cliente. Preserve essa garantia em qualquer mudança.

## Os dois modos de execução (não confunda os dois)

O projeto roda de **duas formas completamente diferentes**, compartilhando
só o analisador Python. Antes de mexer em algo, identifique em qual modo a
mudança se aplica — nem toda mudança vale para os dois.

### Modo API (VM) — `server.js`

Pensado para o time todo usar, com histórico centralizado.

```
PM2 → node server.js (porta 3030, fora do Docker)
         └─ spawn analisar_job.py/.exe por requisição
         └─ MySQL (dentro de um container Docker, só ele)
```

- `server.js` sobe o Express, registra as rotas e inicializa o banco.
- `routes/api.routes.js` → `controllers/job_pro.controller.js`: recebe
  `POST /api/jobs/analisar { pasta_raiz, num_job }`, chama o analisador via
  `child_process.spawn`, parseia o JSON que ele devolve no stdout, grava um
  JSON sidecar em `data/jobs/` e faz upsert na tabela `jobs_pro` do MySQL
  (chave única: `num_job`).
- `db/connection.js` usa **mysql2/promise** com um pool de conexões. A
  conexão é configurada por `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`
  (ver `.env.example`). Toda query no controller é `async/await` — não há
  chamada síncrona de banco neste modo (diferente de versões antigas do
  projeto que usavam SQLite síncrono — se você ver `better-sqlite3` ou
  `.prepare(...).get()/.run()` em algum lugar, é código desatualizado).
- O **MySQL roda em Docker** (`docker-compose.yml`), mas a **API roda fora
  do Docker**, gerenciada por **PM2** (`ecosystem.config.js`). Isso é
  proposital: a API precisa acessar compartilhamentos de rede Windows
  (`\\studiofiscal\...`) com as credenciais do usuário logado na VM, e isso
  não funcionava bem quando a API também estava containerizada.
- Setup inicial da VM: `init_vm.txt` (instala Node/Python/Tesseract/PM2,
  sobe o MySQL, cria `.env`, registra a tarefa agendada). Dia a dia:
  `start.ps1` (idempotente — garante Docker+PM2 no ar).
- Frontend estático em `frontend/index.html`, servido pelo próprio Express
  em `/` — consome `/api/jobs`, `/api/jobs/:id`, `/api/jobs/analisar`.

### Modo Desktop (GUI, Electron) — `desktop-gui/`

Pensado para um usuário rodar sozinho, sem depender de servidor nenhum,
numa **janela gráfica** com a mesma cara do dashboard do Modo API.

```
AnaliseDesktop.exe (Electron)
  └─ main.js sobe um Express LOCAL (loopback 127.0.0.1, porta escolhida
     pelo SO — nunca acessível de fora da máquina) e abre uma BrowserWindow
     carregando esse servidor
        └─ server/app.js     → monta as rotas + serve frontend/index.html
        └─ server/controller.js → spawn analisar_job.py/.exe (mesma lógica
           de detecção do Modo API: usa .exe empacotado se existir ao lado,
           senão cai pra python3 services/analisar_job.py)
        └─ server/jobStore.js → "banco" local em JSON (data/jobs.json, ao
           lado do executável), com upsert por num_job e escrita atômica
           (grava em .tmp e faz rename, pra nunca corromper o arquivo)
```

- `desktop-gui/frontend/index.html` é uma cópia literal de
  `frontend/index.html` (mesmo HTML/CSS/JS do Modo API; confira com `diff`) — é assim que a
  GUI desktop fica visualmente idêntica ao dashboard web. Qualquer mudança
  visual pedida "pros dois modos" precisa ser replicada nos dois arquivos
  (não há compartilhamento de template entre eles hoje).
- Cada instalação tem seu **próprio histórico local** — não há
  sincronização entre máquinas nem com o MySQL do Modo API. Isso é
  intencional: o usuário autorizou explicitamente um "banco" simples em
  arquivo (ver histórico de decisão) em vez de embutir um banco real
  (SQLite) dentro do Electron, para evitar o risco de módulos nativos
  (`better-sqlite3`) compilados pro ABI errado do Electron.
- `desktop-gui/package.json` tem `build:win` = `node build-win.js`, que baixa
  o zip do Electron via `@electron/get`, extrai com o `tar` do Windows,
  renomeia `electron.exe` para `AnaliseDesktop.exe` e monta `resources/app`
  (gera `dist/build/AnaliseDesktop-win32-x64/AnaliseDesktop.exe` + DLLs).
  **Nao use `electron-packager` nem o postinstall do `electron`**: ambos
  extraem com `extract-zip`, que trava em silencio no Node 26 (extrai 1
  arquivo, a promise nunca resolve, exit 0, nenhum .exe gerado).
- `build.ps1` (raiz) orquestra tudo: empacota o Electron (`desktop-gui`),
  empacota `analisar_job.exe` (via PyInstaller, `build/build_python.ps1`),
  baixa/prepara o Tesseract portátil, e monta tudo em
  `dist/AnaliseDesktop/` (uma PASTA — Electron não gera um único `.exe`
  portátil, gera um `.exe` principal + DLLs/recursos ao redor; copiar só o
  `.exe` sem o resto da pasta NÃO funciona).
- **Logs (os DOIS modos desde 2026-10-30)**: `server/logger.js` (singleton) guarda as últimas
  20000 linhas em memória e grava em `data/logs/app.log` ao lado do `.exe`
  (rotaciona em 2 MB). O `controller.js` loga cada análise, cada linha de
  stderr do analisador e — importante — o **traceback do Python**, que não vai
  pra tela do usuário. `app.js` expõe `GET /api/logs?desde=<id>` e
  `POST /api/logs/limpar`, e `frontend/logs.html` é a
  tela (o Modo API serve este mesmo arquivo em `/logs.html`, ver seção abaixo). Fica "escondida": **Ctrl+Shift+L** ou tecla **Alt → Ferramentas → Ver
  logs** (menu montado em `main.js`; a janela de logs é única). `main.js` também
  encaminha pro log: exceções do processo principal, `console.error` da tela e
  falhas de carga. Só escreve em `data/logs` — nunca nas pastas analisadas.
- `desktop-gui/tools/`: `electron-zip.js` (baixa o zip via `@electron/get` e
  extrai com `tar`/`unzip`) e `preparar-dev.js` (roda no `npm start` e garante
  `node_modules/electron/dist`, já que o instalador padrão falha no Node 26).
- Não existe mais `desktop.js` (CLI por terminal) — foi removido e
  substituído por esta GUI Electron, a pedido do usuário ("eu quero uma
  GUI bonitinha, igual essa do print só que para desktop").

### Por que isso importa para uma IA editando o código

- Uma mudança em `analisar_job.py` (ex.: novo campo, nova regra) afeta os
  **dois modos automaticamente**, porque os dois chamam o mesmo script/exe.
  Não precisa duplicar lógica.
- Uma mudança em `controllers/job_pro.controller.js` ou no schema do MySQL
  **só afeta o Modo API** — o Modo Desktop nem importa esses arquivos.
- Uma mudança em `desktop-gui/server/controller.js` ou `jobStore.js` **só
  afeta o Modo Desktop**.
- Uma mudança visual no dashboard pedida de forma genérica ("muda a cor do
  topbar") provavelmente precisa ser replicada em `frontend/index.html`
  (Modo API) **e** `desktop-gui/frontend/index.html` (Modo Desktop) — pare
  e pergunte/confirme qual(is) modo(s) é(são) o alvo antes de editar só um.
- Se pedirem "salvar em outro lugar" ou "mudar o formato de saída", pergunte
  (ou confira pelo contexto) qual dos dois modos é o alvo — API grava no
  MySQL + JSON sidecar, Desktop grava em `data/jobs.json` local.

## Fluxo de dados ponta a ponta (Modo API)

1. Cliente faz `POST /api/jobs/analisar` com `{ pasta_raiz, num_job }`.
2. Controller dá `spawn` no analisador, passando `pasta_raiz` como argumento.
3. `analisar_job.py` varre a pasta, roda cada elemento de `ELEMENTOS` em
   sequência (cada um com seu "tipo" → função em `PROCESSADORES`), monta o
   checklist de alertas, e imprime **um único JSON no stdout** (logs de
   progresso vão para stderr, de propósito, para não poluir o JSON).
4. Controller faz parse do stdout a partir do primeiro `{` (ignora qualquer
   warning de lib Python que vaze antes), salva esse JSON cru em
   `data/jobs/<num_job>_<timestamp>.json` (sidecar, útil para debug/auditoria
   mesmo que o banco falhe) e extrai os campos relevantes pra fazer upsert em
   `jobs_pro` (chave única `num_job`).
5. Frontend consulta `GET /api/jobs` (lista) e `GET /api/jobs/:id` (detalhe,
   inclui `raw_resultado` — o JSON completo salvo como texto).

No Modo Desktop os passos 1–3 são os mesmos (a GUI Electron faz o mesmo
`POST /api/jobs/analisar` contra o próprio servidor Express local, em vez
de um servidor remoto), mas o passo 4 vira "faz upsert em `data/jobs.json`
local, por `num_job`, com `raw_resultado` guardado como objeto (não
string)" — sem MySQL, sem rede.

## Convenções e pontos de atenção

- **Encoding da saída do analisador**: `analisar_job.py` faz
  `sys.stdout/stderr.reconfigure(encoding="utf-8")` logo no início. Não troque
  isso por variável de ambiente: o `.exe` do PyInstaller **ignora**
  `PYTHONUTF8`/`PYTHONIOENCODING`, e no Windows o pipe cai em cp1252, o que
  gerava `'charmap' codec can't encode character '\u2265'` (o "≥" de
  "Perfil Fastpass (> R$ 200M)" sai em toda análise).
- **Regra do Regularize** (`_proc_regularize`): só olha o documento de
  capacidade de pagamento (PGFN). Dívida PGFN+RFB **> R$ 600.000** = dentro
  ("SIM — dentro do Regularize"); senão fora ("Não — fora ..."). A classificação
  A/B/C/D **não entra na regra** (só aparece em `dados.classificacao_documento`).
  O detalhe do job mostra o JSON do documento (`resultados[id=regularize]`).

- **Texto sem acentuação nos `.ps1`** é proposital (evita erro de encoding
  no PowerShell de VMs Windows). Não "corrija" para incluir acentos.
- `caminhoAnalisadorPadrao()`/`usaScriptPy()` aparecem duplicados (com a
  mesma lógica) em `controllers/job_pro.controller.js` e em
  `desktop-gui/server/controller.js`, porque cada um resolve o caminho do
  `analisar_job.exe` em relação ao **seu próprio** `baseDir`. Isso é
  intencional — não vale a pena abstrair para um módulo compartilhado sem
  avaliar como fica o empacotamento (um é `pkg`, o outro é
  `electron-packager`, com convenções de pasta diferentes).
- `process.pkg` é a forma de detectar "estou rodando empacotado (`pkg`) ou
  via `node arquivo.js`" — só vale para o Modo API, se algum dia ele for
  empacotado assim. **Não use `process.pkg` dentro de `desktop-gui/`**:
  Electron não usa `pkg`, a checagem correta lá é `app.isPackaged` (ver
  `desktop-gui/main.js`), que já resolve o `baseDir` certo e injeta via
  `createApp({ baseDir, ... })`/`createController({ baseDir, ... })` —
  essas duas funções são fábricas justamente para receber esse `baseDir`
  de fora e ficarem testáveis com Node puro, sem precisar do Electron de
  verdade rodando.
- O schema (`migrations/001_init.sql`) é **MySQL**, não SQLite — usa
  `AUTO_INCREMENT`, `ON UPDATE CURRENT_TIMESTAMP`, `UNIQUE KEY`, etc.
  `db/connection.js` roda esse arquivo inteiro contra o MySQL na
  inicialização (idempotente via `IF NOT EXISTS`), e depois confere/adiciona
  colunas novas que não existiam (`supply`, `finap`) via
  `INFORMATION_SCHEMA.COLUMNS` — é o jeito do projeto evoluir o schema sem
  migrations numeradas de verdade. Se adicionar uma coluna nova, siga esse
  padrão (adicione ao `CREATE TABLE` E à checagem de colunas novas).
- `.env` nunca é commitado (`.gitignore`); `.env.example` é a fonte da
  verdade de quais variáveis existem — mantenha os dois em sincronia.
- Pastas geradas (`dist/`, `data/`, `logs/`, `node_modules/`,
  `build/.venv-build/`, artefatos do PyInstaller) são todas ignoradas —
  não assuma que existem no checkout limpo.

## Onde cada coisa fica

```
server.js                           Modo API — bootstrap do Express
desktop-gui/main.js                 Modo Desktop — processo principal do Electron
desktop-gui/server/app.js           Modo Desktop — fábrica do Express local
desktop-gui/server/controller.js    Modo Desktop — orquestra spawn + jobStore
desktop-gui/server/jobStore.js      Modo Desktop — "banco" local em data/jobs.json
desktop-gui/server/logger.js        Os DOIS modos — log em memória + data/logs/app.log
desktop-gui/frontend/index.html     Modo Desktop — UI (cópia do frontend/index.html)
desktop-gui/frontend/logs.html      Os DOIS modos — tela de logs (Ctrl+Shift+L)
desktop-gui/build-win.js            Modo Desktop — gera AnaliseDesktop.exe (sem electron-packager)
desktop-gui/tools/                  Modo Desktop — baixa/extrai o Electron (npm start e build)
desktop-gui/package.json            Modo Desktop — deps + scripts start / build:win
routes/api.routes.js                Modo API — rotas HTTP
controllers/job_pro.controller.js   Modo API — orquestra spawn + MySQL
db/connection.js                    Modo API — pool mysql2/promise
migrations/001_init.sql             Modo API — schema MySQL da tabela jobs_pro
services/analisar_job.py            Os DOIS modos — todo o core de negócio
services/ler_jobs.py                CLI auxiliar p/ inspecionar data/jobs/*.json
frontend/index.html                 Modo API — UI estática servida pelo Express
docker-compose.yml                  Modo API — sobe só o MySQL
ecosystem.config.js                 Modo API — config do PM2
.env.example                        Modo API — variáveis de conexão MySQL + PORT
init_vm.txt                         Modo API — setup inicial da VM
instalar-vm.ps1 / start.ps1         Modo API — firewall, tarefa agendada, start
build.ps1                           Modo Desktop — empacota Electron + analisar_job.exe + Tesseract
build/build_python.ps1              Os DOIS modos — empacota só o analisador Python
requirements.txt                    Os DOIS modos — deps Python do analisador
```

## Perguntas que vale fazer antes de implementar algo

- A mudança é uma **regra de negócio da análise** (o que extrair, de onde,
  quais limiares)? → mexe em `services/analisar_job.py`, afeta os dois modos.
- É sobre **como o resultado é entregue/guardado**? → identifique o modo
  (API → `controller`/MySQL; Desktop → `desktop-gui/server/controller.js`/
  `data/jobs.json`) antes de editar.
- É sobre **infraestrutura/deploy**? → confirme se é VM (Docker+PM2) ou
  pacote desktop (Electron+PyInstaller) — as duas trilhas de build
  (`build.ps1` vs `init_vm.txt`) não se misturam.
- É uma **mudança visual** (cor, layout, texto da tela)? → ela normalmente
  precisa ir em `frontend/index.html` E `desktop-gui/frontend/index.html`
  juntos, pra não deixar os dois modos com dashboards diferentes.

## Regras vigentes da análise (2026-10-27)

Esta seção é a referência funcional exibida também no painel em Regras da análise.

- Somente leitura dos documentos de origem. Nenhum arquivo de cliente pode ser criado, alterado, movido ou apagado. Resultados e logs são gravados exclusivamente na área da aplicação.
- Contrato: existência de PDF em A - Contrato/1 - Contrato Studio **com "contrato" no nome do arquivo** (sem diferenciar maiúsculas/acentos; desde 2026-11-05 — acordo de confidencialidade e outros PDFs da pasta não contam); não valida assinatura. Procuração: em branco, definida pelo Project.
- Honorários: cláusula 5.1; ignora gross up e 14,25%. Fallback próximo de honorários/remuneração exige conferência. Gross up: expressão gross up ou 14,25%. Passivo: menção textual, sem interpretação de negação.
- Perfil Family: examina PDF/TXT/XLSX em B - Documentos/2 - Fiscal, a pasta do Regularize. Extrai nomes e CPF/CNPJ identificados na seção de sócios dos relatórios fiscais; mantém arquivo e trecho por vínculo. CPF/CNPJ avulso não comprova vínculo nem parentesco. Layout não reconhecido fica sem dado.
- CNPJ: extrai data de abertura e CNAE principal do bloco da matriz; exige indicação explícita MATRIZ; nunca usa filial nem presume matriz pelo sufixo /0001. Se o cartão não for reconhecido, aceita a seção Dados Cadastrais da Matriz do relatório fiscal. CNAE pode ser extraído mesmo sem data.
- Simples Nacional: informa situação atual e anos documentados por intervalos de opção encontrados, sem inferir histórico da situação atual. Histórico não reconhecido é explicitamente informado. Não consulta sistemas externos.
- Perfil Transação: documento de capacidade de pagamento em B - Documentos/2 - Fiscal. Dívida PGFN+RFB > R$ 600.000. Igual ao limite fica fora. Classificação A/B/C/D e contencioso não alteram a regra; contencioso não é somado. Sem cadastro exige evidência textual.
- Perfil Previdenciário: arquivos com perfil no nome em B - Documentos/6 - Cruzamentos. Qualquer ano marcado ACIMA indica perfil; lê o veredito do documento, sem recalcular limite.
- Faturamento: examina todos os TXT/PDF/XLSX em B - Documentos/1 - Contábil/5 - ECF, sem exigir FATURAMENTO no nome. Extrai totais anuais reconhecíveis. Exibe todos os anos, inclusive o corrente. Média aritmética apenas de anos anteriores ao ano corrente; em 2026, usa até 2025. Nunca soma anos para classificar. Anos não identificados não entram. Valores diferentes para um mesmo ano fechado deixam a média inconclusiva; valores iguais repetidos não duplicam o ano. Todos os valores observados e arquivos ficam nas evidências.
- Perfil Fastpass: média dos anos fechados > R$ 200 milhões. Todos os demais casos são inconclusivos, inclusive igualdade e ausência de dados.
- Perfil Supply: média dos anos fechados >= R$ 30 milhões. Sem média: inconclusivo.
- Perfil Finap - Lei do Bem: média dos anos fechados > R$ 50 milhões E CNAE principal na lista explícita de 296 CNAEs da planilha cnae Finep (2).xlsx. Igualdade não qualifica. Sem CNAE: verificar. A lista CNAES_FINAP em services/analisar_job.py é a fonte editável e acompanha o executável, sem dependência da planilha em produção. Alterações exigem novo build do analisador empacotado.
- Detalhes mostram dados extraídos; evidências mostram caminhos de origem, trechos e valores. Ausência de dado não significa negativa. A maioria dos campos usa o primeiro documento reconhecido; não há escolha automática pelo mais recente. OCR pode falhar e requer conferência.
- Checklist: sem contrato e com Perfil Transação. Fastpass inconclusivo não gera reprovação de faturamento baixo.

- Tags do relatório: azul = encontrado; laranja = não encontrado. Classificação separada: verde = é perfil; vermelho = não é perfil; laranja = inconclusivo. Perfil Family: todos os sócios identificados com CPF = é perfil; ao menos um sócio CNPJ = não é perfil. Sem sócios com CPF/CNPJ identificados = inconclusivo. A classificação comercial não infere parentesco.

## Robustez validada com documentos (2026-10-27)

- Pastas comparadas por componentes inteiros, em ordem, ignorando acentos e caixa. Evita confundir 2 - Fiscal com 12 - Fiscal.
- PDFs mistos: extração e OCR por página sem texto, preservando número da página. OCR usa arquivos temporários fora da origem, timeout e fallback de idioma. Falha de leitura não significa resposta negativa. Cache invalidado por tamanho e data de modificação.
- Matriz: indicação explícita no conteúdo, datas válidas não futuras, CNAE principal sem confundir com secundários. Documentos de matriz divergentes tornam o resultado inconclusivo. Fonte alternativa é somente a seção cadastral explicitamente da matriz no relatório fiscal.
- Sócios: leitura limitada à seção societária, encerrada antes de Certidão Emitida e Diagnóstico Fiscal. CPF/CNPJ do certificado, contribuinte e responsáveis fora da seção não são sócios. Cargo e situação cadastral não compõem o nome. Não infere parentesco.
- Simples: períodos de opção separados de SIMEI, consulta/emissão e eventos futuros. Ausência explícita de períodos anteriores é evidência; ausência de informação não prova que nunca foi optante.
- Perfil Previdenciário: XLSX lido por cabeçalhos ANO/MÉDIA/STATUS; nunca confundir SOMA VALOR ORIGINAL com MÉDIA. Relatorio_MEDIA de arrecadação não produz perfil nem faturamento. Vereditos divergentes por ano são inconclusivos; texto solto genérico não decide perfil.
- PGFN: compara documentos de capacidade de pagamento; totais divergentes deixam Perfil Transação inconclusivo. Quando CNPJ matriz está identificado, documento com CPF/CNPJ de outro contribuinte é descartado. Não inclui contencioso nem soma tabelas fiscais.
- Faturamento: XLSX exige coluna anual de receita/faturamento identificada; DARF, arrecadação, DCTF e médias de tributos são descartados. Não presume ano a partir de datas soltas de emissão nem de nome com anos ambíguos. Texto explicitamente mensal não vira total anual.
- Testes sintéticos versionados não contêm os documentos privados enviados. Conferência adicional local com os arquivos reais verifica valores esperados e hashes SHA-256 inalterados das origens. OCR/novos layouts ainda podem exigir conferência humana; não há garantia de erro zero.

- Exclusão antecipada: qualquer arquivo cujo nome contenha filial (sem diferenciar maiúsculas/minúsculas) é ignorado antes de abertura, extração de texto e OCR, em todos os perfis e nos dois modos.

## Faturamento consolidado e SPED (2026-10-28)

- Na pasta B - Documentos/1 - Contábil/5 - ECF, ignora arquivos com SPED no nome antes de abrir, independentemente de caixa. Não exige FATURAMENTO no nome: consolidado e outros nomes são candidatos. Preserva exclusão global de filial.
- A menção a arquivos SPED dentro do texto de um consolidado é evidência, não motivo para descartar o consolidado. Não abre os arquivos citados.
- Consolidados com vários blocos ANO: associam cada ano ao TOTAL DO ARQUIVO ou TOTAL DO ANO PIS/COFINS daquele bloco. Não usam TOTAL CONSOLIDADO, FAT MEDIO ou a média previamente calculada no arquivo.
- Exibe todos os anos extraídos; calcula de novo a média aritmética dos anos anteriores ao ano corrente. Em 2026, mostra 2026 mas exclui esse ano da média. Mantém proteção contra valores divergentes para o mesmo ano fechado.
- Encontrado para faturamento exige pelo menos um valor anual extraído no resultado; existência de arquivo sem valores nunca gera tag azul. Um total anual zero é um valor válido. Reanalisar jobs antigos para atualizar resultados salvos.

## Seleção e fila de jobs (2026-10-28)

- API e Desktop usam `desktop-gui/server/jobQueue.js`, incluído pelo build Desktop ao copiar server/.
- GET /api/pastas?relative= lista somente diretórios; realpath e contenção na raiz bloqueiam travessia e links para fora. Não há operações de escrita na origem.
- JOBS_ROOT configura a raiz (padrão \\studiofiscal\Temporarios); JOBS_CONCURRENCY define 1–4 análises simultâneas, padrão 2. No Desktop definir as variáveis no ambiente do aplicativo.
- POST /api/fila recebe jobs [{relative}] ou [{pasta_raiz}] dentro da raiz e retorna 202. O nome do job vem da pasta. GET /api/fila acompanha status fila/processando/concluido/erro. Pastas ativas não duplicam. Falhas individuais não interrompem a fila; falha de persistência é erro.
- Fila em memória do processo, histórico limitado a 1000 itens; reinício perde pendências. Resultados continuam persistidos pelos controllers habituais. Usar um único processo API (sem cluster PM2). Desktop precisa permanecer aberto.
- A interface usa fila tanto para seleção múltipla quanto entrada manual. O endpoint legado /api/jobs/analisar permanece síncrono para compatibilidade com integrações.

## Logs do servidor e filtros do painel (2026-10-30)

- Logs nos dois modos: `server.js` (API) e `desktop-gui/main.js` inicializam o mesmo `desktop-gui/server/logger.js`. Modo API grava em `data/logs/app.log` ao lado do projeto (ignorado pelo git); Desktop, ao lado do `.exe`. Só a pasta da aplicação recebe escrita, nunca as pastas analisadas.
- Tela escondida: **Ctrl+Shift+L** no dashboard (ou o link quase invisível "logs" no canto inferior direito) abre `/logs.html`. No Modo API o Express serve o arquivo `desktop-gui/frontend/logs.html` e expõe `GET /api/logs?desde=<id>` e `POST /api/logs/limpar`, como no Desktop. Não há autenticação: quem acessa a API acessa os logs.
- Cada análise registra `Iniciando`, `Analisador terminou` e `Concluído e salvo` (ou `Falhou`) com `duração=` (ex.: `20 min 03 s`), em ambos os controllers. As linhas do analisador levam o prefixo `[analisador <num_job>]` para separar análises simultâneas. Opção "Resumo dos jobs" da tela mostra só as linhas `[analisar]` (início, fim e duração).
- `uncaughtException`/`unhandledRejection` no Modo API são logadas e o processo encerra (PM2 reinicia), preservando o comportamento anterior.
- Cards do dashboard (`frontend/index.html` e `desktop-gui/frontend/index.html`, sempre idênticos) são clicáveis e filtram a tabela: Jobs Analisados (todos), Com Alertas, Perfil Fastpass e Perfil Previdenciário (`perfil` começando com "É PERFIL"). O mesmo teste (`FILTROS` no script) conta o card e filtra a lista, e combina com a busca por texto. Clicar de novo no card ativo, ou no chip do filtro, volta a mostrar todos. Para criar outro filtro: nova entrada em `FILTROS` e um `.stat-cell[data-filtro]`.
- Nenhuma regra de negócio da análise foi alterada nesta mudança.

## Excluir job do histórico (2026-11-05)

- Botão **🗑 Excluir** no cabeçalho do detalhe do job (`frontend/index.html` e `desktop-gui/frontend/index.html`, sempre idênticos), com `confirm()` antes. Chama `DELETE /api/jobs/:id`.
- Modo API: `controllers/job_pro.controller.js` (`excluirJob`, `DELETE FROM jobs_pro WHERE id = ?`). Modo Desktop: `desktop-gui/server/controller.js` + `jobStore.remover(id)`. 404 se o job não existe.
- Remove só o registro do histórico. Nunca toca nas pastas analisadas (somente leitura) nem nos JSONs sidecar de `data/jobs/`. Reanalisar a pasta recria o job (upsert por `num_job`).
- Não há autenticação: quem acessa a API pode excluir. Testes em `tests/test_excluir_job.js`.
- Checklist do detalhe do job sem cores (2026-11-05): **COM CONTRATO** e **COM REGULARIZE** mostram ☑ + SIM em destaque quando verdadeiro e ☐ + NÃO em cinza quando falso; o cabeçalho é neutro.
