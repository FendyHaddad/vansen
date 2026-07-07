-- Security hardening (applied 2026-07-07): size/length ceilings enforced at the
-- database so no future backend bug can bloat or abuse storage.
alter table public.generations add constraint generations_prompt_len check (char_length(prompt) <= 2000);

alter table public.generations add constraint generations_settings_size check (pg_column_size (settings) <= 4096);

alter table public.profiles add constraint profiles_prefs_size check (pg_column_size (prefs) <= 4096);

alter table public.profiles add constraint profiles_display_name_len check (
  display_name is null
  or char_length(display_name) <= 80
);

alter table public.ledger_entries add constraint ledger_note_len check (
  note is null
  or char_length(note) <= 200
);
