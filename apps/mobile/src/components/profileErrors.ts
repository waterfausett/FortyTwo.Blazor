// The Worker's limits (apps/worker/src/requestBody.ts), checked here first so the player sees
// what's wrong before saving.
export const MAX_DISPLAY_NAME_LENGTH = 50;
const MAX_PICTURE_URL_LENGTH = 2048;

export function profileErrors(displayName: string, picture: string): string[] {
  const errors: string[] = [];
  const name = displayName.trim();
  if (name.length === 0) errors.push('Enter a display name.');
  else if (name.length > MAX_DISPLAY_NAME_LENGTH) errors.push(`Keep the display name to ${MAX_DISPLAY_NAME_LENGTH} characters.`);
  const url = picture.trim();
  if (url !== '' && (!/^https:\/\/\S+$/i.test(url) || url.length > MAX_PICTURE_URL_LENGTH)) {
    errors.push('The picture must be an https:// link, or blank for your account picture.');
  }
  return errors;
}
