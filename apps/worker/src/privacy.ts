// The privacy policy, served at /privacy as a plain HTML page: Google Play needs a public URL for
// it, and the store listing links here. It describes what the Worker, Auth0
// and the push services actually keep (see the D1 migrations and push/tokens.ts), so a change to
// what's stored should change this page too.
//
// Questions and deletion requests go to CONTACT_EMAIL when it's set; without it, the page points
// at the project's GitHub issues. Account deletion has its own page (accountDeletion.ts).

export const PRIVACY_UPDATED_ON = '2026-10-23';
const ISSUES_URL = 'https://github.com/waterfausett/FortyTwo.Blazor/issues';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function contactHtml(contactEmail: string | undefined): string {
  const email = contactEmail?.trim();
  if (email) return `email <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`;
  return `open an issue at <a href="${ISSUES_URL}">${ISSUES_URL}</a>`;
}

// The page around /privacy and /account-deletion (accountDeletion.ts): self-contained, light or
// dark with the system, readable at phone width.
export function publicPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #faf7f2; --fg: #2b211a; --muted: #6b5d52; --link: #8a4b1f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1f1813; --fg: #efe6dc; --muted: #b3a597; --link: #e0a56e; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 44rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
  h1 { font-size: 1.75rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
  .updated { color: var(--muted); margin: 0 0 1.5rem; }
  a { color: var(--link); }
  li { margin: .25rem 0; }
</style>
</head>
<body>
<main>
${body}</main>
</body>
</html>
`;
}

export function privacyPolicyHtml(contactEmail: string | undefined): string {
  const contact = contactHtml(contactEmail);
  return publicPage('Forty-Two privacy policy', `<h1>Forty-Two privacy policy</h1>
<p class="updated">Last updated ${PRIVACY_UPDATED_ON}</p>

<p>Forty-Two is a dominoes game for Android and the web. This page explains what it stores about
you, why, and how to have it deleted. Forty-Two has no ads, doesn't sell or share your data for
advertising, and doesn't use analytics or tracking.</p>

<h2>What we store</h2>
<ul>
  <li><strong>Your account.</strong> You sign in through Auth0, our sign-in provider. Auth0 keeps your email address, the name and
    profile picture your sign-in provider gives us, and your in-game settings (display name,
    picture, notification and display preferences).</li>
  <li><strong>Your display name and picture</strong>, copied into our database so other players at
    your table can see who they're playing with. Other players never see your email address or real
    name, unless you've made one of them your display name.</li>
  <li><strong>Your games.</strong> The matches you play (the hands, bids and plays), which seat you
    sat in, and per-game results used for your stats on the Profile screen.</li>
  <li><strong>People you've played with and your friends list</strong>, and invitations to matches
    you've sent or received, so you can find and invite each other again.</li>
  <li><strong>Push notification tokens.</strong> If you allow notifications, the app registers a
    token for your device so we can tell you when it's your turn or you've been invited. Tokens are
    sent through Expo's push service and Google's Firebase Cloud Messaging.</li>
  <li><strong>Server logs.</strong> Our server (Cloudflare Workers) keeps short-lived logs of
    requests and errors, which can include your account ID, for keeping the game running and fixing
    problems.</li>
</ul>
<p>The app and the web version also keep your sign-in session and a few preferences, such as
turn-alert settings, on your device.</p>

<h2>Who processes it</h2>
<ul>
  <li><a href="https://auth0.com/privacy">Auth0 (Okta)</a>: sign-in and account storage.</li>
  <li><a href="https://www.cloudflare.com/privacypolicy/">Cloudflare</a>: hosting, the game
    database and logs.</li>
  <li><a href="https://expo.dev/privacy">Expo</a> and
    <a href="https://firebase.google.com/support/privacy">Google Firebase</a>: delivering push
    notifications.</li>
</ul>
<p>We don't share your data with anyone else, except where the law requires it.</p>

<h2>How long we keep it</h2>
<p>Your account and game history stay until you delete your account. When you do, finished
matches stay in the other players' history, with you shown as "Unknown". Unfinished matches nobody has
played for 14 days are deleted automatically. Push tokens are removed when you sign out, turn notifications
off, or the push service tells us the token no longer works.</p>

<h2>Deleting your account</h2>
<p>You can delete your account and the data tied to it at any time: in the app or on the web,
open <strong>Profile</strong> and choose <strong>Delete account</strong>. If you can't sign in,
${contact} from the email address you sign in with. See
<a href="/account-deletion">Deleting your Forty-Two account</a> for what's deleted and what's
kept.</p>

<h2>Children</h2>
<p>Forty-Two isn't directed at children under 13, and we don't knowingly collect data from them.</p>

<h2>Changes</h2>
<p>If this policy changes, we'll update this page and the date at the top.</p>

<h2>Contact</h2>
<p>For questions about this policy or your data, ${contact}.</p>
`);
}
