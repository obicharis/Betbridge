/**
 * sportybet.js
 * All SportyBet API interactions.
 *
 * Key endpoints:
 *   Share code:   GET /api/{country}/orders/share?shareCode=xxx
 *   Event search: GET /api/{country}/factsCenter/searchEvents?keyword=xxx
 *   Event detail: GET /api/{country}/factsCenter/eventDetail?eventId=xxx
 *
 * Deeplink format (web):
 *   https://www.sportybet.com/{country}/sport/{sport}?selectOdds={outcomeId1}_{outcomeId2}
 *
 * The selectOdds param is underscore-separated list of outcome IDs.
 */

const fetch = require('node-fetch');

const COUNTRIES = ['ng', 'gh', 'ke', 'za', 'tz', 'ug', 'et'];
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ─────────────────────────────────────────────────────────
// FETCH SHARE CODE
// ─────────────────────────────────────────────────────────

async function fetchShareCode(shareCode) {
  const ts = Date.now();
  for (const country of COUNTRIES) {
    try {
      const url = `https://www.sportybet.com/api/${country}/orders/share?shareCode=${encodeURIComponent(shareCode)}&_time=${ts}`;
      const res = await fetch(url, {
        headers: { ...BASE_HEADERS, 'Referer': `https://www.sportybet.com/${country}/` },
        timeout: 9000,
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.bizCode === 0 && data.data) {
        return { country, raw: data.data };
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// SEARCH EVENTS
// Returns array of candidate events with markets + outcomes
// ─────────────────────────────────────────────────────────

async function searchEvents(keyword, country = 'ng') {
  const ts = Date.now();
  const url = `https://www.sportybet.com/api/${country}/factsCenter/searchEvents?keyword=${encodeURIComponent(keyword)}&_time=${ts}`;
  try {
    const res = await fetch(url, {
      headers: { ...BASE_HEADERS, 'Referer': `https://www.sportybet.com/${country}/` },
      timeout: 8000,
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data?.bizCode === 0 && Array.isArray(data.data)) {
      return data.data;
    }
    return [];
  } catch (_) {
    return [];
  }
}

/**
 * Fetch full event details (all markets + outcomes) by eventId.
 */
async function fetchEventDetail(eventId, country = 'ng') {
  const ts = Date.now();
  const url = `https://www.sportybet.com/api/${country}/factsCenter/eventDetail?eventId=${encodeURIComponent(eventId)}&_time=${ts}`;
  try {
    const res = await fetch(url, {
      headers: { ...BASE_HEADERS, 'Referer': `https://www.sportybet.com/${country}/` },
      timeout: 8000,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.bizCode === 0 && data.data) return data.data;
    return null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// NORMALISE RAW SHARE RESPONSE
// ─────────────────────────────────────────────────────────

function normalise(raw) {
  const betInfo = raw.betInfo || raw;
  const orders = betInfo.orders || betInfo.betOrders || [];

  const selections = orders.map(order => {
    const event   = order.eventInfo  || order;
    const market  = order.marketInfo || {};
    const outcome = order.outcomeInfo || {};

    return {
      eventName:  event.eventName  || event.name  || '',
      homeTeam:   event.homeTeamName || event.home || '',
      awayTeam:   event.awayTeamName || event.away || '',
      startTime:  event.estimateStartTime || event.startTime || null,
      sport:      (event.sportName || event.sport || 'football').toLowerCase(),
      tournament: event.tournamentName || event.tournament || '',
      market:     market.marketName || market.name || order.marketName || '',
      selection:  outcome.outcomeName || outcome.name || order.outcomeName || '',
      odds:       parseFloat(order.oddValue || order.odds || outcome.odds || 0),
      eventId:    event.eventId || event.id || '',
      outcomeId:  outcome.outcomeId || outcome.id || order.outcomeId || '',
    };
  });

  return {
    platform: 'sportybet',
    betType: (betInfo.betType || betInfo.orderType || 'combo').toLowerCase(),
    totalOdds: parseFloat(betInfo.totalOdds || betInfo.combinedOdds || 0) ||
      selections.reduce((a, s) => a * (s.odds || 1), 1),
    selections,
    stake: betInfo.betAmount || betInfo.stake || null,
    currency: betInfo.currency || 'NGN',
  };
}

// ─────────────────────────────────────────────────────────
// NORMALISE A SEARCH-RESULT EVENT (for matching candidates)
// ─────────────────────────────────────────────────────────

function normaliseSearchEvent(ev) {
  return {
    eventId:    ev.eventId || ev.id,
    eventName:  ev.eventName || ev.name || '',
    homeTeam:   ev.homeTeamName || ev.home || '',
    awayTeam:   ev.awayTeamName || ev.away || '',
    startTime:  ev.estimateStartTime || ev.startTime || null,
    sport:      (ev.sportName || ev.sport || '').toLowerCase(),
    tournament: ev.tournamentName || ev.tournament || '',
    // Markets may or may not be populated in search results
    markets:    (ev.markets || ev.oddsMap || []).map(m => ({
      marketId:   m.marketId || m.id,
      marketName: m.marketName || m.name || '',
      outcomes:   (m.outcomes || m.oddsViews || []).map(o => ({
        outcomeId:   o.outcomeId || o.id,
        outcomeName: o.outcomeName || o.name || '',
        odds:        parseFloat(o.oddValue || o.odds || 0),
      })),
    })),
  };
}

// ─────────────────────────────────────────────────────────
// BUILD DEEPLINK
// selectOdds param = underscore-joined outcomeIds
// ─────────────────────────────────────────────────────────

function buildDeeplink(resolvedSelections, country = 'ng') {
  const outcomeIds = resolvedSelections
    .map(s => s.targetOutcomeId)
    .filter(Boolean);

  if (outcomeIds.length === 0) return null;

  // Sport slug – default to football
  const sport = resolvedSelections[0]?.sport || 'football';
  const sportSlug = sport.toLowerCase().replace(/\s+/g, '-');

  return `https://www.sportybet.com/${country}/sport/${sportSlug}?selectOdds=${outcomeIds.join('_')}`;
}

module.exports = {
  fetchShareCode,
  searchEvents,
  fetchEventDetail,
  normalise,
  normaliseSearchEvent,
  buildDeeplink,
  COUNTRIES,
};
