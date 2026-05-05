#!/usr/bin/env node
// Fetches live data from Riot API and writes data.json
// Used by GitHub Actions workflow

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) { console.error('RIOT_API_KEY not set'); process.exit(1); }

const GAME_NAME = 'Sproporzionato';
const TAG_LINE = 'EUVU';
const REGION = 'euw1';
const ROUTING = 'europe';
const QUEUE_SOLO = 'RANKED_SOLO_5x5';
const MATCH_COUNT = 30;

// Rate limit: small delay between requests
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function riotFetch(url) {
  const res = await fetch(url, { headers: { 'X-Riot-Token': API_KEY } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Riot API ${res.status}: ${url}\n${text}`);
  }
  return res.json();
}

async function main() {
  console.log('Fetching account...');
  const account = await riotFetch(
    `https://${ROUTING}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(GAME_NAME)}/${encodeURIComponent(TAG_LINE)}`
  );
  const puuid = account.puuid;
  console.log(`PUUID: ${puuid.slice(0, 12)}...`);

  await sleep(200);

  console.log('Fetching league entries...');
  const leagues = await riotFetch(
    `https://${REGION}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`
  );
  const soloQ = leagues.find(l => l.queueType === QUEUE_SOLO);
  console.log(`Rank: ${soloQ ? `${soloQ.tier} ${soloQ.rank} ${soloQ.leaguePoints} LP` : 'Unranked'}`);

  await sleep(200);

  console.log('Fetching match IDs...');
  const matchIds = await riotFetch(
    `https://${ROUTING}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?count=${MATCH_COUNT}&type=ranked`
  );
  console.log(`Found ${matchIds.length} ranked matches`);

  // Fetch match details (with rate limit spacing)
  const matches = [];
  for (let i = 0; i < matchIds.length; i++) {
    if (i > 0) await sleep(150); // ~6.6 req/s, well under 20/s limit
    try {
      console.log(`Fetching match ${i + 1}/${matchIds.length}: ${matchIds[i]}`);
      const match = await riotFetch(
        `https://${ROUTING}.api.riotgames.com/lol/match/v5/matches/${matchIds[i]}`
      );
      const info = match.info;
      // Only include solo queue
      if (info.queueId !== 420) continue;

      const player = info.participants.find(p => p.puuid === puuid);
      if (!player) continue;

      const dur = info.gameDuration;
      const mins = Math.floor(dur / 60);
      const secs = dur % 60;

      // All 10 participants
      const teams = [
        { teamId: 100, players: [] },
        { teamId: 200, players: [] },
      ];
      for (const p of info.participants) {
        const team = teams.find(t => t.teamId === p.teamId);
        if (team) {
          team.players.push({
            name: p.riotIdGameName || p.summonerName || '?',
            tag: p.riotIdTagline || '',
            champ: p.championName,
            kills: p.kills,
            deaths: p.deaths,
            assists: p.assists,
            cs: p.totalMinionsKilled + p.neutralMinionsKilled,
            role: p.teamPosition || p.individualPosition || 'UNKNOWN',
            damageDealt: p.totalDamageDealtToChampions,
            goldEarned: p.goldEarned,
            visionScore: p.visionScore,
            items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
            level: p.champLevel,
            isTarget: p.puuid === puuid,
          });
        }
      }
      // Team results
      for (const t of teams) {
        const teamInfo = info.teams.find(ti => ti.teamId === t.teamId);
        t.win = teamInfo ? teamInfo.win : false;
      }

      matches.push({
        matchId: matchIds[i],
        gameCreation: info.gameCreation,
        date: new Date(info.gameCreation).toISOString(),
        champ: player.championName,
        result: player.win ? 'W' : 'L',
        kills: player.kills,
        deaths: player.deaths,
        assists: player.assists,
        cs: player.totalMinionsKilled + player.neutralMinionsKilled,
        duration: `${mins}:${String(secs).padStart(2, '0')}`,
        durationSec: dur,
        role: player.teamPosition || player.individualPosition || 'UNKNOWN',
        visionScore: player.visionScore,
        damageDealt: player.totalDamageDealtToChampions,
        goldEarned: player.goldEarned,
        teams: teams,
      });
    } catch (err) {
      console.error(`Error fetching ${matchIds[i]}: ${err.message}`);
    }
  }

  // Sort by gameCreation descending (most recent first)
  matches.sort((a, b) => b.gameCreation - a.gameCreation);

  // Build output
  const output = {
    summoner: {
      name: account.gameName,
      tag: account.tagLine,
      region: 'EUW',
      puuid: puuid,
    },
    rank: soloQ ? {
      tier: soloQ.tier,
      rank: soloQ.rank,
      lp: soloQ.leaguePoints,
      wins: soloQ.wins,
      losses: soloQ.losses,
      hotStreak: soloQ.hotStreak,
      veteran: soloQ.veteran,
    } : null,
    matches: matches,
    updatedAt: new Date().toISOString(),
    matchCount: matches.length,
  };

  const outPath = path.join(__dirname, '..', 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nDone! Wrote ${matches.length} matches to data.json`);
  console.log(`Current rank: ${soloQ ? `${soloQ.tier} ${soloQ.rank} ${soloQ.leaguePoints} LP (${soloQ.wins}W ${soloQ.losses}L)` : 'N/A'}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
