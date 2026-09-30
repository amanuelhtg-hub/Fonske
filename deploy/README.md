# Deploy Kate to Cloud Run

Nothing secret is committed. Replace the placeholders, run the commands from the repo root.

```bash
export PROJECT_ID=<your-project-id>          # from the hackathon credentials page
export REGION=us-central1
gcloud config set project $PROJECT_ID

# 1. APIs (once)
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com aiplatform.googleapis.com

# 2. Secrets (once). SESSION_SECRET signs cookies, DEMO_PASSCODE is the demo login.
openssl rand -hex 32 | gcloud secrets create kate-session-secret --data-file=-
printf '%s' '<choose-a-passcode>' | gcloud secrets create kate-demo-passcode --data-file=-

# 3. Let the Cloud Run runtime account read the secrets and call Vertex AI
SA=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com
for r in roles/secretmanager.secretAccessor roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$SA --role=$r
done

# 4. Verify the Gemini model ID BEFORE enabling KATE_AI (a 200 with "candidates" means it works here)
export KATE_AI_MODEL=<gemini-flash-model-id>
curl -s -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" -H 'Content-Type: application/json' \
  "https://$REGION-aiplatform.googleapis.com/v1/projects/$PROJECT_ID/locations/$REGION/publishers/google/models/$KATE_AI_MODEL:generateContent" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Say ok"}]}]}'

# 5. Deploy (builds the Dockerfile with Cloud Build)
gcloud run deploy kate --source . --region $REGION --allow-unauthenticated \
  --max-instances=1 --min-instances=1 --timeout=3600 \
  --set-secrets=SESSION_SECRET=kate-session-secret:latest,DEMO_PASSCODE=kate-demo-passcode:latest \
  --set-env-vars=SECURE_COOKIES=1,TRUST_PROXY=1,KATE_AI=on,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$REGION,KATE_AI_MODEL=$KATE_AI_MODEL
```

Leave out `KATE_AI=on` (or set `KATE_AI=off`) for template wording only. Kill switch without a rebuild:
`gcloud run services update kate --region $REGION --update-env-vars=KATE_AI=off`.

## Why `--max-instances=1`
Customer state (events, consent, dismissed cards) lives in process memory and live updates are pushed over
Server-Sent Events from the instance that holds that state. A second instance would have its own copy of the
state, so a customer could see different cards per request and never receive pushes triggered on the other
instance. `--min-instances=1` avoids cold starts (and a reset of the in-memory state) during the demo;
`--timeout=3600` lets SSE connections live up to an hour (the browser reconnects automatically after that).
Scaling out would need a shared store (e.g. Firestore/Redis) and pub/sub for the streams.

## Notes
- `PORT` is set by Cloud Run; the Dockerfile sets `HOST=0.0.0.0`. Health check: `GET /api/healthz`.
- `TRUST_PROXY=1` makes the login throttle use the client address from `X-Forwarded-For` (the last entry, which the Google front end appends; earlier entries are client-supplied). Without it every visitor shares the proxy address.
- Local container test: `docker build -t kate . && docker run --rm -p 8080:8080 -e DEMO_PASSCODE=demo kate`.
- The hackathon project's credentials expire after one week.
