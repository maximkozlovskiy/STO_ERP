import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Не знайдено' }} />
      <View style={styles.container}>
        <Text style={styles.title}>Сторінку не знайдено</Text>
        <Link href="/" style={styles.link}>
          Повернутись на головну
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  title: { fontSize: 20, fontWeight: 'bold', marginBottom: 16 },
  link: { color: '#0a7ea4' },
});
