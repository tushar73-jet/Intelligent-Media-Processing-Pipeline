import fs from 'fs';
import path from 'path';
import { pool } from './pool';

async function initDB() {
  const client = await pool.connect();
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    
    console.log('Running schema initialization...');
    await client.query(schema);
    console.log('Database tables created successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  initDB();
}
