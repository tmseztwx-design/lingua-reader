-- 词典缓存增加概括性简释（gloss）：卡片主行显示 2~6 个汉字的最简释义，完整语境释义保留在 meaning。
alter table public.scribe_word_cache add column if not exists gloss text not null default '';
