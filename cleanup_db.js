const { Client } = require('pg');

async function cleanup() {
  const client = new Client({
    connectionString: "postgresql://finmind_db_cwxj_user:NtrbPCuLCGbvnQ6VwTJveRa8Wkyr5MEj@dpg-d7odoifavr4c73bqmefg-a.oregon-postgres.render.com/finmind_db_cwxj",
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Conectado ao banco do Render.');
    
    const res = await client.query('DELETE FROM "_prisma_migrations" WHERE migration_name = \'20260430210000_sync_google_auth\';');
    console.log(`Registro removido. Linhas afetadas: ${res.rowCount}`);
    
  } catch (err) {
    console.error('Erro ao limpar migration:', err.message);
  } finally {
    await client.end();
  }
}

cleanup();
