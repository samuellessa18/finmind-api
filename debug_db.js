const { Client } = require('pg');

async function debugDB() {
  const client = new Client({
    connectionString: "postgresql://finmind_db_cwxj_user:NtrbPCuLCGbvnQ6VwTJveRa8Wkyr5MEj@dpg-d7odoifavr4c73bqmefg-a.oregon-postgres.render.com/finmind_db_cwxj",
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('--- DIAGNÓSTICO DO BANCO ---');
    
    // Listar tabelas
    const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    console.log('Tabelas existentes:', tables.rows.map(r => r.table_name).join(', '));
    
    // Listar colunas da User
    const columns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'User'");
    console.log('Colunas na User:', columns.rows.map(r => r.column_name).join(', '));
    
    // Listar histórico de migrations
    const migrations = await client.query('SELECT migration_name FROM "_prisma_migrations"');
    console.log('Histórico de Migrations:', migrations.rows.map(r => r.migration_name).join(', '));

  } catch (err) {
    console.error('Erro no diagnóstico:', err.message);
  } finally {
    await client.end();
  }
}

debugDB();
