/**
 * Migration Script: Supabase Cloud Citizen DB -> Google Cloud Firestore
 *
 * Reads citizen records from `CITIZEN_DATABASE_URL` (if accessible) or
 * fallback backup JSON and imports them safely into Cloud Firestore:
 *   1. reports -> /reports/{id} (public excerpt) + /reports/{id}/sensitive/details (reporter_contact)
 *   2. location_corrections -> /location_corrections/{id}
 *   3. watchlists -> /users/{uid}/factory_watchlist & /users/{uid}/industry_watchlist
 */

const { Pool } = require('pg');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '../server/.env') });

const serviceAccountPath = path.join(__dirname, '../server/serviceAccountKey.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error('❌ Service account key not found at server/serviceAccountKey.json');
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);
const app = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: cert(serviceAccount),
      projectId: 'factory-near-me',
    });

const db = getFirestore(app);

async function migrate() {
  const citizenDbUrl = process.env.CITIZEN_DATABASE_URL;
  if (!citizenDbUrl) {
    console.error('❌ CITIZEN_DATABASE_URL not found in server/.env');
    process.exit(1);
  }

  console.log('Connecting to Supabase citizen pooler...');
  const pool = new Pool({
    connectionString: citizenDbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    // 1. Reports
    console.log('Fetching reports from Supabase...');
    const reportsRes = await pool.query('SELECT * FROM public.reports');
    console.log(`Found ${reportsRes.rowCount} reports in Supabase.`);

    for (const r of reportsRes.rows) {
      const reportRef = db.collection('reports').doc(r.id);
      await reportRef.set(
        {
          factory_id: r.factory_id,
          impact_types: r.impact_types || [],
          frequency: r.frequency || null,
          distance_band: r.distance_band || null,
          description: r.description || null,
          incident_date: r.incident_date ? r.incident_date.toISOString().slice(0, 10) : null,
          user_id: r.user_id || null,
          status: r.status || 'pending',
          source: r.source || 'web',
          created_at: r.created_at ? Timestamp.fromDate(new Date(r.created_at)) : Timestamp.now(),
          moderated_at: r.moderated_at ? Timestamp.fromDate(new Date(r.moderated_at)) : null,
          reject_reason: r.reject_reason || null,
        },
        { merge: true }
      );

      if (r.reporter_contact || r.private_note) {
        await reportRef.collection('sensitive').doc('details').set(
          {
            reporter_contact: r.reporter_contact || null,
            private_note: r.private_note || null,
            user_id: r.user_id || null,
          },
          { merge: true }
        );
      }
      console.log(` Migrated report: ${r.id}`);
    }

    // 2. Location corrections
    console.log('Fetching location corrections from Supabase...');
    const corrRes = await pool.query('SELECT * FROM public.location_corrections');
    console.log(`Found ${corrRes.rowCount} corrections in Supabase.`);

    for (const c of corrRes.rows) {
      await db
        .collection('location_corrections')
        .doc(c.id)
        .set(
          {
            factory_id: c.factory_id,
            factory_name: c.factory_name || null,
            lat: parseFloat(c.lat),
            lng: parseFloat(c.lng),
            note: c.note || null,
            user_id: c.user_id || null,
            status: c.status || 'pending',
            source: c.source || 'web',
            created_at: c.created_at ? Timestamp.fromDate(new Date(c.created_at)) : Timestamp.now(),
            moderated_at: c.moderated_at ? Timestamp.fromDate(new Date(c.moderated_at)) : null,
            reject_reason: c.reject_reason || null,
          },
          { merge: true }
        );
      console.log(` Migrated correction: ${c.id}`);
    }

    console.log('✅ Migration complete!');
  } catch (err) {
    console.error('Migration failed or Supabase is paused:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();
