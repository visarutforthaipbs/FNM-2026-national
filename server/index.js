const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test DB connection
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client', err.stack);
    }
    client.query('SELECT NOW()', (err, result) => {
        release();
        if (err) {
            return console.error('Error executing query', err.stack);
        }
        console.log('✅ Connected to Database');
    });
});

/**
 * GET /api/factories
 * Query params:
 * - minLat, maxLat, minLng, maxLng (Bounding box)
 * - province (Optional: filter by province)
 * - search (Optional: search term)
 * - limit (Optional: max results, default 500)
 */
app.get('/api/factories', async (req, res) => {
    try {
        const { minLat, maxLat, minLng, maxLng, province, search, limit = 500, type } = req.query;

        if (!minLat || !maxLat || !minLng || !maxLng) {
            return res.status(400).json({ error: 'Missing bounding box parameters (minLat, maxLat, minLng, maxLng)' });
        }

        let query = `
      SELECT 
        id, 
        fac_reg,
        name as "ชื่อโรงงาน", 
        operator_name as "ผู้ประกอบก", 
        business_type as "ประกอบกิจก", 
        district as "อำเภอ", 
        province as "จังหวัด", 
        factory_type as "ประเภท",
        address as "ที่อยู่",
        capital_investment as "เงินลงทุน",
        horsepower as "แรงม้า",
        workers_male as "คนงานชาย",
        workers_female as "คนงานหญิง",
        lat as "ละติจูด", 
        lng as "ลองติจูด"
      FROM factories
      WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
    `;

        const values = [
            parseFloat(minLng),
            parseFloat(minLat),
            parseFloat(maxLng),
            parseFloat(maxLat)
        ];

        let paramIndex = 5;

        // Optional: Filter by Province
        if (province) {
            query += ` AND province = $${paramIndex}`;
            values.push(province);
            paramIndex++;
        }

        // Optional: Filter by High Risk (Type "3")
        if (type === '3') {
            query += ` AND factory_type = '3'`;
        }

        // Optional: Search term
        if (search) {
            const searchPattern = `%${search}%`;
            query += ` AND (name ILIKE $${paramIndex} OR operator_name ILIKE $${paramIndex} OR business_type ILIKE $${paramIndex} OR address ILIKE $${paramIndex})`;
            values.push(searchPattern);
            paramIndex++;
        }

        // Limit results
        query += ` LIMIT $${paramIndex}`;
        values.push(parseInt(limit));

        const result = await pool.query(query, values);

        // Transform to GeoJSON
        const features = result.rows.map(row => ({
            type: "Feature",
            properties: row,
            geometry: {
                type: "Point",
                coordinates: [row.ลองติจูด, row.ละติจูด]
            }
        }));

        res.json({
            type: "FeatureCollection",
            features: features,
            total: result.rowCount
        });

    } catch (err) {
        console.error('Error fetching factories:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/provinces
 * Returns list of provinces with value and label
 */
app.get('/api/provinces', async (req, res) => {
    try {
        const result = await pool.query(`
      SELECT DISTINCT province 
      FROM factories 
      ORDER BY province ASC
    `);

        const provinces = result.rows.map(row => row.province).filter(p => p);
        res.json(provinces);
    } catch (err) {
        console.error('Error fetching provinces:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
