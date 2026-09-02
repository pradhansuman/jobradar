/* probe.js — test which real-world pages/feeds yield JobPosting JSON-LD or job APIs */
(async () => {
  const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
  const targets = [
    'https://mailchimp.breezy.hr',
    'https://remotive.com/remote-jobs',
    'https://jobicy.com/jobs',
    'https://www.ycombinator.com/jobs',
    'https://jobready.ai/careers',
  ];
  for (const url of targets) {
    try {
      const html = await (await fetch(url, { headers: ua })).text();
      const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      let jp = 0;
      for (const b of blocks) {
        try {
          const j = JSON.parse(b[1].trim());
          const nodes = j['@graph'] || (Array.isArray(j) ? j : [j]);
          jp += nodes.filter((n) => n && n['@type'] === 'JobPosting').length;
        } catch {}
      }
      console.log(url, '→', html.length, 'bytes,', blocks.length, 'JSON-LD blocks,', jp, 'JobPostings');
    } catch (e) {
      console.log(url, '→ FAIL', String(e).slice(0, 80));
    }
  }
  try {
    const api = await (await fetch('https://remoteok.com/api', { headers: ua })).text();
    const arr = JSON.parse(api);
    if (Array.isArray(arr)) {
      console.log('remoteok API →', arr.length, 'jobs');
      const s = arr[1] || {};
      console.log('  sample:', (s.position || '').slice(0, 50), '|', s.company, '|', s.date);
    } else console.log('remoteok API → not an array');
  } catch (e) {
    console.log('remoteok API → FAIL', String(e).slice(0, 100));
  }
})();
