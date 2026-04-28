# 🚀 Deploy - FinMind Backend no Render

## ✅ Checklist Pré-Deployment

- [x] `server.js` movido para `src/server.js`
- [x] Imports corrigidos (sem `/src/src`)
- [x] `package.json` com `start: node src/server.js`
- [x] `render.yaml` com `startCommand: node src/server.js`
- [x] Health check endpoint funcionando (`/api/health`)
- [x] Error handlers para production (uncaughtException, unhandledRejection)
- [x] Logs iniciais para debug
- [x] Database SSL mode configurado

## 🔧 Configuração no Render

### 1. Build Command
```
npm install && npx prisma generate && npx prisma migrate deploy
```

### 2. Start Command
```
node src/server.js
```

### 3. Environment Variables
Adicione no Render dashboard:

| Variável | Valor | Observação |
|----------|-------|-----------|
| `DATABASE_URL` | `postgresql://...&sslmode=require` | ⚠️ ESSENCIAL - copia do BD |
| `JWT_SECRET` | Gera um novo (e seguro) | `openssl rand -hex 32` |
| `OPENAI_API_KEY` | Sua chave OpenAI | Copia de https://platform.openai.com |
| `NODE_ENV` | `production` | Ativa otimizações |
| `FRONTEND_URL` | URL do seu frontend | Para CORS |
| `ADMIN_TOKEN` | Token seguro | Para triggers admin |

## 🧪 Teste Imediato (Obrigatório)

Assim que o deploy terminar (pode demorar ~2 min):

```bash
# Health check
curl https://finmind-api-1.onrender.com/api/health

# Esperado:
{
  "status": "ok",
  "uptime": 45,
  "env": "production",
  "version": "1.0.0",
  "database": "connected"
}
```

## ⚠️ Problemas Comuns

### DATABASE_URL error
```
Error validating datasource: URL must start with postgresql://
```
**Solução**: Verifique se `DATABASE_URL` tem `?sslmode=require` no final

### Module not found
```
Cannot find module '../prisma/client'
```
**Solução**: Algum arquivo ainda está importando errado. Rode `npm run validate` localmente

### Demora absurda na primeira requisição
```
[Esperado] 10-30s na primeira requisição
[Normal] Render free "dorme" após ~15 min
```
**Não é bug** — é o comportamento normal do plano free

### Aplicação morre silenciosamente
```
[Log do Render] Exit with code 1
```
**Solução**: Verifique os logs no dashboard — geralmente é DATABASE_URL ou JWT_SECRET vazio

## 📊 Monitorar Depois do Deploy

### Render Dashboard
- Logs em tempo real
- Metrics de CPU/RAM
- Build history

### Health Check Automático
```bash
# Verificar a cada 5 minutos
watch -n 300 'curl -s https://finmind-api-1.onrender.com/api/health | jq'
```

### Log de Erros
```bash
# Acompanhar logs em tempo real
render logs finmind-api-1 --follow
```

## 🎯 Próximos Passos

1. **Git Push**
   ```bash
   git add .
   git commit -m "feat: production-ready backend with safety handlers"
   git push
   ```

2. **Re-deploy no Render**
   - Dashboard vai detectar o push
   - Build automático iniciado
   - Monitorar logs

3. **Testar com Mobile**
   - Abrir app mobile (já aponta para Render)
   - Fazer login/register
   - Verificar se dados fluem corretamente

## ✨ Dicas de Ouro

- **Primeira inicialização**: Pode demorar mais (Prisma gerando cliente)
- **SSL é obrigatório**: Adicione `?sslmode=require` na DATABASE_URL
- **Prisma cache**: Se houver problema, limpe node_modules e reinstale
- **Cold start**: Esperado no plano free — é normal

---

✅ **Você está pronto para produção!**
