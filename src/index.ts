import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';

const agent = await createAgent({
  name: 'tennis-intel',
  version: '1.0.0',
  description: 'Professional tennis intelligence - ATP/WTA rankings, live scores, news, and player data via ESPN.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON from ESPN ===
async function fetchESPN(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ESPN API error: ${response.status}`);
  return response.json();
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - current tennis landscape summary',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const [atpData, wtaData] = await Promise.all([
      fetchESPN('https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings'),
      fetchESPN('https://site.api.espn.com/apis/site/v2/sports/tennis/wta/rankings'),
    ]);
    
    const atpTop5 = atpData.rankings?.[0]?.ranks?.slice(0, 5).map((r: any) => ({
      rank: r.current,
      name: r.athlete?.displayName,
      points: r.points,
    })) || [];
    
    const wtaTop5 = wtaData.rankings?.[0]?.ranks?.slice(0, 5).map((r: any) => ({
      rank: r.current,
      name: r.athlete?.displayName,
      points: r.points,
    })) || [];
    
    return {
      output: {
        atp: { label: 'ATP Top 5', players: atpTop5 },
        wta: { label: 'WTA Top 5', players: wtaTop5 },
        fetchedAt: new Date().toISOString(),
        dataSource: 'ESPN Tennis API (live)',
      },
    };
  },
});

// === PAID ENDPOINT 1: Full ATP Rankings ($0.001) ===
addEntrypoint({
  key: 'atp-rankings',
  description: 'Full ATP rankings - top 100 players with points, movement, and stats',
  input: z.object({
    limit: z.number().optional().default(50).describe('Number of players to return (max 100)'),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const data = await fetchESPN('https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings');
    const limit = Math.min(ctx.input.limit, 100);
    
    const rankings = data.rankings?.[0]?.ranks?.slice(0, limit).map((r: any) => ({
      rank: r.current,
      previousRank: r.previous,
      movement: r.previous - r.current,
      trend: r.trend,
      name: r.athlete?.displayName,
      firstName: r.athlete?.firstName,
      lastName: r.athlete?.lastName,
      id: r.athlete?.id,
      points: r.points,
      profileUrl: r.athlete?.links?.[0]?.href,
    })) || [];
    
    return {
      output: {
        tour: 'ATP',
        totalRanked: rankings.length,
        rankings,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 2: Full WTA Rankings ($0.001) ===
addEntrypoint({
  key: 'wta-rankings',
  description: 'Full WTA rankings - top 100 players with points, movement, and stats',
  input: z.object({
    limit: z.number().optional().default(50).describe('Number of players to return (max 100)'),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const data = await fetchESPN('https://site.api.espn.com/apis/site/v2/sports/tennis/wta/rankings');
    const limit = Math.min(ctx.input.limit, 100);
    
    const rankings = data.rankings?.[0]?.ranks?.slice(0, limit).map((r: any) => ({
      rank: r.current,
      previousRank: r.previous,
      movement: r.previous - r.current,
      trend: r.trend,
      name: r.athlete?.displayName,
      firstName: r.athlete?.firstName,
      lastName: r.athlete?.lastName,
      id: r.athlete?.id,
      points: r.points,
      profileUrl: r.athlete?.links?.[0]?.href,
    })) || [];
    
    return {
      output: {
        tour: 'WTA',
        totalRanked: rankings.length,
        rankings,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 3: Tennis News ($0.002) ===
addEntrypoint({
  key: 'news',
  description: 'Latest tennis news from ESPN - ATP and WTA coverage',
  input: z.object({
    tour: z.enum(['atp', 'wta', 'both']).optional().default('both'),
    limit: z.number().optional().default(10).describe('Number of articles (max 25)'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const urls: string[] = [];
    if (ctx.input.tour === 'atp' || ctx.input.tour === 'both') {
      urls.push('https://site.api.espn.com/apis/site/v2/sports/tennis/atp/news');
    }
    if (ctx.input.tour === 'wta' || ctx.input.tour === 'both') {
      urls.push('https://site.api.espn.com/apis/site/v2/sports/tennis/wta/news');
    }
    
    const results = await Promise.all(urls.map(url => fetchESPN(url)));
    const limit = Math.min(ctx.input.limit, 25);
    
    const allArticles = results.flatMap((data: any) => 
      (data.articles || []).map((a: any) => ({
        id: a.id,
        headline: a.headline,
        description: a.description,
        published: a.published,
        lastModified: a.lastModified,
        type: a.type,
        imageUrl: a.images?.[0]?.url,
        link: a.links?.web?.href || a.links?.mobile?.href,
        categories: a.categories?.map((c: any) => c.description).filter(Boolean),
      }))
    );
    
    // Sort by published date and dedupe
    const seen = new Set();
    const uniqueArticles = allArticles
      .sort((a: any, b: any) => new Date(b.published).getTime() - new Date(a.published).getTime())
      .filter((a: any) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      })
      .slice(0, limit);
    
    return {
      output: {
        tour: ctx.input.tour,
        count: uniqueArticles.length,
        articles: uniqueArticles,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 4: Live Matches ($0.002) ===
addEntrypoint({
  key: 'live-matches',
  description: 'Current live tennis matches and today\'s schedule',
  input: z.object({
    tour: z.enum(['atp', 'wta', 'both']).optional().default('both'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const urls: { tour: string; url: string }[] = [];
    if (ctx.input.tour === 'atp' || ctx.input.tour === 'both') {
      urls.push({ tour: 'ATP', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard' });
    }
    if (ctx.input.tour === 'wta' || ctx.input.tour === 'both') {
      urls.push({ tour: 'WTA', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard' });
    }
    
    const results = await Promise.all(
      urls.map(async ({ tour, url }) => {
        const data = await fetchESPN(url);
        return { tour, data };
      })
    );
    
    const matches: any[] = [];
    
    for (const { tour, data } of results) {
      const events = data.events || [];
      for (const event of events) {
        const competitions = event.competitions || [];
        for (const comp of competitions) {
          const status = comp.status?.type?.description || 'Unknown';
          const competitors = comp.competitors || [];
          
          matches.push({
            tour,
            tournament: event.name || 'Tournament',
            round: comp.round?.displayName || '',
            status,
            isLive: comp.status?.type?.state === 'in',
            isComplete: comp.status?.type?.completed || false,
            players: competitors.map((c: any) => ({
              name: c.athlete?.displayName || 'Unknown',
              seed: c.seed,
              isWinner: c.winner || false,
              sets: (c.linescores || []).map((s: any) => s.value),
            })),
            startTime: comp.startDate,
            venue: event.venue?.fullName || comp.venue?.fullName || '',
          });
        }
      }
    }
    
    // Sort: live first, then by start time
    matches.sort((a, b) => {
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;
      return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    });
    
    return {
      output: {
        tour: ctx.input.tour,
        totalMatches: matches.length,
        liveCount: matches.filter(m => m.isLive).length,
        matches,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 5: Player Search ($0.003) ===
addEntrypoint({
  key: 'player-search',
  description: 'Search ATP and WTA rankings for players by name',
  input: z.object({
    query: z.string().describe('Player name or partial name to search'),
    tour: z.enum(['atp', 'wta', 'both']).optional().default('both'),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const urls: { tour: string; url: string }[] = [];
    if (ctx.input.tour === 'atp' || ctx.input.tour === 'both') {
      urls.push({ tour: 'ATP', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings' });
    }
    if (ctx.input.tour === 'wta' || ctx.input.tour === 'both') {
      urls.push({ tour: 'WTA', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/rankings' });
    }
    
    const query = ctx.input.query.toLowerCase();
    const results = await Promise.all(
      urls.map(async ({ tour, url }) => {
        const data = await fetchESPN(url);
        return { tour, data };
      })
    );
    
    const players: any[] = [];
    
    for (const { tour, data } of results) {
      const ranks = data.rankings?.[0]?.ranks || [];
      for (const r of ranks) {
        const name = r.athlete?.displayName?.toLowerCase() || '';
        const firstName = r.athlete?.firstName?.toLowerCase() || '';
        const lastName = r.athlete?.lastName?.toLowerCase() || '';
        
        if (name.includes(query) || firstName.includes(query) || lastName.includes(query)) {
          players.push({
            tour,
            rank: r.current,
            previousRank: r.previous,
            movement: r.previous - r.current,
            name: r.athlete?.displayName,
            firstName: r.athlete?.firstName,
            lastName: r.athlete?.lastName,
            id: r.athlete?.id,
            points: r.points,
            trend: r.trend,
            profileUrl: r.athlete?.links?.[0]?.href,
          });
        }
      }
    }
    
    return {
      output: {
        query: ctx.input.query,
        tour: ctx.input.tour,
        found: players.length,
        players: players.sort((a, b) => a.rank - b.rank),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === ANALYTICS ENDPOINTS (FREE) ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms'),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      },
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

// === ICON ENDPOINT ===
app.get('/icon.png', async (c) => {
  // Serve a placeholder icon or redirect to a hosted one
  const iconUrl = 'https://raw.githubusercontent.com/langoustine69/tennis-intel/main/icon.png';
  return c.redirect(iconUrl);
});

// === ERC-8004 REGISTRATION FILE ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://tennis-intel-production.up.railway.app';
  
  return c.json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'tennis-intel',
    description: 'Professional tennis intelligence - ATP/WTA rankings, live scores, news, and player data. 1 FREE + 5 PAID endpoints via x402.',
    image: `${baseUrl}/icon.png`,
    services: [
      { name: 'web', endpoint: baseUrl },
      { name: 'A2A', endpoint: `${baseUrl}/.well-known/agent.json`, version: '0.3.0' },
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Tennis Intel Agent running on port ${port}`);

export default { port, fetch: app.fetch };
