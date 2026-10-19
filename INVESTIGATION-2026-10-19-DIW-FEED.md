# DIW feed truncation — investigation findings (t_b5cf60f5)

Run: 2026-10-19, fnm-pm. Every number below comes from a command in this file's
"Commands" section; nothing is quoted from memory.

---

## VERDICT

**None of the three hypotheses holds.** The DIW feed is not shrinking, not
truncated, and the API has not changed. What happened:

1. The feed legitimately serves **two different populations** from the same URL
   — the known two-state behaviour of HANDOFF §12.3 — and the two states are
   served **minutes apart, interleaved within a single nightly run**, not on a
   daily cadence.
2. On 2026-10-09 02:31 ICT the collector happened to catch the **FULL** state
   (274,437 rows). That became `previous` in `collect.py`, so the 0.90 floor
   jumped to 246,993.
3. Every run since (2026-10-10 → 2026-10-19, **10 consecutive nights**) has
   served the **NARROW** state (234,026–234,546 rows, −14.7%) and has therefore
   been rejected. **The guard is behaving exactly as designed.** The archive is
   untouched; last accepted snapshot is 2026-10-09 02:31 ICT.

**Correction to the task premise:** `diw-collector` is *not* failing nightly
since Aug 12. It failed on **11 days** since 2026-08-01: **Aug 12** (one-off
`IncompleteRead` on Business_Location, 4/5 collected — a genuine transport
truncation, correctly surfaced as `fetch_error`) and then **Oct 10–Oct 19** (the
guard rejections above). Aug 13–Oct 9 were 66–68 accepted collections per
endpoint.

**Escalation (DIW semantics — owner decision):** the NARROW state, which is the
endpoint's *steady* state (~23 h/day), omits **40,409 registered factories**,
**90.3 % of them `FFLAG=1` (ดำเนินการ)** and **98.6 % `FACTYPE=3`**. Measured
against DIW's own executive dashboard, the NARROW state validates at **38.7 %**
of DIW's published operating total; the FULL state validates at **90.4 %**
(จำพวก 1: 47 vs 47, exact). So the guard is rejecting the view that disagrees
with DIW's own published numbers — but that is a statement about DIW's export
quality, not proof that one of our components is wrong.

---

## 1. Failure timeline (commands run this turn)

`journalctl -u diw-collector --since "2026-08-01" | grep -E "Failed with result|status=1"` → 11 days:

```
2 Aug 12 02:36:14      2 Oct 15 02:36:53
2 Oct 10 02:38:13      2 Oct 16 02:36:17
2 Oct 11 02:39:25      2 Oct 17 02:32:29
2 Oct 12 02:37:17      2 Oct 18 02:35:39
2 Oct 13 02:35:16      2 Oct 19 02:39:10
2 Oct 14 02:38:04
```

Aug 12 log (`~/app/logs/collector-2026-08-12.log`) — transport failure, not a
guard trip:

```
[ERROR] ❌ Business_Location: download failed: ('Connection broken:
         IncompleteRead(950264 bytes read, 98312 more expected)', ...)
  ✅ Factory_Data: ok (241,437 rows)  … 4/5 collected  … collect.py exit: 1
```

`~/diw-archive/manifest.jsonl` status counts (386 entries, all five endpoints,
2026-08-08 → 2026-10-18):

```
Business_Location            {'ok': 66, 'truncated': 10}
Factory_Data                 {'ok': 68, 'truncated': 10}
Factory_Operation_Permit     {'ok': 67, 'truncated': 10}
Sum_Factory_Local            {'ok': 68, 'truncated': 10}
Sum_Status_Factory_Local     {'ok': 67, 'truncated': 10}
```

All 10 rejections per endpoint are `collected_at` 2026-10-09T19:36Z →
2026-10-18T19:39Z (= local runs **Oct 10–19, 02:31–02:39 ICT**). Before that:
zero rejections.

## 2. Why the guard trips — the baseline latched onto a spike

Accepted timeline for `Factory_Data` (UTC date = local run date − 1 for the
02:30 runs):

```
2026-09-07    237,971      -6      5733d6ee652c
2026-10-05    235,083      +0      67759d67c1b6
2026-10-06    234,901    -182      13431c18c39a
2026-10-07    234,758    -143      c559e120df40      <- last NARROW accepted
2026-10-08    274,437  +39,679     d92cf1e044f8      <- FULL accepted (Oct 9 02:31 local)
```

