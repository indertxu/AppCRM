-- 159 · Your LinkedIn on your profile (Enterprise; additive)
-- Settings › Your account: your LinkedIn page's link, kept with your details. ("Use my LinkedIn photo" takes the
-- picture through Sign In with LinkedIn — the profile-photo edge function — not from this link.)
alter table public.profiles add column if not exists linkedin_url text;
