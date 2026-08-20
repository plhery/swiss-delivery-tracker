-- The direct-delete RPC was added after PostgREST started and can remain
-- invisible until its schema cache is refreshed (PGRST202).
notify pgrst, 'reload schema';
