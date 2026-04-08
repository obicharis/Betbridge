/**
 * server.js — BetBridge v2
 * Full deep-link resolution: SportyBet ↔ Stake
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');

const sportybet  = require('./lib/sportybet');
const stake      = require('./lib/stake');
const { sportyBetToStake, stakeTosportyBet } = require('./lib/resolver');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────
// POST /api/sportybet-to-stake
// Body: { code: "SBNG1234" }
// ─────────────────────────────────────────────────────────

app.get('/api/sportybet-to-stake', async (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code is required' });

  try {
    // 1. Fetch the share code
    const fetched = await sportybet.fetchShareCode(code);
    if (!fetched) {
      return res.status(404).json({
        error: 'Could not fetch SportyBet bet slip. Please check the share code.',
      });
    }

    // 2. Normalise
    const normalised = sportybet.normalise(fetched.raw);

    // 3. Resolve → Stake (deep matching)
    const resolution = await sportyBetToStake(normalised);

    return res.json({
      success: true,
      source: { platform: 'sportybet', country: fetched.country, code },
      betslip: normalised,
      resolution: {
        deeplink:      resolution.deeplink,
        matchRate:     resolution.matchRate,
        avgConfidence: resolution.avgConfidence,
        selections:    resolution.resolved.map(s => ({
          // source info
          eventName:   s.eventName,
          homeTeam:    s.homeTeam,
          awayTeam:    s.awayTeam,
          market:      s.market,
          selection:   s.selection,
          odds:        s.odds,
          // match result
          status:      s.matchStatus,
          confidence:  s.matchConfidence,
          note:        s.matchNote,
          targetOutcomeId: s.targetOutcomeId,
        })),
      },
      targetPlatform: 'stake',
    });
  } catch (err) {
    console.error('[sportybet-to-stake]', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/stake-to-sportybet
// ─────────────────────────────────────────────────────────

app.get('/api/stake-to-sportybet', async (req, res) => {
  const code    = (req.query.code || '').trim();
  const country = (req.query.country || 'ng').toLowerCase();

  if (!code) return res.status(400).json({ error: 'code is required' });

  try {
    // 1. Fetch
    const fetched = await stake.fetchShareCode(code);
    if (!fetched) {
      return res.status(404).json({
        error: 'Could not fetch Stake bet slip. Please check the share code or link.',
      });
    }

    // 2. Normalise
    const normalised = stake.normalise(fetched.raw);

    // 3. Resolve → SportyBet
    const resolution = await stakeTosportyBet(normalised, country);

    return res.json({
      success: true,
      source: { platform: 'stake', code: fetched.code },
      betslip: normalised,
      resolution: {
        deeplink:      resolution.deeplink,
        matchRate:     resolution.matchRate,
        avgConfidence: resolution.avgConfidence,
        selections:    resolution.resolved.map(s => ({
          eventName:   s.eventName,
          homeTeam:    s.homeTeam,
          awayTeam:    s.awayTeam,
          market:      s.market,
          selection:   s.selection,
          odds:        s.odds,
          status:      s.matchStatus,
          confidence:  s.matchConfidence,
          note:        s.matchNote,
          targetOutcomeId: s.targetOutcomeId,
        })),
      },
      targetPlatform: 'sportybet',
    });
  } catch (err) {
    console.error('[stake-to-sportybet]', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/debug-sportybet?code=HZL7U2
// ─────────────────────────────────────────────────────────
app.get('/api/debug-sportybet', async (req, res) => {
  const code = (req.query.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'code required' });
  const fetch = require('node-fetch');
  const countries = ['ng', 'gh', 'ke', 'za'];
  const results = {};
  const ts = Date.now();
  for (const country of countries) {
    try {
      const url = `https://www.sportybet.com/api/${country}/orders/share?shareCode=${encodeURIComponent(code)}&_time=${ts}`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': `https://www.sportybet.com/${country}/`,
          'Origin': 'https://www.sportybet.com',
        },
        timeout: 6000,
      });
      results[country] = { status: r.status, body: await r.json().catch(() => 'non-JSON') };
    } catch (e) {
      results[country] = { error: e.message };
    }
  }
  return res.json(results);
});

// ─────────────────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────────────────

app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

// Catch-all
app.get('*', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () =>
  console.log(`BetBridge v2 running → http://localhost:${PORT}`)
);
