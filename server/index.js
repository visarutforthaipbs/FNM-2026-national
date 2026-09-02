const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
// This process sits behind exactly one reverse proxy on localhost (tailscale
// serve/funnel → 127.0.0.1:3001), so trust the loopback hop only. Trusting
// every hop would let a caller spoof X-Forwarded-For and defeat the rate
// limiter's per-IP key below.
app.set('trust proxy', 'loopback');
app.use(cors());
app.use(express.json());

// Two databases — see supabase/README.md.
//
//   pool         government data on this host: factories, businesses, DBD.
//                Rebuildable from the collectors.
//   citizenPool  citizen data in the cloud project: reports, corrections,
//                accounts. Rebuildable from nothing.
//
// Both connect as table owner, so RLS does not apply to either. That is
// deliberate for moderation, and it is why this process is tailnet-only
// (HANDOFF.md §8): it is the only place reporter contact details are readable.
//
// Nothing may join across the two. Approving a location correction therefore
// spans both and cannot be one transaction — see the ordering note there.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const citizenPool = new Pool({
    connectionString: process.env.CITIZEN_DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

if (!process.env.CITIZEN_DATABASE_URL) {
    console.warn('⚠️  CITIZEN_DATABASE_URL is not set — falling back to Cloud Firestore for moderation.');
}

// ── Firebase Admin SDK (Cloud Firestore for Citizen data) ────────────────────
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const fs = require('fs');

let firestore = null;
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, 'serviceAccountKey.json');

if (fs.existsSync(serviceAccountPath)) {
    try {
        const serviceAccount = require(serviceAccountPath);
        const fbApp = getApps().length
            ? getApps()[0]
            : initializeApp({
                credential: cert(serviceAccount),
                projectId: process.env.FIREBASE_PROJECT_ID || 'factory-near-me'
            });
        firestore = getFirestore(fbApp);
        console.log('✅ Connected to Cloud Firestore for Citizen moderation (service account)');
    } catch (e) {
        console.warn('⚠️  Could not initialize Firebase Admin:', e.message);
    }
} else if (process.env.FIREBASE_PROJECT_ID) {
    try {
        const fbApp = getApps().length
            ? getApps()[0]
            : initializeApp({
                projectId: process.env.FIREBASE_PROJECT_ID
            });
        firestore = getFirestore(fbApp);
        console.log('✅ Connected to Cloud Firestore via project ID');
    } catch (e) {
        console.warn('⚠️  Could not initialize Firebase Admin:', e.message);
    }
}

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
 * REMOVED 2026-08-13: GET /api/factories
 *
 * A bounding-box GeoJSON query that nothing calls — the client browses static
 * JSON in client/public/data/ and fetches detail straight from PostgREST. It
 * had been returning 500 on the live public host for an unknown length of time.
 * Removed rather than fixed: a broken, unreferenced, publicly reachable
 * endpoint is only ever an attack surface. Recover it from git history if a
 * caller ever turns up.
 *
 * GET /api/provinces below is equally unreferenced by the client but still
 * works, so it is left alone for now.
 */
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
/**
 * Rate limiter for /api/admin/*. The token is the only thing standing between
 * the public internet and reporter contact details on unmoderated reports, and
 * before this there was no throttle at all — 20 bad tokens in a row were
 * answered 401 identically with no backoff. 30/min per IP is far above what a
 * human reviewer clicking through a queue needs.
 */
const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests' }
});

/**
 * One line per admin request: who, what, and the outcome. Without this a leaked
 * token leaves no way to establish what was read. Never logs the token itself.
 */
const logAdminRequest = (req, outcome) => {
    console.log(
        `[admin] ${new Date().toISOString()} ip=${req.ip} ${req.method} ${req.originalUrl} → ${outcome}`
    );
};

const requireAdmin = (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!process.env.ADMIN_TOKEN) {
        logAdminRequest(req, 'unconfigured');
        return res.status(503).json({ error: 'Admin API not configured (ADMIN_TOKEN missing)' });
    }
    // Constant-time compare. timingSafeEqual throws on length mismatch, which
    // would itself leak the length, so hash both sides to a fixed 32 bytes first.
    const presented = crypto.createHash('sha256').update(token).digest();
    const expected = crypto.createHash('sha256').update(process.env.ADMIN_TOKEN).digest();
    if (!crypto.timingSafeEqual(presented, expected)) {
        logAdminRequest(req, 'DENIED');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    logAdminRequest(req, 'ok');
    next();
};

// Applied before requireAdmin so that failed auth attempts are throttled too,
// not just successful ones.
app.use('/api/admin', adminLimiter);

