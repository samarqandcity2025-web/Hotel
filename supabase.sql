-- Mehmonxona tizimi uchun jadvallar.
-- Supabase -> SQL Editor -> New query -> shu matnni qo'yib "Run" bosing (bir marta).

create table if not exists kv (
  key      text primary key,
  value    jsonb  not null,
  ver      bigint not null default 1,
  next_due bigint not null default 0
);

create table if not exists history (
  id         bigserial primary key,
  ts         bigint not null,
  cleaner_id int,
  data       jsonb  not null
);
create index if not exists history_cleaner_idx on history (cleaner_id, id desc);

create table if not exists notifications (
  id      bigserial primary key,
  to_id   int     not null,
  ts      bigint  not null,
  level   text,
  text    text    not null,
  task_id int,
  read    boolean not null default false
);
create index if not exists notifications_to_idx on notifications (to_id, id desc);

-- Tashqaridan to'g'ridan-to'g'ri kirishni yopish (faqat server kaliti bilan ishlaydi)
alter table kv            enable row level security;
alter table history       enable row level security;
alter table notifications enable row level security;