Rejections since (every night, same story):

```
2026-10-09T19:36Z Factory_Data truncated rows=234,546 prev=274,437
2026-10-10T19:38Z Factory_Data truncated rows=234,444 prev=274,437
…
2026-10-18T19:38Z Factory_Data truncated rows=234,026 prev=274,437
```

Floors: `274,437 × 0.90 = 246,993` (detail endpoints) and
`217,661 × 0.90 = 195,894` (Sum endpoints). NARROW today is −14.7 % / −17.7 %
below those. `MIN_ROW_RATIO = 0.90` and `collect.py` are **unchanged**.

The NARROW state itself is not collapsing — it declines smoothly, the long-run
drift HANDOFF §4 already documented (~−105 rows/day):

```
2026-08-08 241,588 → 2026-09-01 238,860 → 2026-10-01 235,165 → 2026-10-19 234,026
Sum_*:      186,344 →                183,730 → 180,159      → 179,063
```

## 3. Not a truncated / paginated response

Fresh `Factory_Data` fetch (2026-10-19 04:16 UTC), headers verbatim:

```
HTTP/1.1 200 OK
Transfer-Encoding: chunked
Content-Type: text/csv; charset=utf-8
Server: Microsoft-IIS/10.0
X-Powered-By: PHP/8.2.29
Content-Disposition: attachment; filename="Factory_Data.csv"
```

* No `Content-Length`, no `ETag`, no `Last-Modified` — same as measured
  2026-08-08. With chunked encoding a cut body raises (that is exactly the
  Aug 12 `IncompleteRead`), it does not arrive as a shorter valid file.
* Fresh payload: **157,922,759 B**, ends with `\n`, **all 234,026 records have
  exactly 46 fields**, header byte-identical to the 2026-10-08 FULL snapshot.
* **7 consecutive fetches today produced the same sha256
  `74c687fd8553…`** (6 in a row within 2 minutes + the 04:16 fetch), and the
  same byte count as the collector's 02:38 fetch (157,922,759 B) — the two
  differ only in hash, i.e. minor content drift of equal length (the nightly
  `LAST_UPDATE` re-stamp), not row count.
* 31 successful samples today across all five endpoints (04:16–04:44 UTC =
  11:16–11:44 ICT): 7 Factory_Data, 18 Sum_Factory_Local, 2 each of the other
  three — **every one NARROW**. One further request failed with
  `curl: (52) Empty reply from server` — the server drops connections
  occasionally; that is a *second*, rarer failure mode and it is loud, not
  silent.

## 4. Not an API change

Same URL + `?download_all=1`, same header set, same 46 columns, and shared rows
are identical to the 2026-10-08 FULL snapshot field-for-field:

```
compared 2,000 shared FACREGs: rows differing at all = 1999
  differing columns: {'LAST_UPDATE': 1999}
```

## 5. Not a registry shrink — the FULL state was served *today*, 27 min later

Same night, same host, same ETL stamp:

| local time (ICT) | endpoint | rows | state |
|---|---|---:|---|
| 02:38:18 | Factory_Data | 234,026 | NARROW |
| 03:04:47 | Factory_Data | 234,026 | NARROW |
| 03:05:51 | Business_Location | **274,436** | FULL |
| 03:06:46 | Factory_Operation_Permit | **274,436** | FULL |
| 03:07:14 | Sum_Factory_Local | **217,660** | FULL |
| 03:07:40 | Sum_Status_Factory_Local | **217,660** | FULL |
| 11:16–11:44 | all five (31 samples) | 234,026 / 179,063 | NARROW |

Both states carry the **same** `last_update = 2026-10-18`: the FULL payload is
not a stale cache copy — `factory_statistics` (swapped in from the 03:07 fetch)
holds `last_update='2026-10-18'` on 426,510 of 435,320 rows.

A registry cannot lose and regain 40,410 factories in 27 minutes.

## 6. The two populations, quantified

```
high ids 269,896  low(Oct7) ids 230,217  now ids 229,488
oscillating population (in high, absent from Oct7-low AND now): 39,679
attrition since Oct7 low (in Oct7-low, gone now): 730
new since Oct7 low (in now, not in Oct7-low): 1
now subset of high? missing=40,409 extra=1
```

