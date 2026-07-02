create table profiles (
  id uuid references auth.users primary key,
  name text, email text, weight numeric, height numeric,
  goal text, birthdate text, occupation text, gym_days int,
  role text default 'client',
  created_at timestamp default now()
);

create table chat_messages (
  id bigserial primary key,
  user_id uuid references auth.users,
  mode text, role text, content text,
  created_at timestamp default now()
);

create table food_diary (
  id bigserial primary key,
  user_id uuid references auth.users,
  date text, name text,
  kcal numeric, p numeric, c numeric, f numeric,
  created_at timestamp default now()
);

create table food_goals (
  user_id uuid references auth.users primary key,
  kcal numeric, p numeric, c numeric, f numeric,
  updated_at timestamp default now()
);

alter table profiles enable row level security;
alter table chat_messages enable row level security;
alter table food_diary enable row level security;
alter table food_goals enable row level security;

create policy "Users see own profile" on profiles for all using (auth.uid() = id);
create policy "Users see own messages" on chat_messages for all using (auth.uid() = user_id);
create policy "Users see own diary" on food_diary for all using (auth.uid() = user_id);
create policy "Users see own goals" on food_goals for all using (auth.uid() = user_id);
