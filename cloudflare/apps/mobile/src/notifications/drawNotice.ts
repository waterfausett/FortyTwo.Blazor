// Draws the Worker's hand over and match over notices on Android, so they carry their Ready up and
// Rematch buttons (push.ts's categories). Android draws a notification Expo sends with a title
// itself, without the app's buttons unless the app is open, so the Worker sends these to a device
// whose app says it can draw them (push.ts's registerDevice) headless instead, with what to show
// in the data (worker: push/send.ts's NoticeToDraw). Every other notice Android draws as before.
//
// The task runs whenever a push reaches the app - open, in the background, or closed, when
// expo-task-manager starts the app's JavaScript without its screens to run it. So it's defined as
// the app's entry (index.ts) loads, ahead of the router. A headless push can still go undelivered
// (a phone in deep sleep, an app force-stopped), as can any push.
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { CHANNEL_ID, DRAW_NOTICE_TASK } from './push';

interface NoticeToDraw {
  url: string;
  title: string;
  body: string;
  categoryId: string;
  tag: string;
}

// The notice in a headless push, if that's what this is: not one Android has drawn (it has a
// notification), and not a button pressed on one, which the task is also run for.
function noticeIn(payload: Notifications.NotificationTaskPayload): NoticeToDraw | null {
  if ('actionIdentifier' in payload || payload.notification != null) return null;
  let notice: Partial<NoticeToDraw>;
  try {
    notice = JSON.parse(payload.data?.dataString ?? '');
  } catch {
    return null;
  }
  const { url, title, body, categoryId, tag } = notice;
  if ([url, title, body, categoryId, tag].some((v) => typeof v !== 'string')) return null;
  return notice as NoticeToDraw;
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(DRAW_NOTICE_TASK, async ({ data }) => {
  const notice = data && noticeIn(data);
  if (notice == null) return;
  await Notifications.scheduleNotificationAsync({
    // Its tag: it takes the place of the match's last notice in the shade, as Android's would.
    identifier: notice.tag,
    content: {
      title: notice.title,
      body: notice.body,
      data: { url: notice.url },
      categoryIdentifier: notice.categoryId,
      // Without a sound it's silent, and Android neither plays the channel's sound nor shows it as
      // a banner.
      sound: 'default',
    },
    trigger: { channelId: CHANNEL_ID },
  });
});

// Registered for good: the OS keeps it across launches.
if (Platform.OS === 'android') void Notifications.registerTaskAsync(DRAW_NOTICE_TASK).catch(() => {});