const MODERATION_STATUSES = ['pending', 'approved', 'rejected'];

/**
 * GET /api/admin/reports?status=pending
 * Pending citizen impact reports, joined with factory name for context.
 * Includes reporter_contact — admin-only data, never expose elsewhere.
 */
app.get('/api/admin/reports', requireAdmin, async (req, res) => {
    const status = MODERATION_STATUSES.includes(req.query.status) ? req.query.status : 'pending';
    try {
        if (firestore) {
            const snap = await firestore.collection('reports')
                .where('status', '==', status)
                .limit(200)
                .get();

            const rows = await Promise.all(snap.docs.map(async (d) => {
                const data = d.data();
                let reporter_contact = null;
                try {
                    const sensitiveSnap = await d.ref.collection('sensitive').doc('details').get();
                    if (sensitiveSnap.exists) {
                        reporter_contact = sensitiveSnap.data().reporter_contact || null;
                    }
                } catch (e) {
                    /* optional */
                }

                return {
                    id: d.id,
                    factory_id: data.factory_id,
                    impact_types: data.impact_types || [],
                    frequency: data.frequency || null,
                    distance_band: data.distance_band || null,
                    description: data.description || null,
                    incident_date: data.incident_date || null,
                    reporter_contact,
                    status: data.status || 'pending',
                    reject_reason: data.reject_reason || null,
                    created_at: data.created_at?.toDate ? data.created_at.toDate().toISOString() : (data.created_at || new Date().toISOString()),
                    moderated_at: data.moderated_at?.toDate ? data.moderated_at.toDate().toISOString() : null,
                };
            }));

            // Sort ascending by created_at in memory
            rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

            return res.json(await withFactoryContext(rows));
        }

        // Fallback to Postgres citizenPool
        const result = await citizenPool.query(`
      SELECT r.id, r.factory_id,
             r.impact_types, r.frequency, r.distance_band, r.description,
             r.incident_date, r.reporter_contact, r.status, r.reject_reason,
             r.created_at, r.moderated_at
      FROM reports r
      WHERE r.status = $1
      ORDER BY r.created_at ASC
      LIMIT 200
    `, [status]);

        res.json(await withFactoryContext(result.rows));
    } catch (err) {
        console.error('Error listing reports:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Attach factory_name/province to rows carrying a factory_id, by looking them
 * up in the government database. Replaces a LEFT JOIN that is no longer
 * possible across the two. Best-effort: an id the registry no longer knows
 * leaves the name null rather than dropping the row, which matters because a
 * moderator still needs to see the report.
 */
async function withFactoryContext(rows) {
    const ids = [...new Set(rows.map((r) => r.factory_id).filter(Boolean))];
    if (ids.length === 0) return rows;

    let byId = new Map();
    try {
        const facs = await pool.query(
            'SELECT id, name, province FROM factories WHERE id = ANY($1)',
            [ids]
        );
        byId = new Map(facs.rows.map((f) => [f.id, f]));
    } catch (err) {
        console.error('Could not resolve factory names:', err.message);
    }

    return rows.map((r) => ({
        ...r,
        factory_name: byId.get(r.factory_id)?.name ?? null,
        province: byId.get(r.factory_id)?.province ?? null,
    }));
}

/**
 * POST /api/admin/reports/:id  { action: 'approve' | 'reject', reject_reason? }
 */
app.post('/api/admin/reports/:id', requireAdmin, async (req, res) => {
    const { action, reject_reason } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    }
    try {
        if (firestore) {
            const reportRef = firestore.collection('reports').doc(req.params.id);
            const docSnap = await reportRef.get();
            if (!docSnap.exists) {
                return res.status(404).json({ error: 'Report not found' });
            }
            if (docSnap.data().status !== 'pending') {
                return res.status(409).json({ error: 'Report already moderated' });
            }

            const newStatus = action === 'approve' ? 'approved' : 'rejected';
            await reportRef.update({
                status: newStatus,
                reject_reason: reject_reason || null,
                moderated_at: FieldValue.serverTimestamp()
            });

            return res.json({ id: req.params.id, status: newStatus });
        }

        const result = await citizenPool.query(`
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

async function withCurrentFactoryPositions(rows) {
    const ids = [...new Set(rows.map((r) => r.factory_id).filter(Boolean))];
    let byId = new Map();
    if (ids.length > 0) {
        const facs = await pool.query(
            `SELECT id, name, province, district, lat, lng, coord_source
               FROM factories WHERE id = ANY($1)`,
            [ids]
        );
        byId = new Map(facs.rows.map((f) => [f.id, f]));
    }

    return rows.map((c) => {
        const f = byId.get(c.factory_id);
        return {
            ...c,
            current_name: f?.name ?? null,
            province: f?.province ?? null,
            district: f?.district ?? null,
            current_lat: f?.lat ?? null,
            current_lng: f?.lng ?? null,
            current_coord_source: f?.coord_source ?? null,
        };
    });
}

/**
 * GET /api/admin/corrections?status=pending|approved|rejected
 *
 * Citizen location corrections with the factory's current position for
 * side-by-side comparison.
 */
app.get('/api/admin/corrections', requireAdmin, async (req, res) => {
    const status = MODERATION_STATUSES.includes(req.query.status) ? req.query.status : 'pending';
    try {
        if (firestore) {
            const snap = await firestore.collection('location_corrections')
                .where('status', '==', status)
                .limit(200)
                .get();

            const rows = snap.docs.map((d) => {
                const data = d.data();
                return {
                    id: d.id,
                    factory_id: data.factory_id,
                    factory_name: data.factory_name || null,
                    lat: data.lat,
                    lng: data.lng,
                    note: data.note || null,
                    status: data.status || 'pending',
                    reject_reason: data.reject_reason || null,
                    created_at: data.created_at?.toDate ? data.created_at.toDate().toISOString() : (data.created_at || new Date().toISOString()),
                    moderated_at: data.moderated_at?.toDate ? data.moderated_at.toDate().toISOString() : null,
                };
            });

            rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            return res.json(await withCurrentFactoryPositions(rows));
        }

        // Postgres fallback
        const result = await citizenPool.query(`
      SELECT c.id, c.factory_id, c.factory_name, c.lat, c.lng, c.note,
             c.status, c.reject_reason, c.created_at, c.moderated_at
      FROM location_corrections c
      WHERE c.status = $1
      ORDER BY c.created_at ASC
      LIMIT 200
    `, [status]);

        res.json(await withCurrentFactoryPositions(result.rows));
    } catch (err) {
        console.error('Error listing corrections:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/admin/corrections/:id  { action: 'approve' | 'reject', reject_reason? }
 *
 * Approving reads the correction from the citizen database and applies the
 * position to `factories` in the government one.
 */
app.post('/api/admin/corrections/:id', requireAdmin, async (req, res) => {
    const { action, reject_reason } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    }

    try {
        if (firestore) {
            const corrRef = firestore.collection('location_corrections').doc(req.params.id);
            const docSnap = await corrRef.get();
            if (!docSnap.exists) {
                return res.status(404).json({ error: 'Correction not found' });
            }
            const data = docSnap.data();
            if (data.status !== 'pending') {
                return res.status(409).json({ error: 'Correction already moderated' });
            }

            if (action === 'approve') {
                const { factory_id, lat, lng } = data;
                const updated = await pool.query(`
                    UPDATE factories
                    SET lat = $1, lng = $2,
                        coord_source = 'community', coord_precision = 'exact'
                    WHERE id = $3
                    RETURNING id
                `, [lat, lng, factory_id]);
                if (updated.rowCount === 0) {
                    return res.status(409).json({ error: `Factory ${factory_id} not found` });
                }
            }

            const newStatus = action === 'approve' ? 'approved' : 'rejected';
            await corrRef.update({
                status: newStatus,
                reject_reason: reject_reason || null,
                moderated_at: FieldValue.serverTimestamp()
            });

            return res.json({ id: req.params.id, status: newStatus });
        }

        // Postgres fallback
        const corr = await citizenPool.query(
            `SELECT * FROM location_corrections WHERE id = $1 AND status = 'pending'`,
            [req.params.id]
        );
        if (corr.rowCount === 0) {
            return res.status(404).json({ error: 'Correction not found or already moderated' });
        }

        if (action === 'approve') {
            const { factory_id, lat, lng } = corr.rows[0];
            const updated = await pool.query(`
        UPDATE factories
        SET lat = $1, lng = $2,
            coord_source = 'community', coord_precision = 'exact'
        WHERE id = $3
        RETURNING id
      `, [lat, lng, factory_id]);
            if (updated.rowCount === 0) {
                return res.status(409).json({ error: `Factory ${factory_id} not found` });
            }
        }

        const result = await citizenPool.query(`
      UPDATE location_corrections
      SET status = $1, moderated_at = now(), reject_reason = $2
      WHERE id = $3 AND status = 'pending'
      RETURNING id, status
    `, [action === 'approve' ? 'approved' : 'rejected', reject_reason || null, req.params.id]);

        if (result.rowCount === 0) {
            return res.status(409).json({ error: 'Correction was moderated concurrently' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error moderating correction:', err);
        res.status(500).json({ error: 'Internal server error' });
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
 * GET /api/admin/province-mismatch?limit=50&offset=0&search=
 *
 * Factories plotted outside the province they are tagged with — the pin and the
 * badge disagree. This is wrong in both directions at once: the factory is
 * missing from the province a neighbour would look in, and present in one it
 * has nothing to do with.
 *
 * The list comes from server/sync/audit_province_mismatch.py, which does the
 * point-in-polygon offline against the same boundaries the map ships. 217 of
 * the 221 are `gov` coordinates — this is the government feed, not our
 * geocoding tiers, which is why the fix has to be manual.
 *
 * Rows already dealt with drop out: a coordinate an admin or a citizen has set
 * is authoritative, and so is one that has moved since the audit ran.
 */
const MISMATCH_REPORT = path.join(__dirname, 'data', 'province_mismatch_report.json');

function loadMismatchReport() {
    try {
        // Required here rather than relying on the `fs` binding declared further
        // down this file — this function must not depend on evaluation order.
        return JSON.parse(require('fs').readFileSync(MISMATCH_REPORT, 'utf8')).rows || [];
    } catch (err) {
        console.warn('province mismatch report unavailable:', err.message);
        return [];
    }
}

app.get('/api/admin/province-mismatch', requireAdmin, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = (req.query.search || '').trim();

    const rows = loadMismatchReport();
    if (!rows.length) return res.json({ rows: [], total: 0 });

    try {
        const current = await pool.query(`
      SELECT id, name, province, lat, lng, coord_source, address_full, district
      FROM factories WHERE id = ANY($1)
    `, [rows.map(r => r.id)]);
        const byId = new Map(current.rows.map(r => [r.id, r]));

        const open = rows.filter(r => {
            const f = byId.get(r.id);
            if (!f || f.lat === null) return false;
            // Already reviewed by a human, or moved since the audit.
            if (['admin', 'community'].includes(f.coord_source)) return false;
            const moved = Math.abs(Number(f.lat) - r.lat) > 1e-6 ||
                          Math.abs(Number(f.lng) - r.lng) > 1e-6;
            return !moved;
        }).map(r => {
            const f = byId.get(r.id);
            return {
                ...r,
                name: f.name || r.name,
                district: f.district,
                address_full: f.address_full,
                coord_source: f.coord_source,
            };
        }).filter(r => !search ||
            (r.name || '').includes(search) || r.id.includes(search) ||
            (r.tagged || '').includes(search) || (r.actual || '').includes(search));

        // Worst first: distance is the best proxy for how obviously wrong it is.
        open.sort((a, b) => b.km_outside - a.km_outside);
        res.json({ rows: open.slice(offset, offset + limit), total: open.length });
    } catch (err) {
        console.error('Error listing province mismatches:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/admin/province-mismatch/:id  { lat, lng }
 *
 * Only ids the audit flagged may be corrected here, and only while the position
 * is still the one it flagged — so this cannot become a general write path over
 * authoritative coordinates. Writes coord_source='admin', which the nightly gov
 * sync is already built to leave alone.
 */
app.post('/api/admin/province-mismatch/:id', requireAdmin, async (req, res) => {
    const { lat, lng } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number' ||
        lat < TH_LAT_RANGE[0] || lat > TH_LAT_RANGE[1] ||
        lng < TH_LNG_RANGE[0] || lng > TH_LNG_RANGE[1]) {
        return res.status(400).json({ error: 'lat/lng must be numbers within Thailand' });
    }
    const flagged = loadMismatchReport().find(r => r.id === req.params.id);
    if (!flagged) {
        return res.status(404).json({ error: 'Not a factory flagged by the province audit' });
    }
    try {
        const result = await pool.query(`
      UPDATE factories
      SET lat = $1, lng = $2,
          coord_source = 'admin', coord_precision = 'exact',
          geom = ST_SetSRID(ST_MakePoint($2, $1), 4326)
      WHERE id = $3
        AND coord_source NOT IN ('admin', 'community')
        AND abs(lat - $4) < 1e-6 AND abs(lng - $5) < 1e-6
      RETURNING id, lat, lng, coord_source
    `, [lat, lng, req.params.id, flagged.lat, flagged.lng]);
        if (result.rowCount === 0) {
            return res.status(409).json({
                error: 'Position already corrected or changed since the audit ran',
            });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error correcting province mismatch:', err);
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
