# Kate for KBC

Team Fonske, Tectonic Hackathon 2026, KBC challenge. (README owned by the team: concept, vision and demo story go here.)

Technical details: see [TECHNICAL.md](TECHNICAL.md).

## Run
Requires Node 20+. No dependencies to install.
```
npm start          # prints a random demo passcode; or: DEMO_PASSCODE=... npm start
npm test           # engine, auth/IDOR/CSRF, batch and live-push tests
npm run bench      # scores all 2.3M synthetic customers across all cores
```
Open http://localhost:3000 and log in as a persona (customers c1-c7) or an advisor.
