# API Análises — Studio Fiscal

API que analisa pastas de documentos (contratos, CNPJ, QSA, faturamento etc.)
e expõe os resultados via HTTP + um frontend simples. Node/Express na frente,
um script Python por trás (extração de PDF/XLSX/OCR).

Dois jeitos totalmente diferentes de usar o projeto — veja qual é o seu caso:

| | Modo API (VM) | Modo Desktop (app com GUI) |
|---|---|---|
| Para quem | Time todo, multiusuário, histórico centralizado | Uma pessoa, análise avulsa, sem servidor |
| Onde roda | Numa VM, sempre ligada | No PC de qualquer usuário |
| Banco de dados | MySQL (em Docker) | Arquivo local (`data/jobs.json`), um por máquina |
| Resultado | Fica salvo no banco + JSON em `data/jobs/`, consultado pelo frontend/API | Mostrado numa janela gráfica (mesmo dashboard do Modo API), histórico só nessa máquina |
| Como sobe | `init_vm.txt` (uma vez) + PM2 | `.\build.ps1` gera um pacote (pasta) portátil com app Electron |

## Modo 1 — API na VM (produção, multiusuário)

Arquitetura:

```
┌─────────────── VM Windows ───────────────┐
│                                           │
│  PM2 ──► node server.js  (porta 3030)    │
│              │                            │
│              ├─► spawn analisar_job.py/.exe
│              │     (lê \\studiofiscal\...)│
│              │                            │
│              └─► MySQL ◄── Docker Compose │
│                   (127.0.0.1:3306)        │
└───────────────────────────────────────────┘
```

A API roda **fora** do Docker, gerenciada pelo PM2 — só o MySQL fica em
container. Isso é proposital: quando a API também rodava em container, ela
não conseguia acessar os compartilhamentos de rede (`\\studiofiscal\...`)
direito.

**Setup (uma vez, numa VM Windows nova, com Docker Desktop já instalado):**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (Get-Content .\init_vm.txt -Raw)"
```

Isso instala Node, Python, Tesseract e PM2; sobe o MySQL via
`docker compose up -d`; cria o `.env`; e registra a API para iniciar sozinha
(via PM2) no logon, liberando a porta 3030 no firewall.

**Dia a dia:**

```powershell
.\start.ps1          # garante que MySQL (Docker) + API (PM2) estão no ar
pm2 logs api-analises  # acompanhar logs
pm2 status              # ver se está no ar
pm2 restart ecosystem.config.js   # reiniciar depois de um git pull
```

Acesse `http://localhost:3030` (ou `http://IP-DA-VM:3030` de outra máquina
na rede).

**Logs do servidor:** no dashboard, **Ctrl+Shift+L** (ou o link discreto "logs" no
canto inferior direito) abre `/logs.html`, com timestamps, filtro por nível/texto e a
duração de cada análise (opção "Resumo dos jobs"). Os logs também ficam em
`data/logs/app.log` (rotaciona em 2 MB) e continuam saindo em `pm2 logs api-analises`.

## Modo 2 — App Desktop (uso individual, sem servidor)

Sem API remota, sem MySQL. É um app desktop de verdade (Electron), com uma
janela gráfica — **igual ao dashboard do Modo API** — onde o usuário
informa o número do job e o caminho da pasta de rede (ex.:
`\\studiofiscal\Temporarios\001`), acompanha a lista de jobs já analisados
e abre o detalhe de cada um. Por baixo dos panos, o app sobe um servidor
local (só essa máquina acessa) e guarda o histórico num arquivo JSON local
(`data\jobs.json`, ao lado do executável) — cada máquina/usuário tem o seu
próprio, sem depender de rede ou de outro servidor.

**Gerar o pacote** (numa máquina de build Windows, com Node.js e Python
instalados — a própria VM preparada pelo `init_vm.txt` serve, Docker não é
necessário para isso):

```powershell
.\build.ps1
```

