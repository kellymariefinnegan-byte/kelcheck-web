# KelCheck web

Sign-in, set-password and employee portal for KelCheck (schedule, timecards, profile).
Static files only; served by GitHub Pages at https://kelcheck.kmfenterprisellc.com.

`config.js` holds the Supabase project URL and its public anon key, which is meant to be
public: the database's row-level rules decide what each signed-in person can see.
The source of truth is `kelcheck-web/` in the private Pedestrian repo.
