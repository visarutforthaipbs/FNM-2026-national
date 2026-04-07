const { Pool } = require('pg');
require('dotenv').config({ path: '/Users/visarutsankham/factory-nearme-demo-1/server/.env' });
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
pool.query('NOTIFY pgrst, "reload schema";')
  .then(() => {
    console.log('Schema reloaded!');
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