Isso gera `dist\AnaliseDesktop\` com:

- `AnaliseDesktop.exe` + DLLs/recursos do Electron — a janela gráfica do app
- `analisar_job.exe` — o analisador Python empacotado (via `PyInstaller`)
- `tesseract\` — OCR portátil, sem instalador
- `LEIA-ME.txt` — instruções para quem só vai *usar* o pacote

**Copie a pasta `dist\AnaliseDesktop\` inteira** (ou o
`dist\AnaliseDesktop.zip`) para a máquina de destino, e dê dois cliques em
`AnaliseDesktop.exe`. Nada mais precisa estar instalado lá — mas note que
é um app de **pasta**, não um `.exe` único e solto: Electron sempre vem
com um conjunto de DLLs/recursos ao lado do executável principal, então
não dá pra copiar só o `.exe`.

> Detalhe técnico: o `build.ps1` precisa rodar no Windows porque o
> PyInstaller não compila cruzado (um `.exe` Windows só sai rodando em
> Windows). O empacotamento do Electron (`electron-packager`) também
> poderia cross-compilar de Linux/Mac, mas como o `build.ps1` já roda tudo
> numa única passada no Windows, mantemos os dois passos juntos ali.

**Rodar sem empacotar (dev):** precisa de Python com as deps de
`requirements.txt` (`pip install -r requirements.txt`) e Node.js.

```powershell
cd desktop-gui
npm install
npm start
```

**Logs / erros:** dentro do app, **Ctrl+Shift+L** (ou tecla **Alt** →
*Ferramentas* → *Ver logs*) abre a tela de logs, com filtro por nível, busca e
botão "Copiar tudo". O mesmo log fica em `data\logs\app.log`, ao lado do
`AnaliseDesktop.exe` (ou em `desktop-gui\data\logs` no modo dev).

**Regra do Regularize:** só o documento de capacidade de pagamento (PGFN) é
analisado; dívida PGFN+RFB acima de R$ 600 mil = dentro, senão fora. O detalhe
do job mostra o JSON extraído do documento.

## Estrutura

```
server.js                          servidor Express (Modo API)
desktop-gui/                       app desktop com GUI (Electron) — Modo Desktop
desktop-gui/main.js                 processo principal do Electron (sobe o Express local)
desktop-gui/server/app.js           fábrica do Express local (rotas + frontend)
desktop-gui/server/controller.js    lógica das rotas + chama o analisador
desktop-gui/server/jobStore.js      "banco" local em data/jobs.json (JSON, upsert por num_job)
desktop-gui/frontend/index.html     UI (cópia do frontend/index.html, mesmo visual)
routes/api.routes.js          rotas HTTP
controllers/job_pro.controller.js   lógica das rotas + chama o analisador
db/connection.js              conexão MySQL (mysql2) — usada só no Modo API
migrations/001_init.sql       schema da tabela jobs_pro (MySQL)
services/analisar_job.py      analisador (chamado como subprocess ou .exe) — usado pelos dois modos
services/ler_jobs.py          CLI auxiliar p/ inspecionar os JSONs em data/jobs/
frontend/index.html           UI estática do Modo API
docker-compose.yml            sobe só o MySQL (Modo API)
ecosystem.config.js           config do PM2 (Modo API)
build.ps1                     gera o pacote desktop autocontido (Modo Desktop)
build/build_python.ps1        empacota só o lado Python (usado pelos dois modos)
init_vm.txt                   setup inicial da VM (Modo API)
instalar-vm.ps1 / start.ps1   firewall, tarefa agendada e start do dia a dia (Modo API)
```

## API (Modo 1)

- `GET  /health` — status da API + banco
- `GET  /api/jobs` — lista todos os jobs analisados
- `GET  /api/jobs/:id` — detalhes de um job (inclui resultado bruto)
- `DELETE /api/jobs/:id` — exclui um job do histórico (só o registro; pastas analisadas e `data/jobs/*.json` não são tocados)
- `POST /api/jobs/analisar` — dispara uma análise
  — body: `{ "pasta_raiz": "...", "num_job": "..." }`
- `GET  /api/logs?desde=<id>` — linhas de log novas (alimenta `/logs.html`)
- `POST /api/logs/limpar` — limpa só a tela de logs (o arquivo em disco é mantido)
