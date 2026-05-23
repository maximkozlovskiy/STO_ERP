import { Tabs } from 'expo-router';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#2563eb',
        tabBarInactiveTintColor: '#6b7280',
        tabBarStyle: { backgroundColor: '#fff', borderTopColor: '#e5e7eb' },
        headerStyle: { backgroundColor: '#fff' },
        headerTitleStyle: { fontWeight: '600', color: '#111827' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Мої наряди',
          tabBarLabel: 'Наряди',
          tabBarIcon: ({ color }) => <TabIcon label="🔧" color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Профіль',
          tabBarLabel: 'Профіль',
          tabBarIcon: ({ color }) => <TabIcon label="👤" color={color} />,
        }}
      />
    </Tabs>
  );
}

function TabIcon({ label, color }: { label: string; color: string }) {
  const { Text } = require('react-native');
  return <Text style={{ fontSize: 20, color }}>{label}</Text>;
}
