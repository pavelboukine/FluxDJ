-- The signing statement for a contract with no financial terms. It is client-v1
-- without "including its payment terms", which would be false on such a contract.
-- Release A froze this version on those contracts and left it without wording, so
-- they could not be sent or signed. This file alone turns that on.
--
-- Kept separate because the wording needs product and legal approval before it
-- reaches production: do not apply it until then. Existing versions and recorded
-- signatures are not touched (each signature stores the text it was shown).
create or replace function private.contract_signing_consent(p_version text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_version
    when 'demo-v1' then
      'I have read the agreement shown above. I intend to sign it electronically, and I agree that my typed name and '
      || 'drawn signature are my signature on this agreement.'
    when 'client-v1' then
      'I have read the entire agreement shown above, including its payment terms. I agree to sign it electronically. '
      || 'I agree that my typed name and drawn signature are my signature on this agreement and that they bind me to it '
      || 'as a handwritten signature would. I can download a copy of the signed agreement here, and a copy will be '
      || 'emailed to me.'
    when 'client-no-terms-v1' then
      'I have read the entire agreement shown above. I agree to sign it electronically. '
      || 'I agree that my typed name and drawn signature are my signature on this agreement and that they bind me to it '
      || 'as a handwritten signature would. I can download a copy of the signed agreement here, and a copy will be '
      || 'emailed to me.'
  end;
$$;
