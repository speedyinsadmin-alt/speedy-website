// /api/version — what deployment is live right now.
//
// An already-open portal window cannot know a deploy happened: a running page
// can't swap its own code. The service worker is network-first on portal.html,
// so CLOSING and REOPENING the app always gets the newest version — this endpoint
// is only for windows that stay open across a deploy.
//
// The id comes from Vercel's own system env vars, so there is nothing to bump by
// hand and it can never drift from what is actually deployed.
//
// No auth: it reveals only a deployment id, which is not a secret. No database,
// no HawkSoft, no external call — this must stay cheap enough to poll.

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const id =
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    'dev';

  // Must never be cached, or the whole point is lost.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.status(200).json({
    ok: true,
    id,
    sha: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8) || null
  });
}
