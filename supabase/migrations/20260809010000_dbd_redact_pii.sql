-- Strip personal identifiers already stored, and stop exposing raw publicly.
--
-- DBD returns each director's 13-digit national ID as `cmtNo`, along with home
-- address and phone. Director *names* are public record and are the point of
-- this dataset; their national ID numbers are not, and a public factory map
-- must not become a place to look them up.
update dbd.committee
set raw = raw - 'cmtNo' - 'address' - 'phoneNo' - 'zipCode' - 'tumbonCode' - 'ampurCode' - 'pvCode'
where raw ?| array['cmtNo','address','phoneNo','zipCode','tumbonCode','ampurCode','pvCode'];

update dbd.shareholder
set raw = raw - 'cmtNo' - 'address' - 'phoneNo' - 'zipCode' - 'tumbonCode' - 'ampurCode' - 'pvCode'
where raw ?| array['cmtNo','address','phoneNo','zipCode','tumbonCode','ampurCode','pvCode'];

-- Revoke the blanket table grants: `raw` is a debugging aid, not a public
-- column, and granting the table grants every column now and in future.
revoke select on dbd.committee, dbd.shareholder from anon, authenticated;

-- Publish only the columns that are genuinely public record.
create or replace view dbd.company_people as
select jp_no, seq, full_name, title as role_code from dbd.committee;

create or replace view dbd.company_shareholders as
select jp_no, seq, holder_name, nationality, share_amount, share_percent from dbd.shareholder;

grant select on dbd.company_people, dbd.company_shareholders to anon, authenticated;
