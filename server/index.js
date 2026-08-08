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

        if (values.some((v) => !Number.isFinite(v))) {
            return res.status(400).json({ error: 'Bounding box parameters must be valid numbers' });
        }

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

        // Limit results (clamp to 1–5000; fall back to 500 on bad input)
        const parsedLimit = parseInt(limit, 10);
        const safeLimit = Number.isFinite(parsedLimit)
            ? Math.min(Math.max(parsedLimit, 1), 5000)
            : 500;
        query += ` LIMIT $${paramIndex}`;
        values.push(safeLimit);

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

/**
 * ── Admin API ──────────────────────────────────────────────────────────────
 * Moderation of citizen reports and location corrections.
 * Auth: static bearer token (ADMIN_TOKEN env var). The pg pool connects as
 * the table owner, so RLS on reports/location_corrections doesn't apply here.
 */
const requireAdmin = (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!process.env.ADMIN_TOKEN) {
        return res.status(503).json({ error: 'Admin API not configured (ADMIN_TOKEN missing)' });
    }
    if (token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

const MODERATION_STATUSES = ['pending', 'approved', 'rejected'];

/**
 * GET /api/admin/reports?status=pending
 * Pending citizen impact reports, joined with factory name for context.
 * Includes reporter_contact — admin-only data, never expose elsewhere.
 */
app.get('/api/admin/reports', requireAdmin, async (req, res) => {
    const status = MODERATION_STATUSES.includes(req.query.status) ? req.query.status : 'pending';
    try {
        const result = await pool.query(`
      SELECT r.id, r.factory_id, f.name AS factory_name, f.province,
             r.impact_types, r.frequency, r.distance_band, r.description,
             r.incident_date, r.reporter_contact, r.status, r.reject_reason,
             r.created_at, r.moderated_at
      FROM reports r
      LEFT JOIN factories f ON f.id = r.factory_id
      WHERE r.status = $1
      ORDER BY r.created_at ASC
      LIMIT 200
    `, [status]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error listing reports:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/admin/reports/:id  { action: 'approve' | 'reject', reject_reason? }
 */
app.post('/api/admin/reports/:id', requireAdmin, async (req, res) => {
    const { action, reject_reason } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    }
    try {
        const result = await pool.query(`
      UPDATE reports
      SET status = $1, moderated_at = now(), reject_reason = $2
      WHERE id = $3 AND status = 'pending'
      RETURNING id, status
    `, [action === 'approve' ? 'approved' : 'rejected', reject_reason || null, req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Report not found or already moderated' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error moderating report:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/admin/corrections?status=pending
 * Citizen location corrections with the factory's current position for
 * side-by-side comparison.
 */
app.get('/api/admin/corrections', requireAdmin, async (req, res) => {
    const status = MODERATION_STATUSES.includes(req.query.status) ? req.query.status : 'pending';
    try {
        const result = await pool.query(`
      SELECT c.id, c.factory_id, c.factory_name, c.lat, c.lng, c.note,
             c.status, c.reject_reason, c.created_at, c.moderated_at,
             f.name AS current_name, f.province, f.district,
             f.lat AS current_lat, f.lng AS current_lng,
             f.coord_source AS current_coord_source
      FROM location_corrections c
      LEFT JOIN factories f ON f.id = c.factory_id
      WHERE c.status = $1
      ORDER BY c.created_at ASC
      LIMIT 200
    `, [status]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error listing corrections:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/admin/corrections/:id  { action: 'approve' | 'reject', reject_reason? }
 * Approving applies the position to the factory (lat/lng + PostGIS geom,
 * coord_source = 'community') and marks the correction, atomically.
 */
app.post('/api/admin/corrections/:id', requireAdmin, async (req, res) => {
    const { action, reject_reason } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const corr = await client.query(
            `SELECT * FROM location_corrections WHERE id = $1 AND status = 'pending' FOR UPDATE`,
            [req.params.id]
        );
        if (corr.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Correction not found or already moderated' });
        }

        if (action === 'approve') {
            const { factory_id, lat, lng } = corr.rows[0];
            const updated = await client.query(`
        UPDATE factories
        SET lat = $1, lng = $2,
            coord_source = 'community', coord_precision = 'exact',
            geom = ST_SetSRID(ST_MakePoint($2, $1), 4326)
        WHERE id = $3
        RETURNING id
      `, [lat, lng, factory_id]);
            if (updated.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: `Factory ${factory_id} not found` });
            }
        }

        const result = await client.query(`
      UPDATE location_corrections
      SET status = $1, moderated_at = now(), reject_reason = $2
      WHERE id = $3
      RETURNING id, status
    `, [action === 'approve' ? 'approved' : 'rejected', reject_reason || null, req.params.id]);

        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error moderating correction:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

const TH_LAT_RANGE = [5.3, 20.6];
const TH_LNG_RANGE = [97.2, 105.7];

/**
 * GET /api/admin/unmapped-factories?limit=50&offset=0&province=&search=
 * Operating factories with no coordinates at all — for manual verification.
 * Ordered by province/district so an admin can work through one area at a time.
 */
app.get('/api/admin/unmapped-factories', requireAdmin, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { province, search } = req.query;

    const where = ["is_active = true", "status = 'ดำเนินการ'", "lat IS NULL"];
    const values = [];
    if (province) {
        values.push(province);
        where.push(`province = $${values.length}`);
    }
    if (search) {
        values.push(`%${search}%`);
        where.push(`(name ILIKE $${values.length} OR id ILIKE $${values.length} OR address_full ILIKE $${values.length})`);
    }
    const whereClause = where.join(' AND ');

    try {
        const [rows, count] = await Promise.all([
            pool.query(`
        SELECT id, name, address_full, province, district, sub_district,
               factory_type, capital_investment
        FROM factories
        WHERE ${whereClause}
        ORDER BY province, district, name
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `, [...values, limit, offset]),
            pool.query(`SELECT count(*) FROM factories WHERE ${whereClause}`, values),
        ]);
        res.json({ rows: rows.rows, total: parseInt(count.rows[0].count, 10) });
    } catch (err) {
        console.error('Error listing unmapped factories:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/admin/unmapped-factories/:id  { lat, lng }
 * Sets a manually-verified position. Only succeeds while the factory still
 * has no coordinates — an already-mapped factory goes through the citizen
 * location_corrections review flow instead, not this one.
 */
app.post('/api/admin/unmapped-factories/:id', requireAdmin, async (req, res) => {
    const { lat, lng } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number' ||
        lat < TH_LAT_RANGE[0] || lat > TH_LAT_RANGE[1] ||
        lng < TH_LNG_RANGE[0] || lng > TH_LNG_RANGE[1]) {
        return res.status(400).json({ error: 'lat/lng must be numbers within Thailand' });
    }
    try {
        const result = await pool.query(`
      UPDATE factories
      SET lat = $1, lng = $2,
          coord_source = 'admin', coord_precision = 'exact',
          geom = ST_SetSRID(ST_MakePoint($2, $1), 4326)
      WHERE id = $3 AND lat IS NULL
      RETURNING id, lat, lng
    `, [lat, lng, req.params.id]);
        if (result.rowCount === 0) {
            return res.status(409).json({ error: 'Factory not found or already has coordinates' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error setting factory position:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start server
// HOST defaults to all interfaces; self-hosted deployments set it to 127.0.0.1
// so only the local reverse proxy (Tailscale) can reach the admin routes.
if (require.main === module) {
    const HOST = process.env.HOST || '0.0.0.0';
    app.listen(PORT, HOST, () => {
        console.log(`🚀 Server running on http://${HOST}:${PORT}`);
    });
}

module.exports = app;
