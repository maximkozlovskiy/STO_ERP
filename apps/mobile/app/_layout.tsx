import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <Stack>
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="work-order/[id]"
          options={{
            title: 'Наряд',
            headerBackTitle: 'Назад',
            headerStyle: { backgroundColor: '#fff' },
            headerTitleStyle: { fontWeight: '600', color: '#111827' },
          }}
        />
        <Stack.Screen name="+not-found" />
      </Stack>
      <StatusBar style="auto" />
    </>
  );
}
