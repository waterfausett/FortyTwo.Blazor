import { Alert } from 'react-native';
import { ApiError } from '@fortytwo/client';

// A rejected action (an illegal play, a stale bid, a seat someone else just took) as an alert.
// The Worker's error detail may hold <code> markup, which an alert can't render.
export function showError(error: unknown): void {
  if (error instanceof ApiError) {
    Alert.alert(error.title, error.detail?.replace(/<[^>]+>/g, ''));
  } else {
    Alert.alert('Something went wrong', error instanceof Error ? error.message : String(error));
  }
}
