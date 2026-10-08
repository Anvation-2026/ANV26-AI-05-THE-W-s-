# Deploying SignalTwin

Two parts: the front end (static files) and the back end (a Python service that needs CPU, memory and disk). They are deployed separately and meet at one address, `VITE_API_URL`.

Nothing in this repository creates cloud resources, spends money or holds a secret. Every step below is something a person does.

## Front end on Vercel

The repository root is the Vite app and `vercel.json` already routes every path to `index.html`.

1. Import the repository at vercel.com/new (or `npx vercel login`, then `npx vercel --prod`).
2. Framework preset Vite, build command `npm run build`, output `dist`.
3. To use a back end, add the environment variable `VITE_API_URL` (for example `https://api.example.com`). It is read at build time and is not a secret: it is an address. Without it the app runs entirely in the browser.
4. Redeploy after changing it.

The browser blocks an `http://` back end from an `https://` page, so the back end needs HTTPS.

## Back end

### With Docker

```
cd signaltwin-api
cp .env.example .env        # set ALLOWED_ORIGINS to your front end's address
docker compose up --build
```

`Dockerfile` installs the CPU build of PyTorch, the API, and the small YOLO11n weights, runs as a non-root user, stores data in the `/data` volume and has a health check on `/v1/health`. It has not been built in this repository's own checks (no Docker on the author's machine), so expect to fix small things on first build.

### Sizing

Measured with YOLO11n on 8 CPU cores (`MEASUREMENTS.md`): about 145 ms per processed frame at 1280 px, which is 0.7 times real time. A 10 minute video takes about 14 minutes on that machine. Options, in order of effect: a GPU (`DEVICE=cuda:0`, use the default PyTorch index in the Dockerfile), a lower `TARGET_FPS`, a lower `MAX_PROC_WIDTH`. Memory peaked near 0.6 GB for the worker plus the API; the default memory cap per job is 6 GB.

`WORKERS=1` runs one analysis at a time; more workers need proportionally more CPU and memory. Jobs wait in a queue of `QUEUE_MAX`; beyond that the API answers 429 with `Retry-After`.

### What must be set in production

| Setting | Why |
| --- | --- |
| `ALLOWED_ORIGINS` | Only your front end may call the API from a browser. |
| `API_KEY` | Otherwise anyone who finds the address can upload and analyse. The key is a shared secret, not a login. |
| HTTPS in front of the API | The key and the videos travel over it. A reverse proxy (Caddy, nginx) or the host's TLS is enough. Turn off response buffering for `/v1/jobs/*/events`. |
| A volume for `DATA_DIR` | Videos, results and the job database live there. |
| `RETENTION_HOURS` | How long videos are kept. Match what the Privacy page says. |

Rate limits are kept in memory per process. Behind several containers use the proxy's rate limiting as well.

### Licence

Ultralytics YOLO is AGPL-3.0. See `signaltwin-api/README.md`.

## Supabase (optional)

The default storage is local disk plus SQLite, which is enough for one server. `STORAGE=supabase` keeps records in Postgres and files in Storage buckets, so the data survives the container.

**Nothing has been created.** The migration and the adapter are written and tested against an in-memory stand-in only; they have not been run against a live project. A person should decide whether to create one, because it can cost money:

- A free project is fine for trying this. Free projects pause after a week of inactivity and cap each stored file at 50 MB, so the bucket limit is 50 MB. For longer videos use a paid plan and raise the bucket's file size limit; the standard upload used here suits files up to a few hundred MB, and larger ones need the resumable upload protocol (not implemented).
- Check the plan and price in the Supabase dashboard (or ask Claude to read the cost before creating anything) and confirm before creating.

Steps once a project exists:

1. Apply `signaltwin-api/supabase/migrations/20261009000000_init.sql` (SQL editor, `supabase db push`, or the Supabase MCP `apply_migration`).
2. Run the security and performance advisors in the dashboard and fix anything they report. The migration enables row level security on every table, sets the function's `search_path`, revokes its public execute right, and indexes every foreign key, so the usual warnings should not appear; confirm rather than assume.
3. Set `STORAGE=supabase`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the **server only**. The service role key bypasses row level security: never put it in the front end, the repository or a `VITE_` variable.
4. Start the API. It checks that the schema exists and says so if it does not.

Row level security is on, but with one anonymous owner there are no signed-in users yet. The API reaches the tables with the service role. If accounts are added later the policies already match `auth.uid()`.
