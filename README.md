# Study Book Finder

A web app that helps students find textbooks and course reading. Search by title, author or topic, filter by language and availability, sort the results, and keep a personal reading list.

- **Demo video (max 2 min):** `<ADD YOUR VIDEO LINK>`
- **Live app (through the load balancer):** http://18.132.52.35
- **Web01:** http://35.177.168.238 | **Web02:** http://3.8.119.54
- **Login:** none required. The API key is given in the submission comment.

## Features

- Search Google Books by title, author or topic
- Filters: language, availability (free e-books, e-books, fully viewable, preview available)
- Sorting: best match and newest first (done by the API), highest rated and title A to Z (done on the current page)
- "Narrow these results" box to filter the current page by title or author
- Pagination (12 books per page)
- Reading list saved in the browser (`localStorage`)
- Clear error messages: empty search, no results, API down or slow, quota reached, invalid key, server unreachable (each with a "Try again" button where it helps)
- The footer and the `X-Served-By` response header show which server handled the request

## API used

**Google Books API** by Google: https://developers.google.com/books/docs/v1/using

Endpoint used: `GET https://www.googleapis.com/books/v1/volumes` with `q`, `langRestrict`, `filter`, `orderBy`, `startIndex`, `maxResults` and `key`.

The browser never talks to Google directly. It calls this app's `/api/books`, and the Node server adds the API key. The key lives only in a `.env` file on the server and is excluded from Git.

## Run locally

Requirements: Node.js 18 or newer.

1. Get an API key: Google Cloud Console, create a project, enable **Books API**, then Credentials, **Create API key**.
2. Clone and install:
   ```bash
   git clone https://github.com/Landry-irakoze/study-book-finder.git
   cd study-book-finder
   npm install
   ```
3. Create your environment file and paste your key after `GOOGLE_BOOKS_API_KEY=`:
   ```bash
   cp .env.example .env
   ```
4. Start the app:
   ```bash
   npm start
   ```
5. Open http://localhost:3000

## Project structure

```
server.js            Express server: validation, cache, rate limit, Google Books proxy
public/              Frontend (index.html, style.css, app.js)
deploy/              nginx, systemd and HAProxy configs used for deployment
.env.example         Template for secrets (copy to .env)
```

## Deployment

Repeat these steps on **Web01** (`SERVER_ID=web-01`) and **Web02** (`SERVER_ID=web-02`).

1. Connect with SSH, then install Node.js 20, nginx, git and nano:
   ```bash
   sudo cp -r /etc/nginx ~/nginx-backup        # backup of the old nginx config
   sudo apt update && sudo apt install -y nginx git nano
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```
2. Get the code and install the dependencies:
   ```bash
   sudo git clone https://github.com/Landry-irakoze/study-book-finder.git /var/www/study-book-finder
   sudo chown -R ubuntu:ubuntu /var/www/study-book-finder
   cd /var/www/study-book-finder && npm install --omit=dev
   ```
3. Create the environment file with the real key:
   ```bash
   cp .env.example .env
   nano .env        # set GOOGLE_BOOKS_API_KEY and SERVER_ID (web-01 or web-02)
   chmod 600 .env
   ```
4. Run the app as a systemd service so it restarts on failure and on reboot:
   ```bash
   sudo cp deploy/study-book-finder.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now study-book-finder
   sudo systemctl status study-book-finder --no-pager
   ```
5. Put nginx in front of it on port 80. The site config sets one `X-Served-By` header to the server hostname:
   ```bash
   sudo cp deploy/nginx-site.conf /etc/nginx/sites-available/study-book-finder
   sudo rm -f /etc/nginx/sites-enabled/*
   sudo ln -s /etc/nginx/sites-available/study-book-finder /etc/nginx/sites-enabled/study-book-finder
   sudo nginx -t && sudo systemctl reload nginx
   ```
6. Check it works: `curl -i http://localhost/api/health` should return `200`, an `X-Served-By` header, and `{"status":"ok","server":"web-01"}` (or `web-02`).

## Load balancer (Lb01, HAProxy)

1. Connect to Lb01 (18.132.52.35). Install HAProxy if it is missing: `sudo apt update && sudo apt install -y haproxy`.
2. Back up the current config:
   ```bash
   sudo cp /etc/haproxy/haproxy.cfg ~/haproxy.cfg.bak
   ```
3. Open `/etc/haproxy/haproxy.cfg`, keep the `global` and `defaults` sections, remove any older `frontend` that already binds port 80 (two frontends cannot share a port), and add the contents of `deploy/haproxy.cfg` at the end:
   ```
   frontend study_books_front
       bind *:80
       mode http
       default_backend study_books_back

   backend study_books_back
       mode http
       balance roundrobin
       option forwardfor
       option httpchk GET /api/health
       http-check expect status 200
       server web-01 35.177.168.238:80 check
       server web-02 3.8.119.54:80 check
   ```
4. Validate and restart:
   ```bash
   sudo haproxy -c -f /etc/haproxy/haproxy.cfg
   sudo systemctl restart haproxy
   ```

How it works: HAProxy listens on port 80 and distributes requests to both web servers with `roundrobin`. `option httpchk GET /api/health` removes a server from rotation if its health check fails, so the app stays up if one server goes down. `option forwardfor` passes the real client IP, which the app uses for rate limiting.

### Test the balancing

```bash
for i in 1 2 3 4 5 6; do curl -sI http://18.132.52.35/api/health | grep -i x-served-by; done
```

Expected output alternates between `7396-web-01` and `7396-web-02`. To test failover, run `sudo systemctl stop study-book-finder` on one web server and repeat: all responses should come from the other server. Start the service again afterwards.

## Security

- API key is stored only in `.env` (git-ignored) and never sent to the browser
- The key is restricted to the Books API in Google Cloud
- Input validation with whitelists for language, filter, sort and page position; search text limited to 100 characters
- Results are rendered with `textContent`, never `innerHTML`, which prevents XSS from book data
- Content Security Policy and other security headers on every response
- Per-IP rate limit on the API (60 requests per minute)
- Only `https://` links from the API are used for covers and book pages

## Performance

Each server keeps a 5-minute in-memory cache of Google Books responses, which reduces API calls and speeds up repeated searches. The `X-Cache` header shows `HIT` or `MISS`. Caches are per server, so the first search on each server is always a miss.

## Challenges and how I solved them

- **Keeping the API key secret.** The key must not reach the browser or GitHub. I proxied all Google Books requests through the Express server, kept the key in a git-ignored `.env`, and checked `git status` before pushing.
- **Google Books cannot sort by rating or title.** Only relevance and newest are supported by the API, so I sorted the current page in the browser and labeled those options "this page".
- **SSH keys lived in a different environment.** My deployment key was in the ALU sandbox, not on my laptop, so SSH from my laptop failed with `Permission denied (publickey)`. I ran all server work from the sandbox instead.
- **Missing tools and pasted commands on the servers.** `nano` was not installed and a pasted heredoc broke because of leading spaces. I wrote the `.env` with `printf` and added `nano` to the install step.
- **An older HAProxy config was already using port 80.** It redirected HTTP to HTTPS and did not match this app. I backed up the config, removed the old port 80 frontend, and added the new frontend and backend with a `/api/health` check.

## Credits

- [Google Books API](https://developers.google.com/books) by Google
- [Express](https://expressjs.com/) and [dotenv](https://github.com/motdotla/dotenv)
- Fonts: [Bricolage Grotesque](https://fonts.google.com/specimen/Bricolage+Grotesque) and [Literata](https://fonts.google.com/specimen/Literata) via Google Fonts
- nginx, HAProxy and systemd for deployment