So NARROW ⊂ FULL, membership is stable (730 out / 1 in over 12 days), and the
same ~39.7k factories are excluded on every NARROW night.

Who is excluded (`FFLAG × FACTYPE`, FULL → today):

```
 FFLAG  FACTYPE      high     today   missing   miss%
     2        3    99,538    99,412       126    0.1%
     1        3    60,464    24,532    35,932   59.4%   <- ดำเนินการ, จำพวก 3
     2        1    58,255    58,255         0    0.0%
     2        2    44,281    44,279         2    0.0%
     0        3     6,100     3,835     2,265   37.1%
     1        2     3,293     2,729       564   17.1%
     3        3     2,432       926     1,506   61.9%
     1        1       47        40         7   14.9%
     3        2        27        18         9   33.3%
```

Profile of the 40,409 excluded vs the 229,488 kept:

```
                       MISSING   PRESENT
  has LAT/LNG            63.3%    27.3%
  has POKDATE            99.9%    95.6%
  has STARTDATE          94.3%    67.0%
  has TRADATE            67.0%    29.1%
  TOTAL_CAP == 0          1.3%     5.1%
province missing-rate: ระยอง 41.7%  พระนครศรีอยุธยา 42.3%  ปราจีนบุรี 41.4%
                       กรุงเทพมหานคร 6.6%  นครราชสีมา 8.1%
```

The excluded rows are the *better documented* ones (coordinates, start dates,
capital) — i.e. the operating fleet, not dead records.

## 7. Which view matches DIW's own numbers (escalation)

`http://reg.diw.go.th/executive/thailand3.asp`, fetched today
("ข้อมูลสรุปในภาพรวมของประเทศไทย ณ วันที่ 18 พ.ค. 69"):

```
ในนิคมอุตสาหกรรม              5,876
โรงงานจำพวกที่ 1 (นอกนิคมฯ)      47
โรงงานจำพวกที่ 2 (นอกนิคมฯ)   3,347
โรงงานจำพวกที่ 3 (นอกนิคมฯ)  67,179
รวมทั้งสิ้น                    76,449     → นอกนิคมฯ = 70,573
```

`FFLAG=1` (ดำเนินการ) counts by `FACTYPE`:

| view | จำพวก 1 | จำพวก 2 | จำพวก 3 | total | vs 70,573 |
|---|---:|---:|---:|---:|---:|
| FULL (274,437) | **47** | 3,293 | 60,464 | **63,804** | **90.4 %** |
| NARROW (234,026) | 40 | 2,729 | 24,532 | **27,303** | **38.7 %** |

HANDOFF §4 measured 33,696 = 47 % on 2026-08-13 — also a NARROW night. Same
conclusion as §4: *the feed is a narrowing view, not ground truth.*

## 8. Downstream impact (pipeline.py has no equivalent guard)

`server/sync/pipeline.py` floors are absolute: `MIN_EXPECTED_PERMITS = 100_000`,
`MIN_EXPECTED_STATISTICS = 100_000` — **both states pass**, so the pipeline
ingests whichever state arrives and the atomic-swap tables flip nightly:

```
date       Factory_Data  Business_Location  permits promoted  statistics promoted
2026-10-13      274,439            234,401          234,401   179,418,179,418
2026-10-15      234,269            234,269          234,269   179,293,179,293
2026-10-17      274,436            234,027          234,027   179,064,179,064
2026-10-18      234,027            234,027          234,027   179,064,214,531   <- third value
2026-10-19      234,026            274,436          274,436   217,660,217,660
```

The 2026-10-18 `214,531` is neither NARROW (179,064) nor FULL (217,660) — an
**intermediate count**, i.e. a read of a table while it is being rebuilt. That
is the strongest single piece of evidence for the mechanism below.

DB right now (read-only `psql`): `factories 274,444` · `permits 274,436` ·
`factory_statistics 435,320` · `factories.last_seen_in_feed = 2026-10-18` on
274,436 rows (5 NULL, 3 stale at 2026-10-14).

## 9. Mechanism (hypothesis, to be confirmed tonight)

Leading hypothesis: the export table is **rebuilt nightly around 03:00 ICT**.
Requests landing inside the rebuild window see FULL / intermediate counts;
requests outside it see the post-rebuild NARROW state.

