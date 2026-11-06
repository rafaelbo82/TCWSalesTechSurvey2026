# Transformation Starting Lineup: live survey

Attendees scan a QR code, choose a firm type, and spend up to $15 on use cases. Results update live on the big screen.

- `/` is the voting page that phones open.
- `/#results` is the presenter screen, with the QR code, heat map, rankings and firm-type filter.

No voter account is needed. A random ID in the phone's browser lets someone change their lineup, and the same phone never counts twice. Clearing browser data or switching device creates a new response, so treat it as a conference poll and not a controlled ballot.

## Run it locally

Requires Node 18 or newer. There is nothing to install.

    ADMIN_KEY=choose-a-long-secret node server.js

Open http://localhost:3000. The QR code only works for phones once the app is on a public address.

## Deploy it

It needs a host that keeps a long-running process and a persistent disk. Serverless hosts cut off the live stream, and free tiers usually lose the votes on restart.

**Render:** push this folder to a Git repository, then create a Blueprint from it. `render.yaml` sets up the service, a 1 GB disk and a generated admin key.

**Anything that runs Docker:**

    docker build -t lineup-survey .
    docker run -p 3000:3000 -v lineup-votes:/data -e ADMIN_KEY=choose-a-long-secret lineup-survey

Serve it over HTTPS and turn off response buffering for `/api/stream` on any reverse proxy in front of it. The QR code encodes the address the presenter screen was opened on, so open `/#results` from the public URL.

## Password and organizer tools

Everyone enters the survey password once per browser. It defaults to `tcw2026*`; to change it, add a `SURVEY_PASSWORD` setting in Render's Environment tab. Changing it signs everyone out.

At the bottom of the results screen, the **Organizer** panel unlocks with the admin key (`ADMIN_KEY` in Render's Environment tab). It can close and reopen voting, and download the responses and a use-case summary as CSV files that open in Excel. Closing voting keeps the results visible.

## Before the session

Replace `https://your-host` and `$ADMIN_KEY` below.

    # Clear test votes. The old log is archived in the data folder, not deleted.
    curl -X POST -H "x-admin-key: $ADMIN_KEY" https://your-host/api/reset

    # Download every response.
    curl -H "x-admin-key: $ADMIN_KEY" -o responses.csv https://your-host/api/export.csv

## Privacy

The survey asks for no names or contact details. Each response stores the line of business, firm type, picks and submission time.

## Change the questions

Edit `TYPES`, `LOBS`, `LEVELS` and `PILLARS` near the top of the script in `public/index.html`. If you add or remove firm types or lines of business, update `TYPES` or `LOBS` in `server.js` too. If you change the budget, update `BUDGET` in both files.
