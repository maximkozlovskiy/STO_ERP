import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { login } from '../src/lib/auth';

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert('Помилка', 'Введіть email та пароль');
      return;
    }
    setLoading(true);
    try {
      await login(email.trim(), password);
      router.replace('/(tabs)');
    } catch (e: unknown) {
      Alert.alert('Помилка входу', e instanceof Error ? e.message : 'Невірний email або пароль');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        <Text style={styles.logo}>🔧</Text>
        <Text style={styles.title}>STO ERP</Text>
        <Text style={styles.subtitle}>Вхід для механіків</Text>

        <View style={styles.form}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="admin@sto.local"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Пароль</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureTextEntry
          />

          <TouchableOpacity
            style={[styles.loginBtn, loading && styles.loginBtnDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}
          >
            <Text style={styles.loginBtnText}>{loading ? 'Вхід...' : 'Увійти'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  inner: { flex: 1, justifyContent: 'center', padding: 24 },
  logo: { fontSize: 48, textAlign: 'center', marginBottom: 8 },
  title: { fontSize: 28, fontWeight: '700', color: '#111827', textAlign: 'center', marginBottom: 4 },
  subtitle: { fontSize: 15, color: '#6b7280', textAlign: 'center', marginBottom: 32 },
  form: { backgroundColor: '#fff', borderRadius: 16, padding: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 4 },
  label: { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6 },
  input: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#111827', backgroundColor: '#f9fafb', marginBottom: 14 },
  loginBtn: { backgroundColor: '#2563eb', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  loginBtnDisabled: { opacity: 0.6 },
  loginBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
