const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
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

/**
 * GET /api/admin/approximate-factories?precision=tambon&limit=50&offset=0&province=&search=&sort=
 *
 * Factories that ARE on the map but in the wrong place to within kilometres —
 * the faded pins. `unmapped-factories` cannot cover these: it filters on
 * `lat IS NULL`, and these all have coordinates, just derived ones.
 *
 *   tambon  (coord_source='centroid') ±2–5 km, from the sub-district gazetteer
 *   street  (coord_source='geocoded') from the address via Longdo
 *
 * Never includes 'gov', 'admin' or 'community' positions: those are either the
 * authoritative feed or already human-verified, and are not up for revision
 * here — a citizen disagreeing with one goes through location_corrections.
 */
const APPROX_SOURCES = { tambon: 'centroid', street: 'geocoded' };

app.get('/api/admin/approximate-factories', requireAdmin, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { province, search, precision } = req.query;

    const where = ["status = 'ดำเนินการ'", 'lat IS NOT NULL'];
    const values = [];
    if (APPROX_SOURCES[precision]) {
        values.push(APPROX_SOURCES[precision]);
        where.push(`coord_source = $${values.length}`);
    } else {
        where.push(`coord_source IN ('centroid','geocoded')`);
    }
    if (province) {
        values.push(province);
        where.push(`province = $${values.length}`);
    }
    if (search) {
        values.push(`%${search}%`);
        where.push(`(name ILIKE $${values.length} OR id ILIKE $${values.length} OR address_full ILIKE $${values.length})`);
    }
    const whereClause = where.join(' AND ');

    // Two honest ways to work through 23,000 items: geographically, so a
    // reviewer can check one district against local knowledge in one sitting;
    // or biggest-first, so the factories affecting the most neighbours get a
    // real position soonest.
    const orderBy = req.query.sort === 'impact'
        ? 'capital_investment DESC NULLS LAST, total_workers DESC NULLS LAST, name'
        : 'province, district, sub_district, name';

    try {
        const [rows, count] = await Promise.all([
            pool.query(`
        SELECT id, name, address_full, province, district, sub_district,
               factory_type, capital_investment, total_workers,
               lat, lng, coord_source, coord_precision
        FROM factories
        WHERE ${whereClause}
        ORDER BY ${orderBy}
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `, [...values, limit, offset]),
            pool.query(`SELECT count(*)::int AS total FROM factories WHERE ${whereClause}`, values),
        ]);
        res.json({ rows: rows.rows, total: count.rows[0].total });
    } catch (err) {
        console.error('Error listing approximate factories:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/admin/approximate-factories/:id  { lat, lng }
 * Replaces a derived position with a verified one.
 *
 * The WHERE clause restricts this to rows that are still approximate, so a
 * stale admin tab cannot overwrite a position that has since been fixed by the
 * government feed or by an approved community correction.
 */
app.post('/api/admin/approximate-factories/:id', requireAdmin, async (req, res) => {
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
      WHERE id = $3 AND coord_source IN ('centroid','geocoded')
      RETURNING id, lat, lng, coord_source
    `, [lat, lng, req.params.id]);
        if (result.rowCount === 0) {
            return res.status(409).json({
                error: 'Factory not found, or its position is no longer an approximate one',
            });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error setting approximate factory position:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/admin/dbd-matches?queue=pending&limit=50&offset=0&search=
 *
 * The human review queue for DIW operator -> DBD company links.
 *
 * The resolver deliberately refuses to guess: anything it cannot settle is
 * recorded as `probable` or `ambiguous`, and `dbd.factory_owner` publishes only
 * `exact` or human-verified links. Those unsettled rows are therefore invisible
 * to the public and stay that way until someone decides here — this endpoint is
 * the only route by which they can ever be published.
 *
 *   queue=pending   unverified probable/ambiguous — the decisions waiting
 *   queue=exact     automatic exact links, for auditing what is already public
 *   queue=verified  decisions already made, so they can be revisited
 */
app.get('/api/admin/dbd-matches', requireAdmin, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const queue = ['pending', 'exact', 'verified'].includes(req.query.queue)
        ? req.query.queue : 'pending';
    const { search } = req.query;

    const where = [];
    const values = [];
    if (queue === 'pending') {
        where.push("m.verified_by IS NULL", "m.outcome IN ('probable','ambiguous')");
    } else if (queue === 'exact') {
        where.push("m.verified_by IS NULL", "m.outcome = 'exact'");
    } else {
        where.push('m.verified_by IS NOT NULL');
    }
    if (search) {
        values.push(`%${search}%`);
        where.push(`(m.legal_name ILIKE $${values.length} OR j.jp_name ILIKE $${values.length} OR m.jp_no ILIKE $${values.length})`);
    }
    const whereClause = where.join(' AND ');

    // Factory context is what makes the decision reviewable: how many plants
    // this link would attribute, and where they actually are. A DBD head office
    // in Bangkok against factories in Rayong is the kind of disagreement a
    // reviewer needs to see before confirming.
    const fromClause = `
      FROM dbd.operator_match m
      LEFT JOIN dbd.juristic j ON j.jp_no = m.jp_no
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS factory_count,
               (array_agg(f.name ORDER BY f.name))[1:3] AS factory_names,
               (array_agg(DISTINCT f.province))[1:5] AS factory_provinces
        FROM public.factories f
        WHERE f.business_id = m.business_id AND f.status = 'ดำเนินการ'
      ) fc ON true
      WHERE ${whereClause}`;

    try {
        const [rows, count] = await Promise.all([
            pool.query(`
        SELECT m.business_id, m.legal_name, m.core_name, m.matched_query,
               m.expected_form, m.jp_no, m.outcome, m.candidates,
               m.isic_agrees, m.province_agrees, m.resolved_at,
               m.verified_by, m.verified_at, m.verified_note,
               j.jp_name, j.jp_type_desc, j.jp_status_desc,
               j.province AS jp_province, j.register_capital,
               COALESCE(fc.factory_count, 0) AS factory_count,
               fc.factory_names, fc.factory_provinces
        ${fromClause}
        ORDER BY COALESCE(fc.factory_count, 0) DESC, m.legal_name
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `, [...values, limit, offset]),
            pool.query(`SELECT count(*)::int AS total ${fromClause}`, values),
        ]);
        res.json({ rows: rows.rows, total: count.rows[0].total });
    } catch (err) {
        console.error('Error listing DBD matches:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/admin/dbd-matches/:businessId
 *   { action: 'confirm' | 'reject', note?, reviewer?, jp_no? }
 *
 * confirm  publishes the link (optionally re-pointing it at a jp_no the
 *          reviewer supplies, when the automatic pick was the wrong company).
 * reject   clears jp_no, which removes the row from dbd.factory_owner because
 *          that view inner-joins the juristic table. This is also how a wrong
 *          `exact` link gets un-published.
 *
 * Either way `verified_by` is set, and dbd_load.py freezes jp_no and outcome
 * for any row that has it — so a human decision survives every later re-run of
 * the collector, the same protection community coordinates get from the sync.
 */
app.post('/api/admin/dbd-matches/:businessId', requireAdmin, async (req, res) => {
    const { action, note, reviewer, jp_no: overrideJpNo } = req.body || {};
    if (!['confirm', 'reject'].includes(action)) {
        return res.status(400).json({ error: "action must be 'confirm' or 'reject'" });
    }
    const verifiedBy = (typeof reviewer === 'string' && reviewer.trim()) ? reviewer.trim() : 'admin';

    try {
        if (action === 'reject') {
            const result = await pool.query(`
        UPDATE dbd.operator_match
        SET jp_no = NULL, verified_by = $1, verified_at = now(), verified_note = $2
        WHERE business_id = $3
        RETURNING business_id, jp_no, outcome, verified_by
      `, [verifiedBy, note || null, req.params.businessId]);
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Match not found' });
            }
            return res.json(result.rows[0]);
        }

        // Confirming needs something to confirm. A reviewer-supplied jp_no has
        // to be a company we actually hold, or the foreign key would fail with
        // an error that says nothing useful.
        let targetJpNo = overrideJpNo;
        if (targetJpNo) {
            const known = await pool.query('SELECT 1 FROM dbd.juristic WHERE jp_no = $1', [targetJpNo]);
            if (known.rowCount === 0) {
                return res.status(400).json({
                    error: `jp_no ${targetJpNo} is not in the collected DBD registry — it has to be crawled before it can be linked`,
                });
            }
        } else {
            const existing = await pool.query(
                'SELECT jp_no FROM dbd.operator_match WHERE business_id = $1',
                [req.params.businessId]
            );
            if (existing.rowCount === 0) {
                return res.status(404).json({ error: 'Match not found' });
            }
            targetJpNo = existing.rows[0].jp_no;
            if (!targetJpNo) {
                return res.status(400).json({
                    error: 'This match has no candidate company — supply jp_no to link one',
                });
            }
        }

        const result = await pool.query(`
      UPDATE dbd.operator_match
      SET jp_no = $1, verified_by = $2, verified_at = now(), verified_note = $3
      WHERE business_id = $4
      RETURNING business_id, jp_no, outcome, verified_by
    `, [targetJpNo, verifiedBy, note || null, req.params.businessId]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Match not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error reviewing DBD match:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// In-memory token cache for DBD API
let dbdTokenCache = { token: null, encKey: null, exp: 0 };

async function getDbdToken() {
    const now = Math.floor(Date.now() / 1000);
    if (dbdTokenCache.token && dbdTokenCache.exp > now + 30) {
        return dbdTokenCache;
    }
    const BASE = 'https://datawarehouse.dbd.go.th';
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
    const res = await fetch(BASE + '/api/refresh', {
        method: 'POST',
        headers: { 'User-Agent': ua, 'Accept': 'application/json', 'Origin': BASE, 'Referer': BASE + '/' }
    });
    const data = await res.json();
    const idToken = data.idToken;
    const payloadB64 = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    const encKey = Buffer.from(payload.encKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    dbdTokenCache = { token: idToken, encKey, exp: payload.exp || (now + 600) };
    return dbdTokenCache;
}

const fs = require('fs');
const NATIONS_CACHE_FILE = path.join(__dirname, 'data', 'dbd_nations_cache.json');

/**
 * GET /api/dbd/nations/:jpType/:jpNo
 * Live fetch & decryption of DBD shareholder nationality summaries
 */
app.get('/api/dbd/nations/:jpType/:jpNo', async (req, res) => {
    const { jpType, jpNo } = req.params;

    // Check disk cache first for instant response
    try {
        if (fs.existsSync(NATIONS_CACHE_FILE)) {
            const cache = JSON.parse(fs.readFileSync(NATIONS_CACHE_FILE, 'utf8'));
            if (cache[jpNo]) {
                return res.json(cache[jpNo]);
            }
        }
    } catch (cacheErr) {
        console.warn('Warning reading nations cache:', cacheErr.message);
    }

    try {
        const { token, encKey } = await getDbdToken();
        const BASE = 'https://datawarehouse.dbd.go.th';
        const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
        const path = `/api/v1/company-profiles/nations/${encodeURIComponent(jpType)}/${encodeURIComponent(jpNo)}`;
        const response = await fetch(BASE + path, {
            headers: { 'User-Agent': ua, 'Accept': 'application/json', 'Authorization': 'Bearer ' + token, 'Origin': BASE, 'Referer': BASE + '/' }
        });
        if (!response.ok) {
            return res.status(response.status).json({ error: 'DBD API error' });
        }
        const body = await response.json();
        if (!body.ct) {
            return res.json([]);
        }
        const salt = Buffer.from(body.salt.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        const iv = Buffer.from(body.iv.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        const ct = Buffer.from(body.ct.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        const kid = body.kid;
        const info = Buffer.from(`bdw|v${kid}|${path}`);

        const key = crypto.hkdfSync('sha256', encKey, salt, info, 32);
        const tag = ct.subarray(ct.length - 16);
        const ciphertext = ct.subarray(0, ct.length - 16);

        const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), iv);
        decipher.setAuthTag(tag);
        decipher.setAAD(info);

        let pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        if (pt[0] === 0x1f && pt[1] === 0x8b) {
            pt = zlib.gunzipSync(pt);
        } else {
            try { pt = zlib.inflateRawSync(pt); } catch (e) {}
        }

        const nations = JSON.parse(pt.toString());

        const owners = [];
        for (const item of nations) {
            const code = item.ntCode;
            if (!code || code === 'WORLD2') continue;
            const countryName = item.nationality?.countryName || item.nationality?.ntName || code;
            const qty = item.shareQty || 1;
            const pct = item.sharePctVol || item.sharePctQty || null;
            const amt = item.shareAmt || null;

            for (let i = 0; i < qty; i++) {
                owners.push({
                    name: `ผู้ถือหุ้นสัญชาติ${countryName}`,
                    nationality: code,
                    shareAmount: i === 0 ? amt : null,
                    sharePercent: i === 0 ? pct : null
                });
            }
        }

        res.json(owners);
    } catch (err) {
        console.error('Error fetching DBD nations:', err);
        res.status(500).json({ error: err.message });
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
