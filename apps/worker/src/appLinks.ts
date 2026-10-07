// Android App Links: the Worker vouches that the Forty-Two app may open its https links (the
// match invites the app shares, https://<worker>/match/<id>), by serving a Digital Asset Links
// statement at /.well-known/assetlinks.json. Android checks it when the app is installed; the
// app's side is the intent filter in apps/mobile/app.config.js.
//
// The statement names the app's signing certificates by their SHA-256 fingerprints, set in
// ANDROID_APP_FINGERPRINTS (comma-separated, as `eas credentials -p android` prints them). With
// none set there's nothing to vouch for, so the file isn't served and links open in the browser.

export const ANDROID_PACKAGE = 'com.waterfausett.fortytwo';

export interface AssetLinkStatement {
  relation: string[];
  target: { namespace: 'android_app'; package_name: string; sha256_cert_fingerprints: string[] };
}

export function assetLinks(fingerprints: string | undefined): AssetLinkStatement[] | null {
  const certs = (fingerprints ?? '')
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter((f) => f !== '');
  if (certs.length === 0) return null;
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: certs },
    },
  ];
}
