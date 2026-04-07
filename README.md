# Betbridge
Codeswapping website 
Convert betting codes between **SportyBet** and **Stake** — free, no account needed.

## Live Demo
Deploy once → get a free public URL anyone can use.

---

## 🚀 Deploy FREE on Render (5 minutes)

### Step 1 — Put the code on GitHub
1. Create a free account at [github.com](https://github.com)
2. Create a new repository (e.g. `betbridge`)
3. Upload all these files into it (drag & drop in the browser)

### Step 2 — Deploy on Render
1. Create a free account at [render.com](https://render.com)
2. Click **New → Web Service**
3. Connect your GitHub account and select your `betbridge` repo
4. Fill in:
   - **Name**: `betbridge` (or anything you like)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free`
5. Click **Create Web Service**

Render will build and deploy. In ~2 minutes you'll get a URL like:
```
https://betbridge.onrender.com
```
Share that link with anyone — it works on any phone or browser.

> **Note**: Free Render instances sleep after 15 min of inactivity. First visit after sleep takes ~30s to wake up. Upgrade to Starter ($7/mo) to keep it always-on.

---

## Alternative: Deploy on Railway
1. Go to [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. It auto-detects Node.js — no config needed
4. Free hobby plan included

---

## Run Locally
```bash
npm install
npm start
# Open http://localhost:3000
```

---

## Project Structure
```
betbridge/
├── server.js          # Express backend (API proxy + conversion)
├── public/
│   └── index.html     # Frontend UI
├── package.json
└── README.md
```

## API Endpoints
- `GET /api/sportybet-to-stake?code=YOURCODE`
- `GET /api/stake-to-sportybet?code=YOURCODE`
- `GET /api/health`

---

## Roadmap
- [ ] Add more African bookies (Bet9ja, Betway, 1xBet)
- [ ] Deep-link betslip reconstruction (not just event search)
- [ ] PWA / installable on phone
- [ ] Share result as screenshot
