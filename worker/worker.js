// Cloudflare Worker — Riot API proxy with caching
// Deploy: npx wrangler deploy
// Set secret: npx wrangler secret put RIOT_API_KEY

const PUUID = 'Cw6nwb9CaamINcY-BcRfpYMHBWXijBj4lwcQdqWvUGXoTRjUViomuWLP4IzqAJxqTE5d5xUy2MyNOA';
const REGION = 'euw1';
const ROUTING = 'europe';
const MATCH_COUNT = 30;
const CACHE_TTL = 120; // 2 minutes

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Live game endpoint — no cache, always fresh
    if (url.pathname === '/api/live') {
      try {
        const API_KEY = env.RIOT_API_KEY;
        const res = await fetch(
          `https://${REGION}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${PUUID}`,
          { headers: { 'X-Riot-Token': API_KEY } }
        );
        if (res.status === 404) {
          return new Response(JSON.stringify({ inGame: false }), { headers: CORS_HEADERS });
        }
        if (!res.ok) throw new Error('Spectator API: ' + res.status);
        const game = await res.json();
        const target = game.participants.find(p => p.puuid === PUUID);
        const elapsed = game.gameLength > 0 ? game.gameLength : 0;
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const teams = [
          { teamId: 100, players: game.participants.filter(p => p.teamId === 100).map(p => ({
            name: p.riotId || p.summonerId || '?',
            champ: p.championId,
            isTarget: p.puuid === PUUID,
          })) },
          { teamId: 200, players: game.participants.filter(p => p.teamId === 200).map(p => ({
            name: p.riotId || p.summonerId || '?',
            champ: p.championId,
            isTarget: p.puuid === PUUID,
          })) },
        ];
        return new Response(JSON.stringify({
          inGame: true,
          gameMode: game.gameMode,
          gameType: game.gameType,
          mapId: game.mapId,
          gameLength: `${mins}:${String(secs).padStart(2, '0')}`,
          gameLengthSec: elapsed,
          gameStartTime: game.gameStartTime,
          myChamp: target ? target.championId : null,
          myTeamId: target ? target.teamId : null,
          teams,
          bannedChampions: game.bannedChampions || [],
        }), { headers: CORS_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ inGame: false, error: err.message }), { headers: CORS_HEADERS });
      }
    }

    if (url.pathname !== '/api/data') {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS_HEADERS });
    }

    // Check cache
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      resp.headers.set('X-Cache', 'HIT');
      return resp;
    }

    try {
      const API_KEY = env.RIOT_API_KEY;
      if (!API_KEY) throw new Error('RIOT_API_KEY not configured');

      const riotFetch = async (riotUrl) => {
        const res = await fetch(riotUrl, { headers: { 'X-Riot-Token': API_KEY } });
        if (!res.ok) throw new Error(`Riot ${res.status}: ${riotUrl}`);
        return res.json();
      };

      // Fetch account
      const account = await riotFetch(`https://${ROUTING}.api.riotgames.com/riot/account/v1/accounts/by-puuid/${PUUID}`);

      // Fetch rank
      const leagues = await riotFetch(`https://${REGION}.api.riotgames.com/lol/league/v4/entries/by-puuid/${PUUID}`);
      const soloQ = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');

      // Fetch match IDs
      const matchIds = await riotFetch(`https://${ROUTING}.api.riotgames.com/lol/match/v5/matches/by-puuid/${PUUID}/ids?count=${MATCH_COUNT}&type=ranked`);

      // Fetch match details (parallel in batches of 5)
      const matches = [];
      for (let i = 0; i < matchIds.length; i += 5) {
        const batch = matchIds.slice(i, i + 5);
        const results = await Promise.allSettled(
          batch.map(id => riotFetch(`https://${ROUTING}.api.riotgames.com/lol/match/v5/matches/${id}`))
        );
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const match = r.value;
          const info = match.info;
          if (info.queueId !== 420) continue;
          const player = info.participants.find(p => p.puuid === PUUID);
          if (!player) continue;
          const dur = info.gameDuration;
          const mins = Math.floor(dur / 60);
          const secs = dur % 60;

          // All 10 participants
          const teams = [{ teamId: 100, players: [] }, { teamId: 200, players: [] }];
          for (const p of info.participants) {
            const team = teams.find(t => t.teamId === p.teamId);
            if (team) {
              team.players.push({
                name: p.riotIdGameName || p.summonerName || '?',
                tag: p.riotIdTagline || '',
                champ: p.championName,
                kills: p.kills, deaths: p.deaths, assists: p.assists,
                cs: p.totalMinionsKilled + p.neutralMinionsKilled,
                role: p.teamPosition || p.individualPosition || 'UNKNOWN',
                damageDealt: p.totalDamageDealtToChampions,
                goldEarned: p.goldEarned,
                visionScore: p.visionScore,
                items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
                level: p.champLevel,
                isTarget: p.puuid === PUUID,
              });
            }
          }
          for (const t of teams) {
            const ti = info.teams.find(x => x.teamId === t.teamId);
            t.win = ti ? ti.win : false;
          }

          // Team kills for KP calculation
          const myTeam = teams.find(t => t.players.some(p => p.isTarget));
          const teamKills = myTeam ? myTeam.players.reduce((s, p) => s + p.kills, 0) : 1;

          matches.push({
            matchId: match.metadata.matchId,
            gameCreation: info.gameCreation,
            date: new Date(info.gameCreation).toISOString(),
            champ: player.championName,
            result: player.win ? 'W' : 'L',
            kills: player.kills, deaths: player.deaths, assists: player.assists,
            cs: player.totalMinionsKilled + player.neutralMinionsKilled,
            duration: `${mins}:${String(secs).padStart(2, '0')}`,
            durationSec: dur,
            role: player.teamPosition || player.individualPosition || 'UNKNOWN',
            visionScore: player.visionScore,
            damageDealt: player.totalDamageDealtToChampions,
            goldEarned: player.goldEarned,
            teamKills,
            teams,
          });
        }
      }

      matches.sort((a, b) => b.gameCreation - a.gameCreation);

      const output = {
        summoner: { name: account.gameName, tag: account.tagLine, region: 'EUW', puuid: PUUID },
        rank: soloQ ? {
          tier: soloQ.tier, rank: soloQ.rank, lp: soloQ.leaguePoints,
          wins: soloQ.wins, losses: soloQ.losses,
          hotStreak: soloQ.hotStreak, veteran: soloQ.veteran,
        } : null,
        matches,
        updatedAt: new Date().toISOString(),
        matchCount: matches.length,
      };

      const response = new Response(JSON.stringify(output), {
        headers: { ...CORS_HEADERS, 'Cache-Control': `public, max-age=${CACHE_TTL}`, 'X-Cache': 'MISS' },
      });

      // Store in Cloudflare cache
      const cacheResp = response.clone();
      cacheResp.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
      await cache.put(cacheKey, cacheResp);

      return response;
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
    }
  },
};