Supporting: FULL appears in the pipeline's sync log roughly every other night
since 2026-08-09 (e.g. `2026-08-09 FD=274,418 BL=241,562` — opposite states in
one run); the collector (02:30–02:39) caught FULL only once, 2026-10-09; the
pipeline (03:04–03:13) alternates; the 214,531 intermediate read; and 31 samples
outside that window today were all NARROW.

Ruled out as request-side factors: User-Agent (curl vs python-requests),
`Cache-Control/Pragma: no-cache`, cache-busting query parameter — 5/5 stayed
NARROW. DNS returns a single A record (`202.139.203.66`).

**Canary installed for tonight** to pin the window: `~/app/diw_canary.sh`
(user crontab `10 2 20 10 *`, self-removing), samples `Sum_Factory_Local`
every 180 s from **02:10 → 03:45 ICT on 2026-10-20** into
`~/app/logs/diw-canary-2026-10-20.log` (~29 samples, ~1 GB). `--once` smoke
test passed: `rc=0 http=200 bytes=34628586 rows=179063 dt=4s`.

## 10. Constraints honoured

* `collect.py` / `MIN_ROW_RATIO` **not modified** — no floor raised or lowered.
* `SYNC_DEACTIVATE` untouched (still `dry`); `pipeline.py` was never run.
* All DB access read-only `psql`; no rows written; citizen DB not touched.
* DIW archive untouched — last accepted blob remains 2026-10-09 02:31 ICT.
* No repo file edited; no service restarted (the four systemd units untouched).
* Only additions on sev01: `~/app/diw_canary.sh`, one self-removing user
  crontab line, and throwaway probes under `/tmp`.

## 11. Options for the owner (1-3-1)

1. **Status quo + evidence (recommended first step).** Leave the guard as-is.
   The nightly exit-1 is correct signalling; the archive stays at the last
   complete snapshot; the canary tonight tells us exactly when the FULL state
   is served.
2. **Move the collector into the FULL window** (`diw-collector.timer` 02:30 →
   ~03:05). Cheap, no code change, but the window shifts night to night and
   per endpoint, so it will still miss sometimes. Choose only after the canary
   log shows a stable window.
3. **Two-state baseline in `collect.py`** (accept if within ±1 % of *either*
   recent state). This is the technically correct fix for a two-state feed, but
   it is by definition changing the floor — explicitly out of scope for this
   task and needs your sign-off.

Separately: **DIW semantics** (why ~40k operating factories vanish from the
steady-state export while DIW's dashboard counts them) should go to DIW —
their dashboard publishes the contact 02-430-6316 ต่อ 2504 กรณีข้อมูลไม่ถูกต้อง.

---

## Commands

```bash
ssh sev01 'journalctl -u diw-collector --since "2026-08-01" --no-pager | grep -E "Failed with result|status=1"'
ssh sev01 'cat ~/app/logs/collector-2026-08-12.log'
ssh sev01 'env -u PYTHONPATH -u VIRTUAL_ENV python3 /tmp/manifest_summary2.py'   # manifest.jsonl status + rejections
ssh sev01 'env -u PYTHONPATH -u VIRTUAL_ENV python3 /tmp/diff_high_low.py'       # FULL vs NARROW id diff
ssh sev01 'env -u PYTHONPATH -u VIRTUAL_ENV python3 /tmp/profile2.py'            # FFLAG×FACTYPE + LAST_UPDATE stamps
ssh sev01 'env -u PYTHONPATH -u VIRTUAL_ENV python3 /tmp/profile3.py'            # excluded-row profile
ssh sev01 'env -u PYTHONPATH -u VIRTUAL_ENV python3 /tmp/integrity.py'           # payload completeness + field diff
ssh sev01 'curl -sS -D /tmp/fd_headers.txt -o /tmp/fd_now.csv "...Factory_Data_CSV.php?download_all=1"'
ssh sev01 'bash /tmp/probe.sh 6'; ssh sev01 'bash /tmp/probe_eps.sh'; ssh sev01 'bash /tmp/probe_matrix.sh'
ssh sev01 'bash /tmp/db_probe.sh'; ssh sev01 'bash /tmp/db_probe2.sh'            # read-only psql
for f in ~/app/logs/sync-2026-*.log; do grep -oE "Promoted [0-9]+ rows into permits" …; done
```

Scripts used are in this task's workspace under `diw/`.
