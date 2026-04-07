const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

/**
 * Parses factory GeoJSON and imports into PostgreSQL
 */
async function seedDatabase() {
    const filePath = path.join(__dirname, '../../client/public/data/factories.geojson');

    if (!process.env.DATABASE_URL) {
        console.error('❌ DATABASE_URL is not set in .env');
        process.exit(1);
    }

    try {
        console.log('📦 Reading GeoJSON file...');
        const rawData = fs.readFileSync(filePath, 'utf8');
        const geojson = JSON.parse(rawData);
        const factories = geojson.features;

        console.log(`📊 Found ${factories.length} records. Connecting to database...`);
        const client = await pool.connect();

        try {
            // 1. Create table if not exists with PostGIS geometry
            console.log('🛠 Creating/Updating table factories...');
            await client.query(`
        CREATE EXTENSION IF NOT EXISTS postgis;
        
        DROP TABLE IF EXISTS factories;
        
        CREATE TABLE factories (
          id SERIAL PRIMARY KEY,
          fac_reg TEXT,
          name TEXT,
          operator_name TEXT,
          business_type TEXT,
          district TEXT,
          province TEXT,
          factory_type TEXT,
          address TEXT,
          capital_investment NUMERIC,
          horsepower NUMERIC,
          workers_male INTEGER,
          workers_female INTEGER,
          lat DOUBLE PRECISION,
          lng DOUBLE PRECISION,
          geom GEOMETRY(Point, 4326)
        );
      `);

            // 2. Batch insert data
            console.log('🚀 Starting batch import...');
            const BATCH_SIZE = 1000;
            let processed = 0;
            let valid = 0;

            for (let i = 0; i < factories.length; i += BATCH_SIZE) {
                const batch = factories.slice(i, i + BATCH_SIZE);
                const values = [];
                let placeholderIndex = 1;
                const placeholders = [];

                for (const feature of batch) {
                    const props = feature.properties;
                    const coords = feature.geometry.coordinates; // [lng, lat]

                    const lng = coords[0];
                    const lat = coords[1];

                    if (!isNaN(lat) && !isNaN(lng)) {
                        // Construct Address
                        const addressParts = [
                            props['เลขที่'],
                            props['หมู่'] !== '-' ? `ม.${props['หมู่']}` : '',
                            props['ซอย'] !== '-' ? `ซ.${props['ซอย']}` : '',
                            props['ถนน'] !== '-' ? `ถ.${props['ถนน']}` : '',
                            props['ตำบล'],
                            props['อำเภอ'],
                            props['จังหวัด'],
                            props['ไปรษณีย์']
                        ].filter(p => p && p.trim() !== '' && p !== '-' && p !== ' ');
                        const fullAddress = addressParts.join(' ');

                        // Parse numbers safely
                        const capital = parseFloat(props['เงินลงทุนค']) || 0;
                        const hp = parseFloat(props['แรงม้า']) || 0;
                        const male = parseInt(props['คนงานชาย']) || 0;
                        const female = parseInt(props['คนงานหญิง']) || 0;

                        // Push values for parameterised query
                        values.push(
                            props['เลขทะเบียน'],
                            props['ชื่อโรงงาน'] || '-',
                            props['ผู้ประกอบก'] || '-',
                            props['ประกอบกิจก'] || '-',
                            props['อำเภอ'],
                            props['จังหวัด'],
                            props['จำพวก'],
                            fullAddress,
                            capital,
                            hp,
                            male,
                            female,
                            lat,
                            lng
                        );

                        // Construct placeholder string ($1, $2, ..., ST_SetSRID(ST_MakePoint($N, $M), 4326))
                        // 14 parameters per row + geom construction
                        // geom uses $14 (lng) and $13 (lat)
                        const start = placeholderIndex;
                        placeholders.push(`($${start}, $${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}, $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8}, $${start + 9}, $${start + 10}, $${start + 11}, $${start + 12}, $${start + 13}, ST_SetSRID(ST_MakePoint($${start + 13}, $${start + 12}), 4326))`);

                        placeholderIndex += 14;
                        valid++;
                    }
                    processed++;
                }

                if (values.length > 0) {
                    const query = `
            INSERT INTO factories (
              fac_reg, name, operator_name, business_type, district, province, factory_type, address, 
              capital_investment, horsepower, workers_male, workers_female, lat, lng, geom
            )
            VALUES ${placeholders.join(', ')}
          `;
                    await client.query(query, values);
                }

                process.stdout.write(`\rProcessed ${processed}/${factories.length} records...`);
            }

            console.log(`\n✅ Successfully imported ${valid} records.`);

            // 4. Create Spatial Index
            console.log('index Creating spatial index...');
            await client.query('CREATE INDEX factories_geom_idx ON factories USING GIST (geom);');
            console.log('✅ Spatial index created.');

            // 5. Create other indexes for performance
            await client.query('CREATE INDEX factories_province_idx ON factories (province);');
            await client.query('CREATE INDEX factories_type_idx ON factories (factory_type);');

        } finally {
            client.release();
        }

        console.log('🎉 Database seeding completed successfully!');
        process.exit(0);

    } catch (err) {
        console.error('❌ Error seeding database:', err);
        process.exit(1);
    }
}

seedDatabase();
