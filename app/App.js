import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import ScrayAudioView from './modules/scray-audio/src/ScrayAudioView';

// The whole app is the web page (web/index.html, made by scripts/make-web.js) in a web view the native side
// owns: it adds saving to the phone, local file serving and background audio.
export default function App() {
  return (
    <View style={{ flex: 1, backgroundColor: '#0d0f12' }}>
      <StatusBar style="light" />
      <ScrayAudioView source="index.html" style={{ flex: 1 }} />
    </View>
  );
}
