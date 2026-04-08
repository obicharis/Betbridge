/**
 * resolver.js
 * Cross-platform bet slip matching pipeline.
 *
 * For each selection in the source betslip:
 *   1. Search the TARGET platform for matching events (by team names)
 *   2. Score all candidates with eventScore()
 *   3. If best match is above threshold, fetch that event's full market list
 *   4. Find the best matching market by name
 *   5. Find the best matching outcome in that market
 *   6. Attach the target platform's outcome ID (and ancillary IDs) to the selection
 *
 * Returns enriched selections with targetOutcomeId etc. attached.
 * Also returns a confidence score (0–1) for each match.
 */

const { eventScore, marketScore, outcomeScore } = require('./matcher');
const sportybet = require('./sportybet');
const stake     = require('./stake');

const EVENT_THRESHOLD   = 0.55; // minimum event match score to proceed
const MARKET_THRESHOLD  = 0.45;
const OUTCOME_THRESHOLD = 0.45;

// ─────────────────────────────────────────────────────────
// RESOLVE: SPORTYBET SELECTION → STAKE
// ─────────────────────────────────────────────────────────

async function resolveSelectionToStake(sel, country = 'ng') {
  const result = {
    ...sel,
    targetOutcomeId:      null,
    targetMarketId:       null,
    targetFixtureId:      null,
    targetFixtureSlug:    null,
    targetSportSlug:      null,
    targetTournamentSlug: null,
    matchConfidence:      0,
    matchStatus:          'unmatched',
    matchNote:            '',
  };

  // Build search keyword: "HomeTeam AwayTeam"
  const keyword = [sel.homeTeam, sel.awayTeam].filter(Boolean).join(' ')
    || sel.eventName;

  if (!keyword) {
    result.matchNote = 'No team names to search';
    return result;
  }

  const sportSlug = mapSportToStakeSlug(sel.sport);

  // 1. Search Stake for fixtures
  const rawFixtures = await stake.searchFixtures(keyword, sportSlug);
  if (!rawFixtures.length) {
    result.matchStatus = 'event_not_found';
    result.matchNote   = `No Stake fixtures found for "${keyword}"`;
    return result;
  }

  // 2. Score and pick best event match
  const scored = rawFixtures.map(f => {
    const candidate = stake.normaliseSearchFixture(f);
    return { candidate, score: eventScore(sel, candidate) };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best.score < EVENT_THRESHOLD) {
    result.matchStatus = 'event_low_confidence';
    result.matchNote   = `Best event match score ${best.score.toFixed(2)} below threshold`;
    return result;
  }

  result.matchConfidence = best.score;
  const fix = best.candidate;
  result.targetFixtureId    = fix.fixtureId;
  result.targetFixtureSlug  = fix.fixtureSlug;
  result.targetSportSlug    = fix.sportSlug || sportSlug;

  // 3. Fetch full market list for this fixture
  const detail = await stake.fetchFixtureMarkets(fix.fixtureId);
  if (!detail) {
    result.matchStatus = 'markets_unavailable';
    result.matchNote   = 'Could not load markets for matched fixture';
    return result;
  }

  const fixtureData = stake.normaliseSearchFixture(detail);
  result.targetTournamentSlug = detail.tournament?.slug || '';

  // 4. Match market
  const marketCandidates = fixtureData.markets.map(m => ({
    m,
    score: marketScore(sel.market, m.marketName),
  })).sort((a, b) => b.score - a.score);

  if (!marketCandidates.length || marketCandidates[0].score < MARKET_THRESHOLD) {
    result.matchStatus = 'market_not_found';
    result.matchNote   = `No market match for "${sel.market}"`;
    return result;
  }

  const bestMarket = marketCandidates[0].m;
  result.targetMarketId = bestMarket.marketId;

  // 5. Match outcome
  const outcomeCandidates = bestMarket.outcomes
    .filter(o => o.active !== false)
    .map(o => ({
      o,
      score: outcomeScore(sel.selection, o.outcomeName),
    })).sort((a, b) => b.score - a.score);

  if (!outcomeCandidates.length || outcomeCandidates[0].score < OUTCOME_THRESHOLD) {
    result.matchStatus = 'outcome_not_found';
    result.matchNote   = `No outcome match for "${sel.selection}"`;
    return result;
  }

  const bestOutcome = outcomeCandidates[0].o;
  result.targetOutcomeId = bestOutcome.outcomeId;
  result.matchStatus     = 'matched';
  result.matchNote       = `→ ${detail.name} | ${bestMarket.marketName} | ${bestOutcome.outcomeName} (${bestOutcome.odds})`;
  result.matchConfidence = Math.min(1,
    best.score * 0.5 + marketCandidates[0].score * 0.25 + outcomeCandidates[0].score * 0.25
  );

  return result;
}

// ─────────────────────────────────────────────────────────
// RESOLVE: STAKE SELECTION → SPORTYBET
// ─────────────────────────────────────────────────────────

async function resolveSelectionToSportyBet(sel, country = 'ng') {
  const result = {
    ...sel,
    targetOutcomeId:  null,
    targetEventId:    null,
    sport:            sel.sport || 'football',
    matchConfidence:  0,
    matchStatus:      'unmatched',
    matchNote:        '',
  };

  const keyword = [sel.homeTeam, sel.awayTeam].filter(Boolean).join(' ')
    || sel.eventName;

  if (!keyword) {
    result.matchNote = 'No team names to search';
    return result;
  }

  // 1. Search SportyBet events
  const rawEvents = await sportybet.searchEvents(keyword, country);
  if (!rawEvents.length) {
    result.matchStatus = 'event_not_found';
    result.matchNote   = `No SportyBet events found for "${keyword}"`;
    return result;
  }

  // 2. Score and pick best
  const scored = rawEvents.map(ev => {
    const candidate = sportybet.normaliseSearchEvent(ev);
    return { candidate, score: eventScore(sel, candidate) };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best.score < EVENT_THRESHOLD) {
    result.matchStatus = 'event_low_confidence';
    result.matchNote   = `Best event score ${best.score.toFixed(2)} below threshold`;
    return result;
  }

  result.matchConfidence = best.score;
  const ev = best.candidate;
  result.targetEventId = ev.eventId;

  // 3. Fetch full event detail for markets
  const detail = await sportybet.fetchEventDetail(ev.eventId, country);
  if (!detail) {
    result.matchStatus = 'markets_unavailable';
    result.matchNote   = 'Could not load markets for matched event';
    return result;
  }

  const eventData = sportybet.normaliseSearchEvent(detail);

  // 4. Match market
  const marketCandidates = eventData.markets.map(m => ({
    m,
    score: marketScore(sel.market, m.marketName),
  })).sort((a, b) => b.score - a.score);

  if (!marketCandidates.length || marketCandidates[0].score < MARKET_THRESHOLD) {
    result.matchStatus = 'market_not_found';
    result.matchNote   = `No market match for "${sel.market}"`;
    return result;
  }

  const bestMarket = marketCandidates[0].m;

  // 5. Match outcome
  const outcomeCandidates = bestMarket.outcomes.map(o => ({
    o,
    score: outcomeScore(sel.selection, o.outcomeName),
  })).sort((a, b) => b.score - a.score);

  if (!outcomeCandidates.length || outcomeCandidates[0].score < OUTCOME_THRESHOLD) {
    result.matchStatus = 'outcome_not_found';
    result.matchNote   = `No outcome match for "${sel.selection}"`;
    return result;
  }

  const bestOutcome = outcomeCandidates[0].o;
  result.targetOutcomeId = bestOutcome.outcomeId;
  result.matchStatus     = 'matched';
  result.matchNote       = `→ ${eventData.eventName} | ${bestMarket.marketName} | ${bestOutcome.outcomeName} (${bestOutcome.odds})`;
  result.matchConfidence = Math.min(1,
    best.score * 0.5 + marketCandidates[0].score * 0.25 + outcomeCandidates[0].score * 0.25
  );

  return result;
}

// ─────────────────────────────────────────────────────────
// SPORT SLUG MAPPING
// ─────────────────────────────────────────────────────────

function mapSportToStakeSlug(sport) {
  const map = {
    football:    'football',
    soccer:      'football',
    basketball:  'basketball',
    tennis:      'tennis',
    baseball:    'baseball',
    'american football': 'american-football',
    'ice hockey': 'ice-hockey',
    hockey:      'ice-hockey',
    mma:         'mma',
    boxing:      'boxing',
    cricket:     'cricket',
    rugby:       'rugby-league',
    volleyball:  'volleyball',
    handball:    'handball',
    esports:     'esports',
  };
  return map[(sport || '').toLowerCase()] || 'football';
}

// ─────────────────────────────────────────────────────────
// FULL PIPELINE: SPORTYBET BETSLIP → STAKE DEEPLINK
// ─────────────────────────────────────────────────────────

async function sportyBetToStake(normalised) {
  const resolved = await Promise.all(
    normalised.selections.map(sel => resolveSelectionToStake(sel))
  );

  const matched    = resolved.filter(s => s.matchStatus === 'matched');
  const unmatched  = resolved.filter(s => s.matchStatus !== 'matched');
  const deeplink   = stake.buildDeeplink(matched);
  const avgConf    = matched.length
    ? matched.reduce((a, s) => a + s.matchConfidence, 0) / matched.length
    : 0;

  return {
    resolved,
    matched,
    unmatched,
    deeplink,
    matchRate:    matched.length / resolved.length,
    avgConfidence: avgConf,
  };
}

// ─────────────────────────────────────────────────────────
// FULL PIPELINE: STAKE BETSLIP → SPORTYBET DEEPLINK
// ─────────────────────────────────────────────────────────

async function stakeTosportyBet(normalised, country = 'ng') {
  const resolved = await Promise.all(
    normalised.selections.map(sel => resolveSelectionToSportyBet(sel, country))
  );

  const matched   = resolved.filter(s => s.matchStatus === 'matched');
  const unmatched = resolved.filter(s => s.matchStatus !== 'matched');
  const deeplink  = sportybet.buildDeeplink(matched, country);
  const avgConf   = matched.length
    ? matched.reduce((a, s) => a + s.matchConfidence, 0) / matched.length
    : 0;

  return {
    resolved,
    matched,
    unmatched,
    deeplink,
    matchRate:     matched.length / resolved.length,
    avgConfidence: avgConf,
  };
}

module.exports = {
  sportyBetToStake,
  stakeTosportyBet,
};
