alter table lab.experiments add column if not exists request_id uuid;
create unique index if not exists experiments_requests on lab.experiments(user_id,request_id,mode) where request_id is not null;
