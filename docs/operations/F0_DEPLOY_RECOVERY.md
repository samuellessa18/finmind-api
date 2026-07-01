# F0 — Deploy & Recovery (Operação do Backend FinMind)

Documento técnico de operação. Cobre deploy, rollback, restart, shutdown e health checks
do backend (`finmind-backend`, Render, Node ≥ 20). Escopo: procedimentos operacionais;
não descreve regras de negócio.

> **Fonte de verdade da configuração:** o painel do Render. O `render.yaml` documenta a
> configuração esperada e é usado para recriação (blueprint). Divergência painel×arquivo é
> conferida manualmente.

---

## 1. Deploy

**Gatilho:** push para `main` (Render auto-deploy) ou deploy manual pelo painel.

**Build** (`render.yaml → buildCommand`):
```
npm install
npx prisma generate --schema=./prisma/schema.prisma
npx prisma migrate deploy --schema=./prisma/schema.prisma
```
- `migrate deploy` aplica migrations **forward-only** (não há down-migration).

**Start** (`render.yaml → startCommand`): `node src/server.js` (equivalente a `npm start`).

**Guard de boot (fail-fast):** o processo aborta com `exit(1)` se faltar qualquer variável de
`REQUIRED_ENV` (`src/server.js`): `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV`, `FRONTEND_URL`,
`GOOGLE_CLIENT_ID_WEB`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `PLUGGY_CLIENT_ID`,
`PLUGGY_CLIENT_SECRET`, `PLUGGY_WEBHOOK_SECRET`, `PLUGGY_WEBHOOK_URL`, `ENCRYPTION_KEY`.
Todas estão declaradas no `render.yaml` (valores `sync:false`, definidos no painel).

**Verificação pós-deploy:** aguardar `GET /api/health/live` → `200`. Em seguida, opcionalmente
`GET /api/health/ready` → `200` (confirma conectividade ao banco).

---

## 2. Health Checks

Três endpoints, com propósitos distintos:

| Endpoint | Uso | Consulta banco? | Chama terceiros? | Semântica |
|---|---|---|---|---|
| `GET /api/health/live` | **Probe do Render** (liveness) | Não | **Nunca** | 200 se o processo está vivo |
| `GET /api/health/ready` | Readiness / balanceador | Sim (`SELECT 1`) | **Nunca** | 200 apto · 503 banco indisponível |
| `GET /api/health` | Legado / diagnóstico | Sim | OpenAI (`models.list`) | 200/503; mantido p/ compat |

- O **healthCheckPath do Render é `/api/health/live`** — liveness não depende de banco nem de
  terceiros, evitando reciclagem do container por lentidão de dependência.
- **Readiness nunca chama OpenAI/Anthropic** — prontidão não deve ser refém de terceiros.
- O endpoint legado `/api/health` permanece para compatibilidade (inclui a checagem OpenAI);
  não é usado como probe do Render.

---

## 3. Graceful Shutdown

O Render envia **SIGTERM** em todo deploy/restart/scale-down. O processo trata `SIGTERM` e
`SIGINT` com encerramento gracioso (`gracefulShutdown` em `src/server.js`), **idempotente**:

1. **Para timers/crons** — `cron.getTasks()` → `task.stop()` em todos; `clearTimeout` do warmup do growth.
2. **Drena HTTP** — `httpServer.close()` (para de aceitar novas conexões e aguarda as em voo).
3. **Fecha Prisma** — `prisma.$disconnect()`.
4. **Flush do Sentry** — `flush(2000)` (no-op sem DSN).
5. **`process.exit(0)`**.

**Hard-timeout:** se o drain travar, um timer de **10s** força `exit(1)` para não deixar o
processo pendurado. O heartbeat SSE do chat é per-request, `unref`'d e encerrado no `finally`
do handler — não é recurso de processo e não requer tratamento no shutdown.

> Erros não tratados (`uncaughtException`/`unhandledRejection`) continuam com `exit(1)` após
> captura no Sentry — caminho distinto do shutdown gracioso.

---

## 4. Restart

- **Restart limpo:** disparar redeploy/restart no painel do Render → SIGTERM → shutdown gracioso
  (Seção 3) → novo processo passa pelo guard de boot → `migrate deploy` (idempotente) → `listen`.
- **Cold start (plano free):** a primeira request após ociosidade pode demorar; o probe
  `/api/health/live` tem retry no Render.

---

## 5. Rollback

**Rollback de código:** `git revert <commit>` + redeploy (ou "Rollback" do painel do Render para
um deploy anterior). Seguro e imediato.

**Rollback de schema/migração:** ⚠️ **não há down-migration nem automação.** Estratégia:
1. **Preferir migrações expand/contract** (nunca `DROP`/`ALTER` destrutivo no mesmo deploy) —
   assim o código anterior continua compatível e o rollback é apenas de código.
2. Para migração destrutiva já aplicada, o único caminho é **restore de backup do Postgres**.

**Pré-requisito operacional (PENDENTE — fora do escopo desta F0):** confirmar/documentar backup
automatizado do Postgres (snapshot/PITR) com RPO/RTO definidos **antes** de qualquer migração
destrutiva. Enquanto não confirmado, trate toda migração como irreversível e valide-a
previamente contra um clone dos dados de produção.

**Kill-switch de feature (Consultor IA / chat):** ativação e desligamento são por env, sem deploy —
remover `AI_CHAT_PROVIDER` (ou esvaziar `AI_CHAT_CANARY_USER_IDS`) faz a rota do chat responder
`503` imediatamente, sem consumir cota. É o rollback instantâneo da feature de chat.

---

## 6. Checklist rápido de incidente

- Serviço não sobe → checar logs de boot: provável `REQUIRED_ENV` ausente (guard `exit(1)`).
- `/api/health/live` 200 mas `/api/health/ready` 503 → banco indisponível/instável (não é o processo).
- Deploy derrubou conexões → confirmar que o SIGTERM acionou o shutdown gracioso nos logs
  (`[shutdown] ...`); se aparecer "Timeout de drain", investigar request/cron pendurado.
- Incidente no chat → kill-switch por env (Seção 5), sem deploy.
