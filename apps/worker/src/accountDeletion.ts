// How to delete a Forty-Two account, served at /account-deletion: Google Play asks for a web page
// where people can ask for deletion without the app, and the privacy policy links here. The list
// of what goes and what stays follows users/deleteAccount.ts, so a change there should change this
// page too.
import { DELETED_NAME } from './users/deleteAccount';
import { contactHtml, publicPage } from './privacy';

export function accountDeletionHtml(contactEmail: string | undefined): string {
  const contact = contactHtml(contactEmail);
  return publicPage('Deleting your Forty-Two account', `<h1>Deleting your Forty-Two account</h1>
<p class="updated">Forty-Two, the dominoes game for Android and the web</p>

<h2>In the app or on the web</h2>
<ol>
  <li>Sign in to the Forty-Two app, or to <a href="/profile">Forty-Two on the web</a>.</li>
  <li>Open <strong>Profile</strong>.</li>
  <li>Choose <strong>Delete account</strong> and confirm.</li>
</ol>
<p>Your account is deleted straight away and you're signed out.</p>

<h2>If you can't sign in</h2>
<p>${contact} from the email address you sign in with, asking for your account to be deleted.
We'll delete it within 30 days and let you know when it's done.</p>

<h2>What's deleted</h2>
<ul>
  <li>Your account: email address, name, picture and settings.</li>
  <li>Your stats, your friends list (and you from other players' lists), the people you've played
    with, and match invitations you've sent or received.</li>
  <li>Your devices' push notification tokens.</li>
  <li>Your seat in unfinished matches: a bot takes it, or the match ends if no one else is
    playing.</li>
</ul>

<h2>What's kept</h2>
<ul>
  <li>Finished matches stay in the other players' history, with you shown as "${DELETED_NAME}"
    and no picture. Nothing in them leads back to you.</li>
  <li>Server logs are kept for a few days for running the game, then deleted automatically.</li>
</ul>

<p>See the <a href="/privacy">privacy policy</a> for more.</p>
`);
}
