-- 146 · Enterprise · Marketing posts: LinkedIn @mentions and the link's own preview
-- mentions:     [{ name, urn, kind: "org" | "person", ref? }] — "@name" in the text becomes a LinkedIn mention
--               (marketing-hub › liCommentary) when the post publishes by itself.
-- link_preview: { src, url, title, description, image, site } — the link's Open Graph card (marketing-hub › link_meta),
--               shown in the post preview and sent to LinkedIn as the link card's picture / title.
alter table public.marketing_posts add column if not exists mentions jsonb not null default '[]'::jsonb;
alter table public.marketing_posts add column if not exists link_preview jsonb;
