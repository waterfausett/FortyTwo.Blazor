// The app's entry. The task that draws notices with buttons on Android must be defined as the bundle
// loads: expo-task-manager runs it in the app's JavaScript started without its screens, which the
// router only loads once it renders (src/notifications/drawNotice.ts).
import './src/notifications/drawNotice';
import 'expo-router/entry';
