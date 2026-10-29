-- Apply through Supabase apply_migration, name: vignette_collection_backend.
-- This is a source SQL file, not a hand-named Supabase CLI migration.
begin;

create table public.vignette_studies (
  study_id text not null check (study_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  version text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  active boolean not null default false,
  is_test boolean not null default false,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (study_id, version),
  check (octet_length(manifest::text) <= 131072)
);

create table public.vignette_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  study_id text not null,
  version text not null,
  condition_id text not null,
  is_test boolean not null,
  manifest_snapshot jsonb not null check (jsonb_typeof(manifest_snapshot) = 'object'),
  started_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  foreign key (study_id, version) references public.vignette_studies(study_id, version),
  unique (id, study_id, version, condition_id, is_test, started_at),
  check (expires_at > started_at)
);

create index vignette_sessions_study_idx on public.vignette_sessions(study_id, version);

create table public.vignette_responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique,
  study_id text not null,
  version text not null,
  condition_id text not null,
  is_test boolean not null,
  consent boolean not null check (consent),
  answers jsonb not null check (jsonb_typeof(answers) = 'object'),
  answer_hash text not null check (answer_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null,
  submitted_at timestamptz not null default clock_timestamp(),
  server_duration_seconds integer generated always as
    (floor(extract(epoch from (submitted_at - started_at)))::integer) stored,
  foreign key (session_id, study_id, version, condition_id, is_test, started_at)
    references public.vignette_sessions(id, study_id, version, condition_id, is_test, started_at),
  check (submitted_at >= started_at),
  check (octet_length(answers::text) <= 65536)
);

create index vignette_responses_study_idx on public.vignette_responses(study_id, version, is_test);

alter table public.vignette_studies enable row level security;
alter table public.vignette_sessions enable row level security;
alter table public.vignette_responses enable row level security;

-- No client role has table privileges or RLS policies. Only the Edge Function's
-- server-side service credential may access these tables. Researchers use the
-- authenticated Supabase dashboard/SQL editor, never a public export endpoint.
revoke all on public.vignette_studies, public.vignette_sessions,
  public.vignette_responses from public, anon, authenticated, service_role;
grant select on public.vignette_studies to service_role;
grant select, insert on public.vignette_sessions, public.vignette_responses to service_role;

-- No real questionnaire is registered here: original items have not yet been
-- recovered. This unmistakably named one-question fixture is deployment-only.
insert into public.vignette_studies(study_id, version, active, is_test, manifest)
values (
  'deployment-smoke-test', 'DEPLOYMENT_SMOKE_TEST_1', false, true,
  '{"title":"部署连通性测试（非科研问卷）","conditions":[{"id":"TEST_ONLY","vignette":"此内容仅用于检查部署，不属于真实研究材料。"}],"fields":[{"id":"test_question","label":"部署自检值","type":"integer","min":1,"max":7,"required":true}]}'::jsonb
);

commit;
