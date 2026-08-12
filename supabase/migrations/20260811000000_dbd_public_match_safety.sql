-- Probable automated matches have not yet been independently human-validated.
-- Publishing them as ownership facts creates avoidable attribution risk. Keep
-- exact legal-form + normalized-name matches public; allow probable/ambiguous
-- matches only after a reviewer records a decision in verified_by.
create or replace view dbd.factory_owner as
select
  f.id            as factory_id,
  f.name          as factory_name,
  f.province      as factory_province,
  m.jp_no,
  j.jp_name,
  j.jp_type_desc,
  j.jp_status_desc,
  j.register_capital,
  j.province      as registered_province,
  m.outcome       as match_outcome,
  m.verified_by is not null as human_verified
from public.factories f
join public.businesses b on b.id = f.business_id
join dbd.operator_match m on m.business_id = b.id
join dbd.juristic j on j.jp_no = m.jp_no
where m.outcome = 'exact' or m.verified_by is not null;

comment on view dbd.factory_owner is
  'Public factory-owner links: exact automated matches plus any human-verified override. Probable automated matches remain private until reviewed.';

grant select on dbd.factory_owner to anon, authenticated;
